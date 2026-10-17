//! Camera Sniffer, the network part: what the devices on the local network
//! say about themselves, asked politely and in bounds.
//!
//! A scan targets ONE interface the person picked, on a private network
//! this computer is on, and only when the interface asks
//! (`PUT /v1/lan/scan`). It never sweeps the subnet and never runs a port
//! scan. In order:
//!
//!   1. neighbors   the kernel's neighbor table (nothing sent)
//!   2. mdns        one DNS-SD question to the segment, then the types heard
//!   3. ssdp        one M-SEARCH, then the device descriptions it pointed at
//!   4. wsd         one ONVIF WS-Discovery Probe
//!   5. services    on hosts seen in steps 1-4 only: TCP connect to a short
//!      list of ports (web interfaces, RTSP), and an RTSP OPTIONS where RTSP
//!      answers. No password is tried, no stream is described (no DESCRIBE)
//!      nor opened.
//!
//! Every step has a deadline, connections are capped, and a stop aborts
//! the scan at once. What was observed stays readable, each record with
//! the method that produced it and the raw answer (clipped).
//!
//! What a scan cannot see is said, not hidden: a camera that records to a
//! card without a network, a device on another network (guest Wi-Fi
//! isolation), a device that does not answer. No answer excludes nothing.
//!
//! Linux only for now (iproute2 for interfaces, /proc for neighbors);
//! elsewhere the status says `unsupported`.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub mod parse;
mod scan;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub use parse::{Iface, Oui};

/// Records kept for the interface to read.
pub const RING: usize = 8192;
/// Records returned by one read.
pub const PAGE: usize = 1000;

/// The methods a scan may use, in the order they run.
pub const METHODS: [&str; 5] = ["neighbors", "mdns", "ssdp", "wsd", "services"];

/// Ports checked on hosts that showed themselves, and why:
/// 554 RTSP (IANA), 8554 a common alternate RTSP port, 80 / 8080 / 8000 /
/// 443 web interfaces (where ONVIF device services also live).
pub const SERVICE_PORTS: [(u16, &str); 6] = [
    (554, "rtsp"),
    (8554, "rtsp"),
    (80, "http"),
    (8080, "http"),
    (8000, "http"),
    (443, "https"),
];

/// Hosts checked at most in one scan.
pub const MAX_HOSTS: usize = 256;
/// Connections open at once.
pub const CONCURRENCY: usize = 16;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Observation {
    pub seq: u64,
    /// The scan it belongs to (1, 2...).
    pub scan: u64,
    pub mono_ms: u64,
    pub wall_ms: u64,
    /// neighbor, mdns, ssdp, upnp, wsd, service, note
    pub kind: String,
    /// The method that produced it (one of METHODS).
    pub method: String,
    pub iface: String,
    pub ip: Option<String>,
    pub mac: Option<String>,
    /// The registered owner of the MAC prefix: an origin, not an identification.
    pub vendor: Option<String>,
    /// Where the vendor came from (the system's OUI file).
    pub vendor_source: Option<String>,
    /// A name the device announced (mDNS instance, UPnP friendlyName, ONVIF name scope).
    pub name: Option<String>,
    /// The service this record is about ("rtsp", "_rtsp._tcp.local", a UPnP device type...).
    pub service: Option<String>,
    pub port: Option<u16>,
    /// What else was read, by name (TXT attributes, scopes, model...).
    pub fields: BTreeMap<String, String>,
    /// The answer as received (text, clipped to parse::RAW_MAX).
    pub raw: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub supported: bool,
    /// unsupported, idle, scanning, done, cancelled, error
    pub state: &'static str,
    pub detail: String,
    pub scan: u64,
    pub iface: Option<String>,
    pub methods: Vec<String>,
    /// The step running now.
    pub step: Option<String>,
    /// Service checks done / to do (known only once hosts are listed).
    pub done: u64,
    pub total: Option<u64>,
    pub started_wall_ms: Option<u64>,
    pub finished_wall_ms: Option<u64>,
    /// The OUI file read for manufacturers, when the system has one.
    pub oui_source: Option<String>,
}

impl Status {
    fn new(state: &'static str, detail: impl Into<String>) -> Self {
        Status {
            supported: state != "unsupported",
            state,
            detail: detail.into(),
            scan: 0,
            iface: None,
            methods: vec![],
            step: None,
            done: 0,
            total: None,
            started_wall_ms: None,
            finished_wall_ms: None,
            oui_source: None,
        }
    }
}

/// `PUT /v1/lan/scan`
#[derive(Debug, Deserialize)]
pub struct Request {
    pub action: String,
    pub iface: Option<String>,
    pub methods: Option<Vec<String>>,
}

#[derive(Default)]
struct Ring {
    buf: VecDeque<Observation>,
    next: u64,
}

pub struct Page {
    pub observations: Vec<Observation>,
    pub next: u64,
    pub lost: u64,
}

impl Ring {
    fn push(&mut self, mut o: Observation) {
        self.next += 1;
        o.seq = self.next;
        if self.buf.len() == RING {
            self.buf.pop_front();
        }
        self.buf.push_back(o);
    }

    fn since(&self, since: u64) -> Page {
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

pub struct LanScanner {
    ring: Mutex<Ring>,
    status: Mutex<Status>,
    epoch: Instant,
    job: Mutex<Option<tokio::task::JoinHandle<()>>>,
    oui: OnceLock<Oui>,
}

impl LanScanner {
    pub fn new() -> Arc<Self> {
        let initial = if cfg!(target_os = "linux") {
            Status::new("idle", "no scan yet")
        } else {
            Status::new(
                "unsupported",
                "dogd discovers the local network on Linux only for now",
            )
        };
        Arc::new(LanScanner {
            ring: Mutex::new(Ring::default()),
            status: Mutex::new(initial),
            epoch: Instant::now(),
            job: Mutex::new(None),
            oui: OnceLock::new(),
        })
    }

    pub fn mono_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    pub fn status(&self) -> Status {
        let mut s = self.status.lock().unwrap().clone();
        s.oui_source = self.oui().source.clone();
        s
    }

    fn update(&self, f: impl FnOnce(&mut Status)) {
        f(&mut self.status.lock().unwrap());
    }

    pub fn push(&self, mut o: Observation) {
        o.mono_ms = self.mono_ms();
        o.wall_ms = crate::ble::wall_ms();
        o.scan = self.status.lock().unwrap().scan;
        self.ring.lock().unwrap().push(o);
    }

    pub fn since(&self, since: u64) -> Page {
        self.ring.lock().unwrap().since(since)
    }

    /// The manufacturer registry, read once from the first file the system has.
    pub fn oui(&self) -> &Oui {
        self.oui.get_or_init(|| {
            let mut paths: Vec<std::path::PathBuf> = std::env::var_os("HWDOG_OUI")
                .map(Into::into)
                .into_iter()
                .collect();
            paths.extend(
                [
                    "/usr/share/ieee-data/oui.txt",
                    "/var/lib/ieee-data/oui.txt",
                    "/usr/share/misc/oui.txt",
                    "/usr/share/arp-scan/ieee-oui.txt",
                    "/usr/share/nmap/nmap-mac-prefixes",
                ]
                .map(Into::into),
            );
            for p in paths {
                // a registry file is a few MB; refuse anything absurd
                if std::fs::metadata(&p).is_ok_and(|m| m.len() < 32 << 20) {
                    if let Ok(text) = std::fs::read_to_string(&p) {
                        let oui = Oui::parse(&text, &p.to_string_lossy());
                        if oui.len() > 0 {
                            return oui;
                        }
                    }
                }
            }
            Oui::default()
        })
    }

    /// The IPv4 interfaces of this computer, each with why a scan of it
    /// would be refused (None: it may be scanned).
    pub async fn interfaces(&self) -> Option<Vec<(Iface, Option<&'static str>)>> {
        let list = scan::interfaces().await?;
        Some(
            list.into_iter()
                .map(|i| {
                    let r = parse::refuse(&i);
                    (i, r)
                })
                .collect(),
        )
    }

    fn scanning(&self) -> bool {
        self.job
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|j| !j.is_finished())
    }

    /// Start a scan of one interface. Refused (and said why) when another
    /// runs, when the interface is unknown, or not a private network.
    pub async fn start(
        self: &Arc<Self>,
        iface: &str,
        methods: &[String],
    ) -> Result<Status, String> {
        if !cfg!(target_os = "linux") {
            return Err(self.status().detail);
        }
        if self.scanning() {
            return Err("a scan is already running: stop it first".into());
        }
        let methods: Vec<String> = METHODS
            .iter()
            .filter(|m| methods.iter().any(|x| x == *m))
            .map(|m| m.to_string())
            .collect();
        if methods.is_empty() {
            return Err(format!("no method chosen (one of: {})", METHODS.join(", ")));
        }
        let Some(list) = scan::interfaces().await else {
            return Err("could not list the interfaces (iproute2 `ip` missing?)".into());
        };
        let Some(chosen) = list
            .into_iter()
            .find(|i| i.name == iface && parse::refuse(i).is_none())
            .or(None)
        else {
            return Err(format!(
                "{iface}: no usable private IPv4 network on this interface"
            ));
        };
        self.update(|s| {
            s.state = "scanning";
            s.detail = format!("{} {}/{}", chosen.name, chosen.network(), chosen.prefix);
            s.scan += 1;
            s.iface = Some(chosen.name.clone());
            s.methods = methods.clone();
            s.step = None;
            s.done = 0;
            s.total = None;
            s.started_wall_ms = Some(crate::ble::wall_ms());
            s.finished_wall_ms = None;
        });
        let me = self.clone();
        let handle = tokio::spawn(async move {
            let outcome = scan::run(me.clone(), chosen, methods).await;
            me.update(|s| {
                s.step = None;
                s.finished_wall_ms = Some(crate::ble::wall_ms());
                match outcome {
                    Ok(summary) => {
                        s.state = "done";
                        s.detail = summary;
                    }
                    Err(e) => {
                        s.state = "error";
                        s.detail = e;
                    }
                }
            });
        });
        *self.job.lock().unwrap() = Some(handle);
        Ok(self.status())
    }

    /// Stop the scan now. What it observed stays readable.
    pub fn stop(&self) -> Status {
        if let Some(job) = self.job.lock().unwrap().take() {
            if !job.is_finished() {
                job.abort();
                self.update(|s| {
                    s.state = "cancelled";
                    s.detail = "stopped on request: what was observed is kept".into();
                    s.step = None;
                    s.finished_wall_ms = Some(crate::ble::wall_ms());
                });
            }
        }
        self.status()
    }
}
