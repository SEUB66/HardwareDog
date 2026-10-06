//! The real system: what the operating system says, and the checks run
//! from this computer. Reading never sends anything; the checks (ping,
//! resolve, connect) are the ACTIVE part, run only by net.watch and probe.

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::timeout;

use super::parse::{self, Ping};
use super::{Net, Observation};

const PINGS: u32 = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

pub struct System;

/// The address this computer would use to reach `to`. A UDP socket that is
/// connected, never written to: no packet leaves.
fn local_address(to: Ipv4Addr) -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect(SocketAddr::from((to, 9))).ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(a) if !a.is_unspecified() && !a.is_loopback() => Some(a),
        _ => None,
    }
}

async fn run(cmd: &str, args: &[&str], limit: Duration) -> Option<String> {
    let out = timeout(
        limit,
        Command::new(cmd).args(args).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn resolv_conf() -> Option<String> {
    std::fs::read_to_string("/etc/resolv.conf")
        .ok()
        .and_then(|c| parse::resolv_conf_server(&c))
}

#[cfg(target_os = "linux")]
fn linux_link(iface: &str) -> Option<super::Link> {
    let read = |f: &str| {
        std::fs::read_to_string(format!("/sys/class/net/{iface}/{f}"))
            .ok()
            .map(|s| s.trim().to_string())
    };
    let oper = read("operstate")?;
    // "unknown" is what some drivers say while up (tun, some Wi-Fi): the carrier decides.
    let up = match oper.as_str() {
        "up" => true,
        "down" | "lowerlayerdown" | "notpresent" | "dormant" => false,
        _ => read("carrier").as_deref() == Some("1"),
    };
    let mbps = read("speed")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|s| *s > 0.0);
    let duplex = match read("duplex").as_deref() {
        Some("full") => Some("FULL"),
        Some("half") => Some("HALF"),
        _ => None,
    };
    Some(super::Link {
        up,
        mbps: if up { mbps } else { None },
        duplex: if up { duplex } else { None },
    })
}

#[cfg(target_os = "linux")]
async fn observe_os() -> Observation {
    let route = std::fs::read_to_string("/proc/net/route")
        .ok()
        .and_then(|t| parse::linux_default_route(&t));
    let (iface, gateway) = match route {
        Some((i, g)) => (Some(i), g),
        None => (None, None),
    };
    let link = match &iface {
        Some(i) => linux_link(i),
        // No route: the link of any wired or wireless interface, up if one is.
        None => {
            let mut links = Vec::new();
            if let Ok(dir) = std::fs::read_dir("/sys/class/net") {
                for e in dir.flatten() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let virt = std::fs::read_link(e.path())
                        .map(|p| p.to_string_lossy().contains("/virtual/"))
                        .unwrap_or(true);
                    if name != "lo" && !virt {
                        if let Some(l) = linux_link(&name) {
                            links.push(l);
                        }
                    }
                }
            }
            links
                .iter()
                .find(|l| l.up)
                .cloned()
                .or_else(|| links.into_iter().next())
        }
    };
    let address = local_address(gateway.unwrap_or(Ipv4Addr::new(192, 0, 2, 1)));
    Observation {
        link,
        address,
        gateway,
        dns_server: resolv_conf(),
    }
}

#[cfg(target_os = "macos")]
async fn observe_os() -> Observation {
    let (gateway, iface) =
        match run("route", &["-n", "get", "default"], Duration::from_secs(2)).await {
            Some(out) => parse::bsd_route_get(&out),
            None => (None, None),
        };
    let link = match &iface {
        Some(i) => run("ifconfig", &[i], Duration::from_secs(2))
            .await
            .map(|out| super::Link {
                up: out.contains("status: active"),
                mbps: None,
                duplex: None,
            }),
        None => None,
    };
    let address = local_address(gateway.unwrap_or(Ipv4Addr::new(192, 0, 2, 1)));
    Observation {
        link,
        address,
        gateway,
        dns_server: resolv_conf(),
    }
}

#[cfg(target_os = "windows")]
async fn observe_os() -> Observation {
    let gateway = run("route", &["print", "-4", "0.0.0.0"], Duration::from_secs(3))
        .await
        .and_then(|o| parse::windows_default_gateway(&o));
    let address = local_address(gateway.unwrap_or(Ipv4Addr::new(192, 0, 2, 1)));
    // Windows says nothing here about the link or the name server: UNKNOWN.
    Observation {
        link: None,
        address,
        gateway,
        dns_server: None,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn observe_os() -> Observation {
    Observation {
        address: local_address(Ipv4Addr::new(192, 0, 2, 1)),
        ..Default::default()
    }
}

fn ping_args(to: &str) -> (&'static str, Vec<String>) {
    let n = PINGS.to_string();
    if cfg!(target_os = "windows") {
        (
            "ping",
            vec!["-n".into(), n, "-w".into(), "1000".into(), to.into()],
        )
    } else if cfg!(target_os = "macos") {
        (
            "ping",
            vec![
                "-n".into(),
                "-c".into(),
                n,
                "-W".into(),
                "1000".into(),
                to.into(),
            ],
        )
    } else {
        (
            "ping",
            vec![
                "-n".into(),
                "-c".into(),
                n,
                "-i".into(),
                "0.2".into(),
                "-W".into(),
                "1".into(),
                to.into(),
            ],
        )
    }
}

async fn resolve_v4(name: &str) -> Option<Ipv4Addr> {
    if let Ok(a) = name.parse::<Ipv4Addr>() {
        return Some(a);
    }
    let addrs = timeout(
        CONNECT_TIMEOUT,
        tokio::net::lookup_host(format!("{name}:0")),
    )
    .await
    .ok()?
    .ok()?;
    addrs
        .filter_map(|a| match a.ip() {
            std::net::IpAddr::V4(v) => Some(v),
            _ => None,
        })
        .next()
}

impl Net for System {
    fn usb(&self) -> Option<Vec<super::usb::UsbDevice>> {
        super::usb::scan()
    }

    async fn observe(&self) -> Observation {
        observe_os().await
    }

    async fn ping(&self, to: Ipv4Addr) -> Option<Ping> {
        let (cmd, args) = ping_args(&to.to_string());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        // A missing ping, or one this user may not run, says nothing.
        let out = run(cmd, &args, Duration::from_secs(10)).await?;
        let p = parse::ping_output(&out, PINGS);
        (p.replies > 0 || out.contains(&to.to_string())).then_some(p)
    }

    async fn resolve(&self, name: &str) -> Option<Ipv4Addr> {
        resolve_v4(name).await
    }

    async fn connect(&self, host: &str, port: u16) -> Result<bool, ()> {
        let ip = resolve_v4(host).await.ok_or(())?;
        Ok(matches!(
            timeout(CONNECT_TIMEOUT, TcpStream::connect((ip, port))).await,
            Ok(Ok(_))
        ))
    }

    async fn http_status(&self, host: &str) -> Result<Option<String>, ()> {
        let ip = resolve_v4(host).await.ok_or(())?;
        let Ok(Ok(mut s)) = timeout(CONNECT_TIMEOUT, TcpStream::connect((ip, 80))).await else {
            return Ok(None);
        };
        let req = format!("GET / HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        if s.write_all(req.as_bytes()).await.is_err() {
            return Ok(None);
        }
        let mut buf = [0u8; 64];
        let n = match timeout(CONNECT_TIMEOUT, s.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => return Ok(None),
        };
        let text = String::from_utf8_lossy(&buf[..n]);
        let line = text.split(['\r', '\n']).next().unwrap_or("").to_string();
        Ok(line.starts_with("HTTP/").then_some(line))
    }
}
