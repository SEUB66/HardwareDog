//! HW DOG / DOGD — the local Hardware Dog daemon.
//!
//! DISCOVER, CONNECT, BRIDGE, STORE, SERVE. Never interpret differently,
//! never invent events, never rewrite HDP, never become a cloud service.
//! The diagnosis stays in the one engine the interface runs.

mod api;
mod config;
mod device;
mod discovery;
mod identity;
mod protocol;
mod sessions;
mod storage;
mod transport;

use std::sync::Arc;
use std::time::Duration;

use config::{Config, DEFAULT_PORT, USAGE};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, rest) = match args.first().map(String::as_str) {
        Some("serve") | Some("status") | Some("devices") | Some("sessions") | Some("alias") => {
            (args[0].as_str(), &args[1..])
        }
        Some("--help") | Some("-h") | Some("help") => {
            println!("{USAGE}");
            return;
        }
        Some("--version") | Some("-V") => {
            println!("dogd {}", api::VERSION);
            return;
        }
        _ => ("serve", &args[..]),
    };
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let code = rt.block_on(async {
        match cmd {
            "serve" => match config::parse_serve(rest) {
                Ok(cfg) => serve(cfg).await,
                Err(e) => fail(&e),
            },
            "status" => status(rest).await,
            "devices" => devices(rest).await,
            "sessions" => sessions(rest),
            "alias" => alias(rest),
            _ => unreachable!(),
        }
    });
    std::process::exit(code);
}

fn fail(msg: &str) -> i32 {
    eprintln!("dogd: {msg}");
    2
}

fn row(k: &str, v: impl std::fmt::Display) {
    println!("{k:<15}{v}");
}

async fn serve(cfg: Config) -> i32 {
    let store = match storage::Store::open(&cfg.data_dir) {
        Ok(s) => Arc::new(s),
        Err(e) => return fail(&e),
    };
    let listener = match tokio::net::TcpListener::bind(cfg.listen).await {
        Ok(l) => l,
        Err(e) => return fail(&format!("cannot listen on {}: {e}", cfg.listen)),
    };
    let listen = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();
    let discovery = Arc::new(discovery::Discovery::default());
    let (seen, found) = (store.clone(), discovery.clone());
    let link = transport::Link::new(&cfg.source, cfg.origin, move |hello, port| {
        seen.saw_device(hello, port);
        // The HDP device id comes from the chip: the strongest identity there is.
        if let Some(line) = found.identified(&seen, port, &hello.device) {
            println!("{line}");
        }
    });
    tokio::spawn(link.clone().run(cfg.source.clone()));
    // Hot-plug: one scan a second. Listing ports never writes to them.
    let (scan_store, scan) = (store.clone(), discovery.clone());
    tokio::spawn(async move {
        loop {
            let ports = tokio::task::spawn_blocking(device::list_ports)
                .await
                .unwrap_or_default();
            for line in scan.scan(&scan_store, &ports) {
                println!("{line}");
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });

    println!("HW DOG / DOGD");
    row("VERSION", api::VERSION);
    row("MODE", if cfg.lan { "LAN (explicit)" } else { "LOCAL" });
    row("LISTEN", &listen);
    row("HDP", format!("v{}", protocol::HDP_VERSION));
    row("DEVICE", cfg.source.describe());
    if cfg.source != config::Source::None {
        row("ORIGIN", cfg.origin.as_str());
    }
    row("DATA", cfg.data_dir.display());
    row("SESSIONS", store.sessions().len());
    row("STATE", "READY");
    println!();

    let state = api::AppState {
        link,
        store,
        discovery,
        cfg: Arc::new(cfg),
    };
    let app = api::router(state);
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    match axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        Ok(()) => 0,
        Err(e) => fail(&e.to_string()),
    }
}

/// Minimal HTTP/1.1 GET to a local dogd: no HTTP client dependency.
async fn local_get(port: u16, path: &str) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| format!("no dogd on 127.0.0.1:{port} ({e})"))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    serde_json::from_str(body).map_err(|e| format!("bad answer: {e}"))
}

fn port_arg(args: &[String]) -> u16 {
    args.iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

async fn status(args: &[String]) -> i32 {
    let port = port_arg(args);
    let health = match local_get(port, "/v1/health").await {
        Ok(h) => h,
        Err(e) => {
            println!("HW DOG / DOGD");
            row("STATE", "NOT RUNNING");
            row("DETAIL", e);
            return 1;
        }
    };
    let link = local_get(port, "/v1/link").await.unwrap_or_default();
    let s = |v: &serde_json::Value, k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or("--")
            .to_string()
    };
    println!("HW DOG / DOGD");
    row("VERSION", s(&health, "dogd"));
    row("LISTEN", format!("127.0.0.1:{port}"));
    row(
        "HDP",
        format!(
            "v{}",
            health.get("hdp").and_then(|x| x.as_u64()).unwrap_or(0)
        ),
    );
    row("LINK", s(&link, "state"));
    row("SOURCE", s(&link, "source"));
    match link.get("device").filter(|d| !d.is_null()) {
        Some(d) => row(
            "DEVICE",
            format!("{} rev {} fw {}", s(d, "device"), s(d, "rev"), s(d, "fw")),
        ),
        None => row("DEVICE", "NONE"),
    }
    0
}

fn data_dir(args: &[String]) -> std::path::PathBuf {
    args.iter()
        .position(|a| a == "--data")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(config::default_data_dir)
}

/// Every identity dogd knows (works with dogd stopped).
fn known_devices(store: &storage::Store) -> i32 {
    let rows = store.hw_devices();
    if rows.is_empty() {
        println!("NO DEVICE KNOWN YET");
    }
    for d in rows {
        let usb = match (d.vid, d.pid) {
            (Some(v), Some(p)) => format!("{v:04X}:{p:04X}"),
            _ => "--".into(),
        };
        let name = d
            .alias
            .as_deref()
            .map(|a| format!("'{a}'"))
            .unwrap_or_default();
        println!(
            "{:<15}{:<22}{:<11}{:<11}{}",
            d.id, name, usb, d.strength, d.basis
        );
        if let Some(a) = d.ambiguous_with {
            println!(
                "{:<15}looks like {a}: give it an alias (dogd alias {} NAME)",
                "", d.id
            );
        }
    }
    0
}

async fn devices(args: &[String]) -> i32 {
    let identify = args.iter().any(|a| a == "--identify");
    // Read-only: this command resolves against what dogd knows, it records nothing.
    let store = storage::Store::open(&data_dir(args)).ok();
    if args.iter().any(|a| a == "--known") {
        return match &store {
            Some(s) => known_devices(s),
            None => fail("no dogd index"),
        };
    }
    let ports = tokio::task::spawn_blocking(device::list_ports)
        .await
        .unwrap_or_default();
    if ports.is_empty() {
        println!("NO SERIAL PORT");
        return 0;
    }
    let fps: Vec<identity::Fingerprint> = ports.iter().map(discovery::fingerprint).collect();
    let known = store.as_ref().map(|s| s.known()).unwrap_or_default();
    for (p, fp) in ports.iter().zip(&fps) {
        let others: Vec<identity::Fingerprint> =
            fps.iter().filter(|f| f.port != fp.port).cloned().collect();
        let serial = identity::usable_serial(fp, &others);
        let who = match identity::resolve(fp, &serial, &known, &[]) {
            identity::Resolution::Known {
                id,
                strength,
                basis,
            } => {
                let alias = known
                    .iter()
                    .find(|k| k.id == id)
                    .and_then(|k| k.alias.clone())
                    .map(|a| format!(" '{a}'"))
                    .unwrap_or_default();
                format!("{id}{alias} {} ({basis})", strength.as_str())
            }
            identity::Resolution::New { strength, basis } => {
                format!("NEW {} ({basis})", strength.as_str())
            }
            identity::Resolution::Ambiguous { candidates, basis } => {
                format!("AMBIGUOUS {} ({basis})", candidates.join(" "))
            }
            identity::Resolution::Unidentified { basis } => format!("NO IDENTITY ({basis})"),
        };
        println!("{:<22}{}", p.port, who);
    }
    println!();
    for p in ports {
        let usb = match (&p.vid, &p.pid) {
            (Some(v), Some(i)) => format!("USB {v}:{i} {}", p.product.clone().unwrap_or_default()),
            _ => p.kind.to_string(),
        };
        let identity = if identify {
            match device::identify(&p.port, Duration::from_millis(1500)).await {
                Ok(Some(h)) => format!(
                    "HARDWARE DOG {} rev {} fw {} hdp v{}",
                    h.device, h.rev, h.fw, h.proto
                ),
                Ok(None) => "UNKNOWN DEVICE".into(),
                Err(e) => format!("ERROR {e}"),
            }
        } else {
            "NOT PROBED (--identify sends one HDP hello)".into()
        };
        println!("{:<22}{:<34}{}", p.port, usb.trim(), identity);
    }
    0
}

/// dogd alias HW-ID NAME: name a device once, for good. --clear removes it.
fn alias(args: &[String]) -> i32 {
    let Some(id) = args.first() else {
        return fail("usage: dogd alias HW-ID NAME | dogd alias HW-ID --clear");
    };
    let name: Vec<&str> = args[1..]
        .iter()
        .map(String::as_str)
        .take_while(|a| *a != "--data")
        .collect();
    if name.is_empty() {
        return fail("usage: dogd alias HW-ID NAME | dogd alias HW-ID --clear");
    }
    let name = if name == ["--clear"] {
        String::new()
    } else {
        name.join(" ")
    };
    let store = match storage::Store::open(&data_dir(args)) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };
    match store.set_alias(id, &name) {
        Ok(()) if name.is_empty() => {
            println!("{id}: alias removed");
            0
        }
        Ok(()) => {
            println!("{id}: '{name}'");
            0
        }
        Err(e) => fail(&e),
    }
}

fn sessions(args: &[String]) -> i32 {
    let dir = args
        .iter()
        .position(|a| a == "--data")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(config::default_data_dir);
    let store = match storage::Store::open(&dir) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };
    let rows = store.sessions();
    if rows.is_empty() {
        println!("NO SESSION STORED IN {}", dir.display());
    }
    for r in rows {
        println!(
            "{}  {}  {:<9}  {:<10}  {:<9}  {}",
            r.session_label,
            &r.recording_id[..8],
            r.origin,
            r.integrity,
            r.closure.unwrap_or_else(|| "--".into()),
            &r.sha256[..16]
        );
    }
    0
}

#[cfg(test)]
mod laws {
    /// LAWS 3: discovery and identification never need the Internet. dogd
    /// has no HTTP client, no DNS lookup of its own, no remote registry.
    #[test]
    fn dogd_has_no_network_client_dependency() {
        let manifest = include_str!("../Cargo.toml");
        for client in [
            "reqwest",
            "ureq",
            "surf",
            "isahc",
            "hyper-util",
            "attohttpc",
            "curl",
            "trust-dns",
            "hickory",
        ] {
            assert!(!manifest.contains(client), "{client} in Cargo.toml");
        }
        for file in [
            include_str!("identity/mod.rs"),
            include_str!("discovery.rs"),
        ] {
            for call in ["TcpStream", "UdpSocket", "ToSocketAddrs", "lookup_host"] {
                assert!(!file.contains(call), "{call} in the identity code");
            }
        }
    }
}
