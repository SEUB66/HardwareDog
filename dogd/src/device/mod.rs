//! Device discovery. Listing ports never writes to them. Identifying a
//! port sends one HDP hello and waits for the answer: only when asked.

use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::protocol::{Hello, LineWatch, HELLO_COMMAND};

#[derive(Clone, Debug, Serialize)]
pub struct Port {
    pub port: String,
    /// USB | PCI | BLUETOOTH | UNKNOWN
    pub kind: &'static str,
    pub vid: Option<String>,
    pub pid: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
    /// USB topology reported by the OS (Windows location path, macOS
    /// location id), e.g. "PCIROOT(0)#PCI(1400)#USBROOT(0)-2.3". None on
    /// Linux, where discovery reads sysfs.
    pub location: Option<String>,
    /// USB interface number reported by the OS, e.g. "if 0".
    pub interface: Option<String>,
}

pub fn list_ports() -> Vec<Port> {
    let hex = |n: u16| format!("{n:04X}");
    tokio_serial::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| match p.port_type {
            tokio_serial::SerialPortType::UsbPort(u) => Port {
                port: p.port_name,
                kind: "USB",
                vid: Some(hex(u.vid)),
                pid: Some(hex(u.pid)),
                manufacturer: u.manufacturer,
                product: u.product,
                serial: u.serial_number,
                #[cfg(not(target_os = "linux"))]
                location: u.location.map(|l| l.to_string()),
                #[cfg(not(target_os = "linux"))]
                interface: u.interface.map(|i| format!("if {i}")),
                #[cfg(target_os = "linux")]
                location: None,
                #[cfg(target_os = "linux")]
                interface: None,
            },
            other => Port {
                port: p.port_name,
                kind: match other {
                    tokio_serial::SerialPortType::PciPort => "PCI",
                    tokio_serial::SerialPortType::BluetoothPort => "BLUETOOTH",
                    _ => "UNKNOWN",
                },
                vid: None,
                pid: None,
                manufacturer: None,
                product: None,
                serial: None,
                location: None,
                interface: None,
            },
        })
        .collect()
}

/// Open the port, send HDP hello, wait for a hello frame. None means
/// UNKNOWN DEVICE: not a Hardware Dog, or not answering. Nothing else is
/// written, nothing is flashed.
pub async fn identify(port: &str, wait: Duration) -> Result<Option<Hello>, String> {
    use tokio_serial::SerialPortBuilderExt;
    let mut s = tokio_serial::new(port, 115_200)
        .open_native_async()
        .map_err(|e| format!("{port}: {e}"))?;
    s.write_all(HELLO_COMMAND)
        .await
        .map_err(|e| format!("{port}: {e}"))?;
    let mut watch = LineWatch::default();
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Ok(None);
        }
        match tokio::time::timeout(left, s.read(&mut buf)).await {
            Err(_) | Ok(Ok(0)) => return Ok(None),
            Ok(Err(e)) => return Err(format!("{port}: {e}")),
            Ok(Ok(n)) => {
                if let Some(h) = watch.push(&buf[..n]).into_iter().next() {
                    return Ok(Some(h));
                }
            }
        }
    }
}
