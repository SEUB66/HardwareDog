//! The USB devices plugged into this computer, as the operating system
//! lists them. Reading only: no device is opened, claimed or written to.
//!
//! Linux, from sysfs (/sys/bus/usb/devices): every value the HDP frame
//! needs is there, the speed the device enumerated at included. Other
//! systems do not list it in a form dogd reads yet: there, the host device
//! does not declare `usb`, and says so.

use std::path::Path;

use serde::Serialize;

/// One device, as plugged in now.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsbDevice {
    /// Where it is plugged in: bus-port path, e.g. "1-2.3". Stable while it
    /// stays in that port; it is how two identical devices are told apart.
    pub port: String,
    pub vid: u16,
    pub pid: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
    /// The speed it enumerated at: LOW, FULL, HIGH, SUPER. None: not said.
    pub speed: Option<&'static str>,
    /// Device class, or the first interface's when the device leaves it to them.
    pub cls: String,
    /// BUS or SELF powered, from bmAttributes. None: not said.
    pub power: Option<&'static str>,
    /// What it may draw from the bus, as it declares it (bMaxPower), mA.
    pub max_ma: Option<u32>,
}

impl UsbDevice {
    pub fn id(&self) -> String {
        format!("{:04X}:{:04X}", self.vid, self.pid)
    }

    /// "Logitech USB Receiver", or the id when it has no name.
    pub fn name(&self) -> String {
        match (&self.manufacturer, &self.product) {
            (Some(m), Some(p)) if p.starts_with(m.as_str()) => p.clone(),
            (Some(m), Some(p)) => format!("{m} {p}"),
            (None, Some(p)) => p.clone(),
            (Some(m), None) => m.clone(),
            (None, None) => self.id(),
        }
    }

    pub fn is_hub(&self) -> bool {
        self.cls == "HUB"
    }
}

/// The class names HDP uses (usb.attach cls).
pub fn class_name(code: u8) -> String {
    match code {
        0x01 => "AUDIO".into(),
        0x02 => "CDC".into(),
        0x03 => "HID".into(),
        0x05 => "PHYSICAL".into(),
        0x06 => "IMAGE".into(),
        0x07 => "PRINTER".into(),
        0x08 => "MSC".into(),
        0x09 => "HUB".into(),
        0x0a => "CDC-DATA".into(),
        0x0b => "SMART-CARD".into(),
        0x0e => "VIDEO".into(),
        0x0f => "HEALTH".into(),
        0x10 => "AV".into(),
        0x11 => "BILLBOARD".into(),
        0xdc => "DIAGNOSTIC".into(),
        0xe0 => "WIRELESS".into(),
        0xef => "MISC".into(),
        0xfe => "APPLICATION".into(),
        0xff => "VENDOR".into(),
        other => format!("0x{other:02X}"),
    }
}

/// sysfs speed (Mb/s) to the speed HDP names.
pub fn speed_name(mbps: &str) -> Option<&'static str> {
    match mbps.trim() {
        "1.5" => Some("LOW"),
        "12" => Some("FULL"),
        "480" => Some("HIGH"),
        "5000" | "10000" | "20000" | "40000" => Some("SUPER"),
        _ => None,
    }
}

/// A device directory name: "1-2" or "1-2.3", never a root hub ("usb1")
/// nor an interface ("1-2:1.0").
fn is_device_dir(name: &str) -> bool {
    name.contains('-')
        && !name.contains(':')
        && name.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// Every device under a sysfs tree (`/sys/bus/usb/devices`), sorted by port.
pub fn scan_sysfs(root: &Path) -> Vec<UsbDevice> {
    let Ok(dir) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in dir.flatten() {
        let port = e.file_name().to_string_lossy().into_owned();
        if !is_device_dir(&port) {
            continue;
        }
        let path = root.join(&port);
        let read = |f: &str| {
            std::fs::read_to_string(path.join(f))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let hex = |f: &str| read(f).and_then(|s| u16::from_str_radix(&s, 16).ok());
        let (Some(vid), Some(pid)) = (hex("idVendor"), hex("idProduct")) else {
            continue;
        };
        let class = read("bDeviceClass")
            .and_then(|s| u8::from_str_radix(&s, 16).ok())
            .unwrap_or(0);
        // 00: the class is the interfaces' (most HID, MSC, CDC devices).
        let class = if class == 0 {
            std::fs::read_to_string(path.join(format!("{port}:1.0/bInterfaceClass")))
                .ok()
                .and_then(|s| u8::from_str_radix(s.trim(), 16).ok())
                .unwrap_or(0)
        } else {
            class
        };
        let power = read("bmAttributes")
            .and_then(|s| u8::from_str_radix(&s, 16).ok())
            .map(|a| if a & 0x40 != 0 { "SELF" } else { "BUS" });
        let max_ma = read("bMaxPower").and_then(|s| s.trim_end_matches("mA").trim().parse().ok());
        out.push(UsbDevice {
            port,
            vid,
            pid,
            manufacturer: read("manufacturer"),
            product: read("product"),
            serial: read("serial"),
            speed: read("speed").as_deref().and_then(speed_name),
            cls: class_name(class),
            power,
            max_ma,
        });
    }
    out.sort_by(|a, b| a.port.cmp(&b.port));
    out
}

/// This computer's USB devices. None: this system is not read yet, or it
/// has no USB bus (a container, a virtual machine without one).
///
/// HWDOG_USB_SYSFS points at another sysfs tree: for tests and demos, a
/// tree of files that looks like /sys/bus/usb/devices.
pub fn scan() -> Option<Vec<UsbDevice>> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let root = std::env::var_os("HWDOG_USB_SYSFS")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/sys/bus/usb/devices".into());
    root.is_dir().then(|| scan_sysfs(&root))
}

/// Which device is followed: the first one matching, by id and, when
/// given, serial number or port.
#[derive(Clone, Debug, PartialEq)]
pub struct Follow {
    pub vid: u16,
    pub pid: u16,
    pub serial: Option<String>,
    pub port: Option<String>,
}

impl Follow {
    pub fn matches(&self, d: &UsbDevice) -> bool {
        d.vid == self.vid
            && d.pid == self.pid
            && self
                .serial
                .as_ref()
                .is_none_or(|s| d.serial.as_ref() == Some(s))
            && self.port.as_ref().is_none_or(|p| &d.port == p)
    }
}

/// What changed between two scans: devices that came, devices that went.
pub fn diff<'a>(
    before: &'a [UsbDevice],
    now: &'a [UsbDevice],
) -> (Vec<&'a UsbDevice>, Vec<&'a UsbDevice>) {
    let same = |a: &UsbDevice, b: &UsbDevice| {
        a.port == b.port && a.vid == b.vid && a.pid == b.pid && a.serial == b.serial
    };
    let came = now
        .iter()
        .filter(|d| !before.iter().any(|b| same(b, d)))
        .collect();
    let went = before
        .iter()
        .filter(|b| !now.iter().any(|d| same(b, d)))
        .collect();
    (came, went)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dev(root: &Path, port: &str, files: &[(&str, &str)]) {
        let d = root.join(port);
        fs::create_dir_all(&d).unwrap();
        for (f, v) in files {
            let p = d.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, format!("{v}\n")).unwrap();
        }
    }

    fn tree() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hwdog-usb-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A root hub and an interface: not devices.
        dev(
            &root,
            "usb1",
            &[("idVendor", "1d6b"), ("idProduct", "0002")],
        );
        dev(&root, "1-2:1.0", &[("bInterfaceClass", "03")]);
        // A wireless mouse receiver: class in its interface, bus powered.
        dev(
            &root,
            "1-2",
            &[
                ("idVendor", "046d"),
                ("idProduct", "c52b"),
                ("manufacturer", "Logitech"),
                ("product", "USB Receiver"),
                ("speed", "12"),
                ("bDeviceClass", "00"),
                ("bmAttributes", "a0"),
                ("bMaxPower", "98mA"),
                ("1-2:1.0/bInterfaceClass", "03"),
            ],
        );
        // A phone behind a hub: high speed, self powered, a serial.
        dev(
            &root,
            "1-4.1",
            &[
                ("idVendor", "18d1"),
                ("idProduct", "4ee7"),
                ("manufacturer", "Google"),
                ("product", "Pixel 7"),
                ("serial", "28131FDH2000A9"),
                ("speed", "480"),
                ("bDeviceClass", "00"),
                ("bmAttributes", "c0"),
                ("bMaxPower", "500mA"),
                ("1-4.1:1.0/bInterfaceClass", "ff"),
            ],
        );
        dev(
            &root,
            "1-4",
            &[
                ("idVendor", "05e3"),
                ("idProduct", "0610"),
                ("speed", "480"),
                ("bDeviceClass", "09"),
                ("bmAttributes", "e0"),
            ],
        );
        root
    }

    #[test]
    fn reads_every_device_and_only_devices() {
        let root = tree();
        let got = scan_sysfs(&root);
        let ports: Vec<&str> = got.iter().map(|d| d.port.as_str()).collect();
        assert_eq!(ports, ["1-2", "1-4", "1-4.1"]);
        let mouse = &got[0];
        assert_eq!(
            (mouse.vid, mouse.pid, mouse.id()),
            (0x046d, 0xc52b, "046D:C52B".to_string())
        );
        assert_eq!(
            (mouse.speed, mouse.cls.as_str(), mouse.power, mouse.max_ma),
            (Some("FULL"), "HID", Some("BUS"), Some(98))
        );
        assert_eq!(mouse.name(), "Logitech USB Receiver");
        let phone = &got[2];
        assert_eq!(
            (phone.speed, phone.cls.as_str(), phone.power),
            (Some("HIGH"), "VENDOR", Some("SELF"))
        );
        assert_eq!(phone.serial.as_deref(), Some("28131FDH2000A9"));
        assert!(got[1].is_hub());
        // Nothing to read: nothing listed, no error.
        assert!(scan_sysfs(&root.join("absent")).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn follows_the_right_one_and_sees_it_come_and_go() {
        let root = tree();
        let all = scan_sysfs(&root);
        let f = Follow {
            vid: 0x18d1,
            pid: 0x4ee7,
            serial: Some("28131FDH2000A9".into()),
            port: None,
        };
        assert_eq!(all.iter().filter(|d| f.matches(d)).count(), 1);
        let other = Follow {
            serial: Some("XXX".into()),
            ..f.clone()
        };
        assert!(!all.iter().any(|d| other.matches(d)));

        let without_phone: Vec<UsbDevice> =
            all.iter().filter(|d| d.port != "1-4.1").cloned().collect();
        let (came, went) = diff(&all, &without_phone);
        assert!(came.is_empty());
        assert_eq!(
            went.iter().map(|d| d.port.as_str()).collect::<Vec<_>>(),
            ["1-4.1"]
        );
        let (came, went) = diff(&without_phone, &all);
        assert_eq!((came.len(), went.len()), (1, 0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn names_and_classes() {
        assert_eq!(speed_name("5000"), Some("SUPER"));
        assert_eq!(speed_name("?"), None);
        assert_eq!(class_name(0x08), "MSC");
        assert_eq!(class_name(0x42), "0x42");
    }
}
