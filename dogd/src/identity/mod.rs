//! Hardware identity: what is plugged in, and is it the same thing as last
//! time. Local and deterministic: no database of serial numbers, no cloud.
//!
//! A device is described by a fingerprint (every signal we can read) and
//! recognised by a fixed ladder of keys, strongest first:
//!
//! ```text
//! 1  chip id / MAC address          EXCELLENT  unique by construction
//! 2  serial number + VID:PID        EXCELLENT  only when the serial is usable
//! 3  VID:PID + USB topology path    GOOD       the same physical port
//! 4  descriptors + interface        MEDIUM     same kind of device, once
//! -  a port name (COM3, ttyACM0)    NEVER      an identity
//! ```
//!
//! A serial is not trusted blindly: cheap devices have none, share a fake
//! one, or repeat one digit. Two identical dongles without a serial are
//! told apart by their USB path ("already seen on this port"); when that is
//! not enough the answer is AMBIGUOUS, never a guess, and the user can give
//! the device an alias once.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

/// How a device is reached. Wi-Fi and I2C are part of the model for the
/// devices a Hardware Dog itself sees; dogd's own discovery is USB / serial,
/// and a Hardware Dog over TCP is ETH.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
#[allow(dead_code)]
pub enum Transport {
    Usb,
    Serial,
    Eth,
    Wifi,
    I2c,
}

/// Every signal read from one attachment. `port` is where it was seen,
/// for display: it is never used to recognise the device.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Fingerprint {
    pub transport: Option<Transport>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
    /// USB topology, e.g. "1-2.3": the physical port chain, stable across
    /// replugs into the same socket, independent of the COM / tty number.
    pub usb_path: Option<String>,
    /// Interface signature, e.g. "1.0 class 02".
    pub interface: Option<String>,
    pub mac: Option<String>,
    pub chip_id: Option<String>,
    pub port: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Strength {
    Medium,
    Good,
    Excellent,
}

impl Strength {
    pub fn as_str(self) -> &'static str {
        match self {
            Strength::Excellent => "EXCELLENT",
            Strength::Good => "GOOD",
            Strength::Medium => "MEDIUM",
        }
    }
}

/// A device already known: its latest attributes.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Known {
    pub id: String,
    pub alias: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
    pub usb_path: Option<String>,
    pub interface: Option<String>,
    pub mac: Option<String>,
    pub chip_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "UPPERCASE")]
pub enum Resolution {
    /// The same device as before.
    Known {
        id: String,
        strength: Strength,
        basis: String,
    },
    /// Never seen: a new identity, as strong as its best key.
    New { strength: Strength, basis: String },
    /// Looks like several known devices: not chosen, said.
    Ambiguous {
        candidates: Vec<String>,
        basis: String,
    },
    /// Nothing but a port name: no identity at all.
    Unidentified { basis: String },
}

fn norm(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
}

fn hex4(v: u16) -> String {
    format!("{v:04X}")
}

/// A serial worth trusting: present, not trivially fake, and not shared by
/// another device of the same VID:PID plugged in right now.
pub fn usable_serial(fp: &Fingerprint, present: &[Fingerprint]) -> Option<String> {
    let s = norm(&fp.serial)?;
    let distinct: std::collections::BTreeSet<char> = s.chars().collect();
    if s.len() < 4 || distinct.len() < 2 {
        return None; // "0", "0000", "aaaaaaaa": the same on every unit
    }
    if s == "123456789" || s == "0123456789" || s == "123456789abcdef" {
        return None;
    }
    let shared = present.iter().any(|o| {
        o.port != fp.port
            && o.vid == fp.vid
            && o.pid == fp.pid
            && norm(&o.serial).as_deref() == Some(&s)
    });
    if shared {
        return None;
    }
    Some(s)
}

/// Two descriptions that cannot be the same device: different chip ids or
/// MACs, or different usable serials on the same VID:PID.
fn conflicts(fp: &Fingerprint, serial: &Option<String>, k: &Known) -> bool {
    let differ = |a: &Option<String>, b: &Option<String>| matches!((norm(a), norm(b)), (Some(x), Some(y)) if x != y);
    if differ(&fp.chip_id, &k.chip_id) || differ(&fp.mac, &k.mac) {
        return true;
    }
    if fp.vid == k.vid && fp.pid == k.pid {
        if let (Some(s), Some(ks)) = (serial, norm(&k.serial)) {
            return *s != ks;
        }
    }
    false
}

fn descriptor_key(
    vid: u16,
    pid: u16,
    manufacturer: &Option<String>,
    product: &Option<String>,
    interface: &Option<String>,
) -> String {
    format!(
        "{}:{}|{}|{}|{}",
        hex4(vid),
        hex4(pid),
        norm(manufacturer).unwrap_or_default(),
        norm(product).unwrap_or_default(),
        norm(interface).unwrap_or_default()
    )
}

/// Recognise a fingerprint among the known devices. Deterministic: the same
/// inputs give the same answer. `present` are the ids attached right now
/// on other ports: a device cannot be plugged in twice.
pub fn resolve(
    fp: &Fingerprint,
    serial: &Option<String>,
    known: &[Known],
    present: &[String],
) -> Resolution {
    let fair: Vec<&Known> = known.iter().filter(|k| !conflicts(fp, serial, k)).collect();

    // 1. chip id / MAC: unique by construction.
    if let Some(c) = norm(&fp.chip_id) {
        if let Some(k) = fair
            .iter()
            .find(|k| norm(&k.chip_id).as_deref() == Some(c.as_str()))
        {
            return Resolution::Known {
                id: k.id.clone(),
                strength: Strength::Excellent,
                basis: format!("chip id {c}"),
            };
        }
    }
    if let Some(m) = norm(&fp.mac) {
        if let Some(k) = fair
            .iter()
            .find(|k| norm(&k.mac).as_deref() == Some(m.as_str()))
        {
            return Resolution::Known {
                id: k.id.clone(),
                strength: Strength::Excellent,
                basis: format!("MAC address {m}"),
            };
        }
    }
    // A chip id never seen: maybe a device known by a weaker key that now
    // says who it is (the record gains it), else a new, excellent identity.
    let strong = norm(&fp.chip_id)
        .map(|c| format!("chip id {c}"))
        .or_else(|| norm(&fp.mac).map(|m| format!("MAC address {m}")));
    let weaker = resolve_usb(fp, serial, &fair, present);
    match (weaker, strong) {
        (
            Resolution::New { .. } | Resolution::Unidentified { .. } | Resolution::Ambiguous { .. },
            Some(basis),
        ) => Resolution::New {
            strength: Strength::Excellent,
            basis,
        },
        (r, _) => r,
    }
}

/// Steps 2 to 4: what USB says, for a device without a known chip id.
fn resolve_usb(
    fp: &Fingerprint,
    serial: &Option<String>,
    fair: &[&Known],
    present: &[String],
) -> Resolution {
    let (Some(vid), Some(pid)) = (fp.vid, fp.pid) else {
        return Resolution::Unidentified {
            basis: "no chip id, MAC or USB descriptor: a port name is not an identity".into(),
        };
    };
    let usb = format!("{}:{}", hex4(vid), hex4(pid));
    let same_kind = |k: &&&Known| k.vid == Some(vid) && k.pid == Some(pid);

    // 2. a usable serial on this VID:PID.
    if let Some(s) = serial {
        if let Some(k) = fair
            .iter()
            .filter(same_kind)
            .find(|k| norm(&k.serial).as_deref() == Some(s.as_str()))
        {
            return Resolution::Known {
                id: k.id.clone(),
                strength: Strength::Excellent,
                basis: format!("serial {s} + {usb}"),
            };
        }
        return Resolution::New {
            strength: Strength::Excellent,
            basis: format!("serial {s} + {usb}"),
        };
    }

    // From here the device has no usable serial: one that is attached
    // elsewhere right now cannot be this one.
    let free: Vec<&&Known> = fair
        .iter()
        .filter(same_kind)
        .filter(|k| !present.contains(&k.id))
        .collect();

    // 3. the same physical USB port.
    if let Some(path) = norm(&fp.usb_path) {
        if let Some(k) = free
            .iter()
            .find(|k| norm(&k.usb_path).as_deref() == Some(path.as_str()))
        {
            return Resolution::Known {
                id: k.id.clone(),
                strength: Strength::Good,
                basis: format!("{usb} already seen on USB port {path}"),
            };
        }
    }

    // 4. same descriptors and interface, on another port: only if unique.
    let key = descriptor_key(vid, pid, &fp.manufacturer, &fp.product, &fp.interface);
    let alike: Vec<&&&Known> = free
        .iter()
        .filter(|k| descriptor_key(vid, pid, &k.manufacturer, &k.product, &k.interface) == key)
        .collect();
    match alike.len() {
        0 => match norm(&fp.usb_path) {
            Some(path) => Resolution::New {
                strength: Strength::Good,
                basis: format!("{usb} on USB port {path}, no usable serial"),
            },
            None => Resolution::New {
                strength: Strength::Medium,
                basis: format!("{usb} descriptors only, no serial, no USB path"),
            },
        },
        1 => Resolution::Known {
            id: alike[0].id.clone(),
            strength: Strength::Medium,
            basis: format!("same {usb} descriptors, moved to another port"),
        },
        _ => Resolution::Ambiguous {
            candidates: alike.iter().map(|k| k.id.clone()).collect(),
            basis: format!(
                "{} identical {usb} devices without serial: give this one an alias",
                alike.len()
            ),
        },
    }
}

/// The key a new identity is named after: the same device always gets the
/// same id, on any machine, without a registry.
pub fn identity_key(fp: &Fingerprint, serial: &Option<String>) -> String {
    if let Some(c) = norm(&fp.chip_id) {
        return format!("chip:{c}");
    }
    if let Some(m) = norm(&fp.mac) {
        return format!("mac:{m}");
    }
    let usb = match (fp.vid, fp.pid) {
        (Some(v), Some(p)) => format!("{}:{}", hex4(v), hex4(p)),
        _ => "none".into(),
    };
    if let Some(s) = serial {
        return format!("usb:{usb}:sn:{s}");
    }
    if let Some(p) = norm(&fp.usb_path) {
        return format!("usb:{usb}:path:{p}");
    }
    format!(
        "usb:{usb}:desc:{}",
        descriptor_key(
            fp.vid.unwrap_or(0),
            fp.pid.unwrap_or(0),
            &fp.manufacturer,
            &fp.product,
            &fp.interface
        )
    )
}

pub fn identity_id(key: &str) -> String {
    let h = Sha256::digest(key.as_bytes());
    let hex: String = h.iter().take(5).map(|b| format!("{b:02x}")).collect();
    format!("HW-{}", hex.to_ascii_uppercase())
}

// ------------------------------------------------------------------ topology

/// USB topology of a tty on Linux: "/dev/ttyACM0" -> ("1-2.3", "1.0 class 02").
/// `sys` is the sysfs root ("/sys"), a parameter so it can be tested. On
/// other systems, or for a port that is not USB, nothing is known.
pub fn usb_topology(sys: &Path, port: &str) -> (Option<String>, Option<String>) {
    let Some(name) = port.strip_prefix("/dev/") else {
        return (None, None);
    };
    let link = sys.join("class/tty").join(name).join("device");
    let Ok(real) = std::fs::canonicalize(&link) else {
        return (None, None);
    };
    // The USB interface directory is named like "1-2.3:1.0".
    let mut iface_dir = None;
    for anc in real.ancestors() {
        let Some(n) = anc.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some((path, ifc)) = n.split_once(':') {
            let ok_path = path.split_once('-').is_some_and(|(bus, chain)| {
                !bus.is_empty()
                    && bus.chars().all(|c| c.is_ascii_digit())
                    && chain.chars().all(|c| c.is_ascii_digit() || c == '.')
            });
            let ok_ifc = ifc.split_once('.').is_some_and(|(a, b)| {
                !a.is_empty()
                    && !b.is_empty()
                    && a.chars().all(|c| c.is_ascii_digit())
                    && b.chars().all(|c| c.is_ascii_digit())
            });
            if ok_path && ok_ifc {
                iface_dir = Some((anc.to_path_buf(), path.to_string(), ifc.to_string()));
                break;
            }
        }
    }
    let Some((dir, path, ifc)) = iface_dir else {
        return (None, None);
    };
    let class = std::fs::read_to_string(dir.join("bInterfaceClass"))
        .ok()
        .map(|c| c.trim().to_string());
    let interface = match class {
        Some(c) if !c.is_empty() => format!("{ifc} class {c}"),
        _ => ifc,
    };
    (Some(path), Some(interface))
}

// ------------------------------------------------------------------ hot-plug

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum PlugEvent {
    Attached {
        port: String,
        fingerprint: Fingerprint,
    },
    Detached {
        port: String,
        fingerprint: Fingerprint,
    },
}

/// What is plugged in now, by port. A port whose device changed (same COM
/// number, another device) is a detach then an attach, never "the same".
#[derive(Default)]
pub struct Presence {
    ports: BTreeMap<String, Fingerprint>,
}

fn same_attachment(a: &Fingerprint, b: &Fingerprint) -> bool {
    a.vid == b.vid
        && a.pid == b.pid
        && a.serial == b.serial
        && a.usb_path == b.usb_path
        && a.interface == b.interface
}

impl Presence {
    /// One scan in, events out. The same scan twice gives no event.
    pub fn update(&mut self, now: Vec<Fingerprint>) -> Vec<PlugEvent> {
        let mut next = BTreeMap::new();
        for fp in now {
            if let Some(p) = fp.port.clone() {
                next.insert(p, fp);
            }
        }
        let mut events = Vec::new();
        for (port, old) in &self.ports {
            match next.get(port) {
                Some(new) if same_attachment(old, new) => {}
                _ => events.push(PlugEvent::Detached {
                    port: port.clone(),
                    fingerprint: old.clone(),
                }),
            }
        }
        for (port, new) in &next {
            match self.ports.get(port) {
                Some(old) if same_attachment(old, new) => {}
                _ => events.push(PlugEvent::Attached {
                    port: port.clone(),
                    fingerprint: new.clone(),
                }),
            }
        }
        self.ports = next;
        events
    }

    pub fn fingerprints(&self) -> Vec<Fingerprint> {
        self.ports.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests;
