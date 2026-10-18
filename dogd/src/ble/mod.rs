//! Bluetooth LE discovery for the Bluetooth Lab: what BlueZ reports about
//! the advertisers around this computer, kept in a bounded ring the
//! interface reads (`GET /v1/ble/observations?since=N`).
//!
//! A report is a BlueZ property update (RSSI, names, manufacturer and
//! service data), as BlueZ gives it: not a radio capture, not every packet.
//! Addresses are what BlueZ reports; dogd never merges two of them.
//!
//! Discovery runs only when the interface asks (`PUT /v1/ble/scan start`)
//! and stops when it asks, or when dogd stops. Nothing is sent to any
//! device: discovery listens; dogd connects to nothing.
//!
//! Linux only (BlueZ over the system D-Bus, pure Rust). Elsewhere the
//! status says `unsupported`, and the interface says why.

// The ring, the clock and the hex helpers feed the BlueZ backend: off Linux
// they exist (the API and its tests are the same everywhere) but go unused.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[cfg(target_os = "linux")]
mod bluez;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Reports kept for the interface to read. Older ones fall off, and a
/// reader that was too slow is told how many it missed.
pub const RING: usize = 4096;
/// Reports returned by one read.
pub const PAGE: usize = 1000;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Observation {
    pub seq: u64,
    /// dogd's monotonic clock, ms since it started.
    pub mono_ms: u64,
    /// This computer's wall clock, ms since 1970.
    pub wall_ms: u64,
    pub adapter: String,
    pub address: String,
    /// "public" or "random", as BlueZ reports it.
    pub address_type: Option<String>,
    /// Name from the advertisement (BlueZ `Name`).
    pub name: Option<String>,
    /// The name BlueZ keeps for people (`Alias`): may be a cache or the address.
    pub alias: Option<String>,
    pub rssi: Option<i16>,
    pub tx_power: Option<i16>,
    pub uuids: Vec<String>,
    /// Company id (decimal) -> bytes, hex.
    pub manufacturer: BTreeMap<String, String>,
    /// Service UUID -> bytes, hex.
    pub service_data: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub supported: bool,
    /// unsupported, no_adapter, permission, ready, scanning, error
    pub state: &'static str,
    pub adapter: Option<String>,
    pub detail: String,
}

impl Status {
    pub fn new(state: &'static str, adapter: Option<String>, detail: impl Into<String>) -> Self {
        Status {
            supported: state != "unsupported",
            state,
            adapter,
            detail: detail.into(),
        }
    }
}

#[derive(Default)]
pub struct Ring {
    buf: VecDeque<Observation>,
    next: u64,
}

pub struct Page {
    pub observations: Vec<Observation>,
    /// The `since` to ask next.
    pub next: u64,
    /// Reports after `since` that fell off the ring before this read.
    pub lost: u64,
}

impl Ring {
    pub fn push(&mut self, mut o: Observation) {
        self.next += 1;
        o.seq = self.next;
        if self.buf.len() == RING {
            self.buf.pop_front();
        }
        self.buf.push_back(o);
    }

    /// Reports after `since`, oldest first. `since` past the end (a new
    /// reader) gets nothing, and the point to read from.
    pub fn since(&self, since: u64) -> Page {
        if since >= self.next {
            return Page {
                observations: vec![],
                next: self.next,
                lost: 0,
            };
        }
        let first = self.buf.front().map_or(self.next + 1, |o| o.seq);
        let lost = first.saturating_sub(since + 1);
        let observations: Vec<Observation> = self
            .buf
            .iter()
            .filter(|o| o.seq > since)
            .take(PAGE)
            .cloned()
            .collect();
        let next = observations.last().map_or(self.next, |o| o.seq);
        Page {
            observations,
            next,
            lost,
        }
    }
}

pub struct BleScanner {
    ring: Mutex<Ring>,
    status: Mutex<Status>,
    probed: Mutex<Option<Instant>>,
    epoch: Instant,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// The discovery task, kept so that a new start waits for the last one
    /// to have called StopDiscovery and said so.
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl BleScanner {
    pub fn new() -> Arc<Self> {
        let initial = if cfg!(target_os = "linux") {
            Status::new("ready", None, "not checked yet")
        } else {
            Status::new(
                "unsupported",
                None,
                "dogd scans Bluetooth on Linux (BlueZ) only for now",
            )
        };
        Arc::new(BleScanner {
            ring: Mutex::new(Ring::default()),
            status: Mutex::new(initial),
            probed: Mutex::new(None),
            epoch: Instant::now(),
            stop: Mutex::new(None),
            task: Mutex::new(None),
        })
    }

    pub fn mono_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    pub fn set_status(&self, s: Status) {
        *self.status.lock().unwrap() = s;
    }

    pub fn push(&self, mut o: Observation) {
        o.mono_ms = self.mono_ms();
        o.wall_ms = wall_ms();
        self.ring.lock().unwrap().push(o);
    }

    pub fn since(&self, since: u64) -> Page {
        self.ring.lock().unwrap().since(since)
    }

    fn scanning(&self) -> bool {
        self.stop.lock().unwrap().is_some()
    }

    /// The status, checked against the system when idle (at most every 5 s).
    pub async fn status(&self) -> Status {
        #[cfg(target_os = "linux")]
        if !self.scanning() {
            let stale = self
                .probed
                .lock()
                .unwrap()
                .is_none_or(|t| t.elapsed() > Duration::from_secs(5));
            if stale {
                let s = tokio::time::timeout(Duration::from_secs(3), bluez::probe())
                    .await
                    .unwrap_or_else(|_| Status::new("error", None, "BlueZ did not answer in 3 s"));
                *self.probed.lock().unwrap() = Some(Instant::now());
                self.set_status(s);
            }
        }
        self.status.lock().unwrap().clone()
    }

    /// Start discovery. A start while scanning starts nothing new.
    pub async fn start(self: &Arc<Self>) -> Status {
        #[cfg(target_os = "linux")]
        {
            if self.scanning() {
                return self.status.lock().unwrap().clone();
            }
            // A stop that gave up waiting leaves the last task finishing:
            // let it end first, or its last word ("ready") and its clean-up
            // would land on this scan.
            let last = self.task.lock().unwrap().take();
            if let Some(last) = last {
                let _ = tokio::time::timeout(Duration::from_secs(5), last).await;
            }
            if self.scanning() {
                return self.status.lock().unwrap().clone();
            }
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            *self.stop.lock().unwrap() = Some(stop_tx);
            let me = self.clone();
            let task = tokio::spawn(async move {
                bluez::run(me.clone(), stop_rx, ready_tx).await;
                me.stop.lock().unwrap().take();
            });
            *self.task.lock().unwrap() = Some(task);
            let s = match tokio::time::timeout(Duration::from_secs(5), ready_rx).await {
                Ok(Ok(s)) => s,
                _ => Status::new("error", None, "BlueZ did not start discovery in 5 s"),
            };
            if s.state != "scanning" {
                self.stop.lock().unwrap().take();
            }
            self.set_status(s.clone());
            *self.probed.lock().unwrap() = Some(Instant::now());
            s
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.status.lock().unwrap().clone()
        }
    }

    /// Stop discovery. Reports already read stay readable.
    pub async fn stop(&self) -> Status {
        let tx = self.stop.lock().unwrap().take();
        if let Some(tx) = tx {
            let _ = tx.send(());
            // Let the backend call StopDiscovery and say so.
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if self.status.lock().unwrap().state != "scanning" {
                    break;
                }
            }
        }
        self.status.lock().unwrap().clone()
    }
}

/// Bytes as lower-case hex, the wire form of payloads.
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(addr: &str) -> Observation {
        Observation {
            address: addr.into(),
            ..Default::default()
        }
    }

    #[test]
    fn ring_reads_in_order_and_says_what_fell_off() {
        let mut r = Ring::default();
        for i in 0..10 {
            r.push(obs(&format!("A{i}")));
        }
        let p = r.since(0);
        assert_eq!(p.observations.len(), 10);
        assert_eq!(p.next, 10);
        assert_eq!(p.lost, 0);
        assert!(r.since(10).observations.is_empty());
        // A new reader starts at the end, without the past.
        let fresh = r.since(u64::MAX);
        assert!(fresh.observations.is_empty());
        assert_eq!(fresh.next, 10);

        for i in 0..RING {
            r.push(obs(&format!("B{i}")));
        }
        let late = r.since(5);
        assert_eq!(late.lost, (10 + RING as u64) - RING as u64 - 5);
        assert_eq!(late.observations.len(), PAGE);
        assert_eq!(late.observations[0].seq, 11);
    }

    #[test]
    fn status_says_unsupported_off_linux() {
        let s = BleScanner::new();
        let st = s.status.lock().unwrap().clone();
        if cfg!(target_os = "linux") {
            assert!(st.supported);
        } else {
            assert_eq!(st.state, "unsupported");
            assert!(!st.supported);
        }
    }

    #[test]
    fn hex_is_lower_case_pairs() {
        assert_eq!(hex(&[0x02, 0x15, 0xff]), "0215ff");
    }
}
