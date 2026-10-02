//! Live discovery: what is plugged in right now, and who it is.
//!
//! dogd scans the serial ports once a second (listing never writes to a
//! port), turns each into a fingerprint, and hands every plug or unplug to
//! the resolver (identity/mod.rs). A Hardware Dog that answers its HDP hello
//! adds its chip id to the attachment it arrived on. Local, offline: no
//! lookup anywhere.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use crate::device::Port;
use crate::identity::{self, Fingerprint, PlugEvent, Presence, Transport};
use crate::storage::{Observation, Store};

#[derive(Default)]
pub struct Discovery {
    presence: Mutex<Presence>,
    attached: Mutex<BTreeMap<String, Observation>>,
}

/// A listed port as a fingerprint. The topology is read from sysfs on
/// Linux; elsewhere the descriptors (and the serial, if usable) carry it.
pub fn fingerprint(p: &Port) -> Fingerprint {
    let hex = |s: &Option<String>| s.as_deref().and_then(|v| u16::from_str_radix(v, 16).ok());
    let (usb_path, interface) = if p.kind == "USB" {
        identity::usb_topology(Path::new("/sys"), &p.port)
    } else {
        (None, None)
    };
    Fingerprint {
        transport: Some(if p.kind == "USB" {
            Transport::Usb
        } else {
            Transport::Serial
        }),
        vid: hex(&p.vid),
        pid: hex(&p.pid),
        manufacturer: p.manufacturer.clone(),
        product: p.product.clone(),
        serial: p.serial.clone(),
        usb_path,
        interface,
        port: Some(p.port.clone()),
        ..Default::default()
    }
}

impl Discovery {
    /// One scan: plug events resolved and recorded. Returns one line per event.
    pub fn scan(&self, store: &Store, ports: &[Port]) -> Vec<String> {
        let now: Vec<Fingerprint> = ports.iter().map(fingerprint).collect();
        let events = self.presence.lock().unwrap().update(now.clone());
        let mut lines = Vec::new();
        let mut attached = self.attached.lock().unwrap();
        for ev in events {
            match ev {
                PlugEvent::Detached { port, .. } => {
                    let gone = attached.remove(&port);
                    let id = gone.as_ref().and_then(|o| o.id.clone());
                    store.detached(&port, id.as_deref());
                    lines.push(format!("DETACHED  {:<22}{}", port, label(gone.as_ref())));
                }
                PlugEvent::Attached { port, fingerprint } => {
                    let others: Vec<Fingerprint> = now
                        .iter()
                        .filter(|f| f.port.as_deref() != Some(port.as_str()))
                        .cloned()
                        .collect();
                    let present: Vec<String> =
                        attached.values().filter_map(|o| o.id.clone()).collect();
                    let obs = store.observe("ATTACHED", &fingerprint, &others, &present);
                    lines.push(format!("ATTACHED  {:<22}{}", port, label(Some(&obs))));
                    attached.insert(port, obs);
                }
            }
        }
        lines
    }

    /// A Hardware Dog said who it is (HDP hello) on `source` ("serial:PATH"
    /// or "tcp:HOST:PORT"): its chip id joins that attachment.
    pub fn identified(&self, store: &Store, source: &str, chip: &str) -> Option<String> {
        let mut attached = self.attached.lock().unwrap();
        let (port, base) = match source.strip_prefix("serial:") {
            Some(path) => {
                let fp = self
                    .presence
                    .lock()
                    .unwrap()
                    .fingerprints()
                    .into_iter()
                    .find(|f| f.port.as_deref() == Some(path));
                (
                    path.to_string(),
                    fp.unwrap_or(Fingerprint {
                        transport: Some(Transport::Serial),
                        port: Some(path.to_string()),
                        ..Default::default()
                    }),
                )
            }
            None => (
                source.to_string(),
                Fingerprint {
                    transport: Some(Transport::Eth),
                    port: Some(source.to_string()),
                    ..Default::default()
                },
            ),
        };
        if attached
            .get(&port)
            .and_then(|o| o.fingerprint.chip_id.as_deref())
            == Some(chip)
        {
            return None; // already known on this attachment
        }
        let fp = Fingerprint {
            chip_id: Some(chip.to_string()),
            ..base
        };
        let present: Vec<String> = attached
            .iter()
            .filter(|(p, _)| **p != port)
            .filter_map(|(_, o)| o.id.clone())
            .collect();
        let obs = store.observe("IDENTIFIED", &fp, &[], &present);
        let line = format!("IDENTIFIED{:<22}{}", format!(" {port}"), label(Some(&obs)));
        attached.insert(port, obs);
        Some(line)
    }

    /// Everything attached now, resolved.
    pub fn present(&self) -> Vec<Observation> {
        self.attached.lock().unwrap().values().cloned().collect()
    }
}

/// "HW-3F2A91C04B 'bench probe A' EXCELLENT serial ... + 1A86:7523"
pub fn label(o: Option<&Observation>) -> String {
    match o {
        None => "unknown".into(),
        Some(o) => match &o.id {
            None => format!("NO IDENTITY ({})", o.basis),
            Some(id) => {
                let alias = o
                    .alias
                    .as_deref()
                    .map(|a| format!(" '{a}'"))
                    .unwrap_or_default();
                let tag = if !o.ambiguous_with.is_empty() {
                    format!("AMBIGUOUS with {}", o.ambiguous_with.join(" "))
                } else if o.new {
                    "NEW".into()
                } else {
                    "KNOWN".into()
                };
                format!(
                    "{id}{alias} {tag} {} ({})",
                    o.strength.as_deref().unwrap_or(""),
                    o.basis
                )
            }
        },
    }
}
