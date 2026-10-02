//! Hardware identity: what is plugged in, and is it the same thing as last
//! time. Local and deterministic: no database of serial numbers, no cloud.
//!
//! A device is described by a fingerprint (every signal we can read) and
//! recognised by a fixed ladder of keys, strongest first:
//!
//! ```text
//! 1  chip id / MAC address          EXCELLENT  48 bits, unique by construction
//! 2  serial number + VID:PID        EXCELLENT  only while the serial is trusted
//! 3  HDP device id (legacy, 24 bit) GOOD       not unique: a hint, not a proof
//! 4  VID:PID + USB topology path    GOOD       the same physical port
//! 5  descriptors + interface        MEDIUM     same kind of device, once
//! -  a port name (COM3, ttyACM0)    NEVER      an identity
//! ```
//!
//! A serial is not trusted blindly: cheap devices have none, share a fake
//! one, or repeat one digit. Two identical dongles without a serial are
//! told apart by their USB path ("already seen on this port"); when that is
//! not enough the answer is AMBIGUOUS, never a guess.
//!
//! A key a device declares about itself (chip id, MAC, serial, legacy HDP
//! id) is never folded into a record that was only known by a weaker key:
//! that record's past may belong to another unit. The answer is a new
//! identity with a hint naming the record, and the user binds them if they
//! are the same (storage: `bind`).

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
    /// USB topology: "1-2.3" on Linux (sysfs), the location path on
    /// Windows. The physical port chain, stable across replugs into the
    /// same socket, independent of the COM / tty number.
    pub usb_path: Option<String>,
    /// Interface signature, e.g. "1.0 class 02".
    pub interface: Option<String>,
    pub mac: Option<String>,
    /// 48-bit factory id (HDP hello `chip`: the ESP32 eFuse MAC).
    pub chip_id: Option<String>,
    /// HDP hello `device` ("HD-3A1F2C"): 24 bits of the MAC. Kept to
    /// recognise devices from before `chip`, never trusted as unique.
    pub legacy_id: Option<String>,
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

/// A device already known: its latest attributes. `serial` is only set
/// while that serial is trusted.
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
    pub legacy_id: Option<String>,
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
    /// Never seen: a new identity, as strong as its best key. `hint`: a
    /// known identity a weaker key pointed to, deliberately not merged.
    New {
        strength: Strength,
        basis: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
    },
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

/// A serial that is not trivially fake: present, 4 characters or more, not
/// one repeated character, not a counting placeholder.
pub fn plausible_serial(fp: &Fingerprint) -> Option<String> {
    let s = norm(&fp.serial)?;
    let distinct: std::collections::BTreeSet<char> = s.chars().collect();
    if s.len() < 4 || distinct.len() < 2 {
        return None; // "0", "0000", "aaaaaaaa": the same on every unit
    }
    if s == "123456789" || s == "0123456789" || s == "123456789abcdef" {
        return None;
    }
    Some(s)
}

/// Another device of the same VID:PID, plugged in right now, reports the
/// same serial: proof that this serial is not unique.
pub fn serial_shared_now(fp: &Fingerprint, present: &[Fingerprint]) -> bool {
    let Some(s) = norm(&fp.serial) else {
        return false;
    };
    present.iter().any(|o| {
        o.port != fp.port
            && o.vid == fp.vid
            && o.pid == fp.pid
            && norm(&o.serial).as_deref() == Some(&s)
    })
}

/// A serial worth trusting right now: plausible, and not shared by another
/// device of the same VID:PID plugged in right now. Serials proven shared
/// earlier are dropped by the caller (storage keeps that list).
pub fn usable_serial(fp: &Fingerprint, present: &[Fingerprint]) -> Option<String> {
    if serial_shared_now(fp, present) {
        return None;
    }
    plausible_serial(fp)
}

/// Why two descriptions cannot be the same device: different chip ids,
/// MACs or HDP device ids, or different trusted serials on the same VID:PID.
pub fn conflict(fp: &Fingerprint, serial: &Option<String>, k: &Known) -> Option<&'static str> {
    let differ = |a: &Option<String>, b: &Option<String>| matches!((norm(a), norm(b)), (Some(x), Some(y)) if x != y);
    if differ(&fp.chip_id, &k.chip_id) {
        return Some("different chip ids");
    }
    if differ(&fp.mac, &k.mac) {
        return Some("different MAC addresses");
    }
    if differ(&fp.legacy_id, &k.legacy_id) {
        return Some("different HDP device ids");
    }
    if fp.vid == k.vid && fp.pid == k.pid {
        if let (Some(s), Some(ks)) = (serial, norm(&k.serial)) {
            if *s != ks {
                return Some("different serials");
            }
        }
    }
    None
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

/// The rungs of the ladder, weakest first.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rung {
    Descriptors,
    Path,
    Legacy,
    Serial,
    Chip,
}

/// The strongest key a device declares about itself, if any.
fn declared(fp: &Fingerprint, serial: &Option<String>) -> Option<(Rung, Strength, String)> {
    if let Some(c) = norm(&fp.chip_id) {
        return Some((Rung::Chip, Strength::Excellent, format!("chip id {c}")));
    }
    if let Some(m) = norm(&fp.mac) {
        return Some((Rung::Chip, Strength::Excellent, format!("MAC address {m}")));
    }
    if let (Some(s), Some(v), Some(p)) = (serial, fp.vid, fp.pid) {
        return Some((
            Rung::Serial,
            Strength::Excellent,
            format!("serial {s} + {}:{}", hex4(v), hex4(p)),
        ));
    }
    norm(&fp.legacy_id).map(|l| {
        (
            Rung::Legacy,
            Strength::Good,
            format!("HDP device id {l} (24 bits of the MAC, not unique: legacy)"),
        )
    })
}

/// Recognise a fingerprint among the known devices. Deterministic: the same
/// inputs give the same answer. `serial` is the trusted serial (or None);
/// `present` are the ids attached right now on other ports: a device
/// cannot be plugged in twice.
pub fn resolve(
    fp: &Fingerprint,
    serial: &Option<String>,
    known: &[Known],
    present: &[String],
) -> Resolution {
    let fair: Vec<&Known> = known
        .iter()
        .filter(|k| conflict(fp, serial, k).is_none())
        .collect();
    let (found, rung) = ladder(fp, serial, &fair, present);
    let Some((own, strength, basis)) = declared(fp, serial) else {
        return found;
    };
    match found {
        // Matched at the strength the device declares (or EXCELLENT keys
        // that agree): the same device.
        Resolution::Known { strength: s, .. } if rung >= own || s == Strength::Excellent => found,
        // Matched by a weaker key only: never folded in. Said, not merged.
        Resolution::Known { id, .. } => Resolution::New {
            strength,
            basis,
            hint: Some(id),
        },
        // Look-alikes on the very key it declares: still not chosen.
        Resolution::Ambiguous { .. } if rung >= own => found,
        _ => Resolution::New {
            strength,
            basis,
            hint: None,
        },
    }
}

/// The ladder itself, and the rung that answered.
fn ladder(
    fp: &Fingerprint,
    serial: &Option<String>,
    fair: &[&Known],
    present: &[String],
) -> (Resolution, Rung) {
    let known = |id: &str, strength, basis: String, rung| {
        (
            Resolution::Known {
                id: id.to_string(),
                strength,
                basis,
            },
            rung,
        )
    };
    // 1. chip id / MAC: unique by construction.
    if let Some(c) = norm(&fp.chip_id) {
        if let Some(k) = fair
            .iter()
            .find(|k| norm(&k.chip_id).as_deref() == Some(c.as_str()))
        {
            return known(
                &k.id,
                Strength::Excellent,
                format!("chip id {c}"),
                Rung::Chip,
            );
        }
    }
    if let Some(m) = norm(&fp.mac) {
        if let Some(k) = fair
            .iter()
            .find(|k| norm(&k.mac).as_deref() == Some(m.as_str()))
        {
            return known(
                &k.id,
                Strength::Excellent,
                format!("MAC address {m}"),
                Rung::Chip,
            );
        }
    }
    let usb = match (fp.vid, fp.pid) {
        (Some(v), Some(p)) => Some((v, p, format!("{}:{}", hex4(v), hex4(p)))),
        _ => None,
    };
    let kind = usb.as_ref().map(|(v, p, _)| (*v, *p));
    let same_kind = |k: &&&Known| kind.is_some_and(|(v, p)| k.vid == Some(v) && k.pid == Some(p));

    // 2. a trusted serial on this VID:PID.
    if let (Some(s), Some((_, _, name))) = (serial, &usb) {
        if let Some(k) = fair
            .iter()
            .filter(same_kind)
            .find(|k| norm(&k.serial).as_deref() == Some(s.as_str()))
        {
            return known(
                &k.id,
                Strength::Excellent,
                format!("serial {s} + {name}"),
                Rung::Serial,
            );
        }
        // A trusted serial nobody has: a new device, whatever its socket.
        return (
            Resolution::New {
                strength: Strength::Excellent,
                basis: format!("serial {s} + {name}"),
                hint: None,
            },
            Rung::Serial,
        );
    }

    // From here nothing unique: one attached elsewhere right now cannot be
    // this one.
    let free: Vec<&&Known> = fair.iter().filter(|k| !present.contains(&k.id)).collect();

    // 3. the legacy HDP device id: 24 bits, so only when it is unambiguous.
    if let Some(l) = norm(&fp.legacy_id) {
        let alike: Vec<&&&Known> = free
            .iter()
            .filter(|k| norm(&k.legacy_id).as_deref() == Some(l.as_str()))
            .collect();
        match alike.len() {
            0 => {}
            1 => {
                return known(
                    &alike[0].id,
                    Strength::Good,
                    format!("HDP device id {l} (24 bits, legacy)"),
                    Rung::Legacy,
                )
            }
            n => {
                return (
                    Resolution::Ambiguous {
                        candidates: alike.iter().map(|k| k.id.clone()).collect(),
                        basis: format!("{n} devices share the 24-bit HDP device id {l}"),
                    },
                    Rung::Legacy,
                )
            }
        }
    }

    let Some((vid, pid, name)) = usb else {
        return (
            match norm(&fp.legacy_id) {
                Some(l) => Resolution::New {
                    strength: Strength::Good,
                    basis: format!("HDP device id {l} (24 bits of the MAC, not unique: legacy)"),
                    hint: None,
                },
                None => Resolution::Unidentified {
                    basis: "no chip id, MAC or USB descriptor: a port name is not an identity"
                        .into(),
                },
            },
            Rung::Descriptors,
        );
    };
    let free: Vec<&&Known> = free.into_iter().filter(same_kind).collect();

    // 4. the same physical USB port.
    if let Some(path) = norm(&fp.usb_path) {
        if let Some(k) = free
            .iter()
            .find(|k| norm(&k.usb_path).as_deref() == Some(path.as_str()))
        {
            return known(
                &k.id,
                Strength::Good,
                format!("{name} already seen on USB port {path}"),
                Rung::Path,
            );
        }
    }

    // 5. same descriptors and interface, on another port: only if unique.
    let key = descriptor_key(vid, pid, &fp.manufacturer, &fp.product, &fp.interface);
    let alike: Vec<&&&Known> = free
        .iter()
        .filter(|k| descriptor_key(vid, pid, &k.manufacturer, &k.product, &k.interface) == key)
        .collect();
    let r = match alike.len() {
        0 => match norm(&fp.usb_path) {
            Some(path) => Resolution::New {
                strength: Strength::Good,
                basis: format!("{name} on USB port {path}, no trusted serial"),
                hint: None,
            },
            None => Resolution::New {
                strength: Strength::Medium,
                basis: format!("{name} descriptors only, no trusted serial, no USB path"),
                hint: None,
            },
        },
        1 => Resolution::Known {
            id: alike[0].id.clone(),
            strength: Strength::Medium,
            basis: format!("same {name} descriptors, moved to another port"),
        },
        _ => Resolution::Ambiguous {
            candidates: alike.iter().map(|k| k.id.clone()).collect(),
            basis: format!(
                "{} identical {name} devices without serial: bind this one (dogd bind PORT HW-ID)",
                alike.len()
            ),
        },
    };
    (r, Rung::Descriptors)
}

/// The key a new identity is named after. Only chip id, MAC and a trusted
/// serial are properties of the device: those ids are the same on any
/// machine. Keys from the USB path or descriptors describe this desk.
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
    if let Some(l) = norm(&fp.legacy_id) {
        return format!("hdp24:{l}");
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

/// "HW-" + 96 bits of SHA-256 over the key: collisions are not a concern
/// at any realistic number of devices (and `fresh_id` still checks).
pub fn identity_id(key: &str) -> String {
    let h = Sha256::digest(key.as_bytes());
    let hex: String = h.iter().take(12).map(|b| format!("{b:02x}")).collect();
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
