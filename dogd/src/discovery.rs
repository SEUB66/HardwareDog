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
use crate::protocol::Hello;
use crate::storage::{Observation, Store};

#[derive(Default)]
pub struct Discovery {
    presence: Mutex<Presence>,
    attached: Mutex<BTreeMap<String, Observation>>,
}

/// A listed port as a fingerprint. The USB topology comes from sysfs on
/// Linux, from the OS listing elsewhere (Windows location path, macOS
/// location id); without it, descriptors and a trusted serial carry it.
pub fn fingerprint(p: &Port) -> Fingerprint {
    let hex = |s: &Option<String>| s.as_deref().and_then(|v| u16::from_str_radix(v, 16).ok());
    let (usb_path, interface) = if p.kind == "USB" {
        match identity::usb_topology(Path::new("/sys"), &p.port) {
            (None, None) => (p.location.clone(), p.interface.clone()),
            found => found,
        }
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

/// What an attachment is when its identity could not be written: no id,
/// and the reason. Never shown as remembered.
fn not_stored(fp: &Fingerprint, e: &str) -> Observation {
    Observation {
        port: fp.port.clone().unwrap_or_default(),
        id: None,
        alias: None,
        strength: None,
        basis: format!("IDENTITY NOT STORED: {e}"),
        new: false,
        ambiguous_with: vec![],
        hint: None,
        fingerprint: fp.clone(),
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
                    let lost = match store.detached(&port, id.as_deref()) {
                        Ok(()) => String::new(),
                        Err(e) => format!(" (EVENT NOT STORED: {e})"),
                    };
                    lines.push(format!(
                        "DETACHED  {:<22}{}{lost}",
                        port,
                        label(gone.as_ref())
                    ));
                }
                PlugEvent::Attached { port, fingerprint } => {
                    let others = others(&now, &port);
                    let present: Vec<String> =
                        attached.values().filter_map(|o| o.id.clone()).collect();
                    let obs = store
                        .observe("ATTACHED", &fingerprint, &others, &present, None)
                        .unwrap_or_else(|e| not_stored(&fingerprint, &e));
                    lines.push(format!("ATTACHED  {:<22}{}", port, label(Some(&obs))));
                    attached.insert(port, obs);
                }
            }
        }
        lines
    }

    /// A Hardware Dog said who it is (HDP hello) on `source` ("serial:PATH"
    /// or "tcp:HOST:PORT"): its chip id (and legacy HDP id) join that
    /// attachment.
    pub fn identified(&self, store: &Store, source: &str, hello: &Hello) -> Option<String> {
        let mut attached = self.attached.lock().unwrap();
        let listed = self.presence.lock().unwrap().fingerprints();
        let (port, base) = match source.strip_prefix("serial:") {
            Some(path) => (
                path.to_string(),
                listed
                    .iter()
                    .find(|f| f.port.as_deref() == Some(path))
                    .cloned()
                    .unwrap_or(Fingerprint {
                        transport: Some(Transport::Serial),
                        port: Some(path.to_string()),
                        ..Default::default()
                    }),
            ),
            None => (
                source.to_string(),
                Fingerprint {
                    transport: Some(Transport::Eth),
                    port: Some(source.to_string()),
                    ..Default::default()
                },
            ),
        };
        let fp = Fingerprint {
            chip_id: hello.chip.clone(),
            legacy_id: Some(hello.device.clone()),
            ..base
        };
        if let Some(o) = attached.get(&port) {
            if o.id.is_some()
                && o.fingerprint.chip_id == fp.chip_id
                && o.fingerprint.legacy_id == fp.legacy_id
            {
                return None; // already said on this attachment
            }
        }
        let present: Vec<String> = attached
            .iter()
            .filter(|(p, _)| **p != port)
            .filter_map(|(_, o)| o.id.clone())
            .collect();
        // Only the identity this attachment created may take the chip id.
        let adopt = attached
            .get(&port)
            .filter(|o| o.new)
            .and_then(|o| o.id.clone());
        let obs = store
            .observe(
                "IDENTIFIED",
                &fp,
                &others(&listed, &port),
                &present,
                adopt.as_deref(),
            )
            .unwrap_or_else(|e| not_stored(&fp, &e));
        let line = format!("IDENTIFIED{:<22}{}", format!(" {port}"), label(Some(&obs)));
        attached.insert(port, obs);
        Some(line)
    }

    /// The user says the device attached on `port` is `target`.
    pub fn bind(&self, store: &Store, port: &str, target: &str) -> Result<Observation, String> {
        let mut attached = self.attached.lock().unwrap();
        let Some(o) = attached.get(port) else {
            return Err(format!("nothing attached on {port}"));
        };
        let listed = self.presence.lock().unwrap().fingerprints();
        let present: Vec<String> = attached
            .iter()
            .filter(|(p, _)| p.as_str() != port)
            .filter_map(|(_, o)| o.id.clone())
            .collect();
        let obs = store.bind(
            &o.fingerprint,
            &others(&listed, port),
            &present,
            o.id.as_deref(),
            target,
        )?;
        attached.insert(port.to_string(), obs.clone());
        Ok(obs)
    }

    /// Everything attached now, resolved.
    pub fn present(&self) -> Vec<Observation> {
        self.attached.lock().unwrap().values().cloned().collect()
    }
}

fn others(all: &[Fingerprint], port: &str) -> Vec<Fingerprint> {
    all.iter()
        .filter(|f| f.port.as_deref() != Some(port))
        .cloned()
        .collect()
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
                } else if let Some(h) = &o.hint {
                    format!("NEW (not merged with {h})")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn com(port: &str, location: &str) -> Port {
        Port {
            port: port.into(),
            kind: "USB",
            vid: Some("1A86".into()),
            pid: Some("7523".into()),
            manufacturer: Some("wch.cn".into()),
            product: Some("USB-SERIAL CH340".into()),
            serial: None,
            location: Some(location.into()),
            interface: Some("if 0".into()),
        }
    }

    /// Windows: two identical CH340 without serial, told apart by their
    /// location path, and found again by it under another COM number.
    #[test]
    fn the_os_location_path_tells_identical_dongles_apart() {
        let a = fingerprint(&com("COM7", "PCIROOT(0)#PCI(1400)#USBROOT(0)-2.3"));
        let b = fingerprint(&com("COM8", "PCIROOT(0)#PCI(1400)#USBROOT(0)-2.4"));
        assert_eq!(
            a.usb_path.as_deref(),
            Some("PCIROOT(0)#PCI(1400)#USBROOT(0)-2.3")
        );
        assert_eq!(a.interface.as_deref(), Some("if 0"));
        assert_ne!(
            identity::identity_key(&a, &None),
            identity::identity_key(&b, &None)
        );
        let known = |id: &str, fp: &Fingerprint| identity::Known {
            id: id.into(),
            vid: fp.vid,
            pid: fp.pid,
            manufacturer: fp.manufacturer.clone(),
            product: fp.product.clone(),
            usb_path: fp.usb_path.clone(),
            interface: fp.interface.clone(),
            ..Default::default()
        };
        let all = [known("HW-A", &a), known("HW-B", &b)];
        let again = fingerprint(&com("COM12", "PCIROOT(0)#PCI(1400)#USBROOT(0)-2.3"));
        assert!(matches!(
            identity::resolve(&again, &None, &all, &[]),
            identity::Resolution::Known { id, .. } if id == "HW-A"
        ));
    }
}
