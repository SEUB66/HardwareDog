//! HW DOG / DOGD — the local Hardware Dog daemon.
//!
//! DISCOVER, CONNECT, BRIDGE, STORE, SERVE. Never interpret differently,
//! never invent events, never rewrite HDP, never become a cloud service.
//! The diagnosis stays in the one engine the interface runs.

mod api;
mod config;
mod device;
mod discovery;
mod hostnet;
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
        Some("serve") | Some("status") | Some("devices") | Some("sessions") | Some("alias")
        | Some("bind") => (args[0].as_str(), &args[1..]),
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
            "bind" => bind(rest).await,
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

async fn serve(mut cfg: Config) -> i32 {
    if cfg.lan {
        match config::new_token() {
            Ok(t) => cfg.lan_token = Some(t),
            Err(e) => return fail(&e),
        }
    }
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
    // One link per source: D1, D2... A pack is assembled by the interface,
    // from one stream per Dog; dogd bridges each one unchanged.
    let sources: Vec<(config::Source, config::Origin)> = if cfg.links.is_empty() {
        vec![(config::Source::None, config::Origin::Physical)]
    } else {
        cfg.links
            .iter()
            .map(|l| (l.source.clone(), l.origin))
            .collect()
    };
    let mut links = Vec::new();
    for (n, (source, origin)) in sources.into_iter().enumerate() {
        let (seen, found) = (store.clone(), discovery.clone());
        // This computer is not a board: it has no identity to remember.
        let is_host = source == config::Source::Host;
        let link = transport::Link::new(
            &format!("D{}", n + 1),
            &source,
            origin,
            move |hello, port| {
                if is_host {
                    return;
                }
                seen.saw_device(hello, port);
                // The 48-bit chip id (or, from older firmware, the 24-bit HDP id).
                if let Some(line) = found.identified(&seen, port, hello) {
                    println!("{line}");
                }
            },
        );
        tokio::spawn(link.clone().run(source));
        links.push(link);
    }
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
    if let Some(t) = &cfg.lan_token {
        // Other machines show it; this one does not need to.
        row("TOKEN", t);
    }
    row("LISTEN", &listen);
    row("HDP", format!("v{}", protocol::HDP_VERSION));
    match cfg.links.as_slice() {
        [] => row("DEVICE", config::Source::None.describe()),
        [one] => {
            row("DEVICE", one.source.describe());
            row("ORIGIN", one.origin.as_str());
            if one.source == config::Source::Host {
                row(
                    "NET WATCH",
                    "off until the interface starts it: reads link, address, routes; sends nothing",
                );
            }
        }
        many => {
            for (n, l) in many.iter().enumerate() {
                row(
                    &format!("DOG D{}", n + 1),
                    format!("{} ({})", l.source.describe(), l.origin.as_str()),
                );
            }
        }
    }
    row("DATA", cfg.data_dir.display());
    row("SESSIONS", store.sessions().len());
    row("STATE", "READY");
    println!();

    let state = api::AppState {
        links: Arc::new(links),
        store,
        discovery,
        cfg: Arc::new(cfg),
    };
    let app = api::router(state);
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    // The peer address: the LAN guard tells this machine from the others.
    match axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    {
        Ok(()) => 0,
        Err(e) => fail(&e.to_string()),
    }
}

/// Minimal HTTP/1.1 GET to a local dogd: no HTTP client dependency.
async fn local_get(port: u16, path: &str) -> Result<serde_json::Value, String> {
    local_request(port, "GET", path, "").await.map(|(_, v)| v)
}

/// One request to a local dogd: (status, JSON body, or the text as a string).
async fn local_request(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
) -> Result<(u16, serde_json::Value), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| format!("no dogd on 127.0.0.1:{port} ({e})"))?;
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let value = serde_json::from_str(body)
        .unwrap_or_else(|_| serde_json::Value::String(body.trim().to_string()));
    Ok((status, value))
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
    let links = local_get(port, "/v1/links").await.unwrap_or_default();
    let links: Vec<serde_json::Value> = links
        .get("links")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();
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
    let device = |l: &serde_json::Value| match l.get("device").filter(|d| !d.is_null()) {
        Some(d) => format!("{} rev {} fw {}", s(d, "device"), s(d, "rev"), s(d, "fw")),
        None => "NONE".into(),
    };
    match links.as_slice() {
        [link] => {
            row("LINK", s(link, "state"));
            row("SOURCE", s(link, "source"));
            row("DEVICE", device(link));
        }
        many => {
            for l in many {
                row(
                    &format!("DOG {}", s(l, "dog")),
                    format!("{} {} {}", s(l, "state"), s(l, "source"), device(l)),
                );
            }
        }
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
        if let Some(by) = d.superseded_by {
            println!("{:<15}bound by the user to {by}", "");
        } else if let Some(a) = d.ambiguous_with {
            println!(
                "{:<15}looks like {a}: if it is one of them, dogd bind PORT HW-ID",
                ""
            );
        } else if let Some(h) = d.hint {
            println!(
                "{:<15}{h} matched by a weaker key only: dogd bind PORT {h} if they are the same",
                ""
            );
        }
        if d.serial.is_some() && !d.serial_trusted {
            println!(
                "{:<15}serial {} is shared by other units: not an identity",
                "",
                d.serial.as_deref().unwrap_or("")
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
        let resolution = match &store {
            Some(s) => s.preview(fp, &others, &[]),
            None => identity::resolve(fp, &identity::usable_serial(fp, &others), &[], &[]),
        };
        let who = match resolution {
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
            identity::Resolution::New {
                strength,
                basis,
                hint,
            } => match hint {
                Some(h) => format!(
                    "NEW {} ({basis}; {h} matches by a weaker key only: not merged)",
                    strength.as_str()
                ),
                None => format!("NEW {} ({basis})", strength.as_str()),
            },
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

/// dogd bind PORT HW-ID: the device attached on PORT is HW-ID. Through
/// the running dogd when there is one, else on the index directly.
async fn bind(args: &[String]) -> i32 {
    let usage = "usage: dogd bind PORT HW-ID";
    let (Some(port), Some(target)) = (args.first(), args.get(1)) else {
        return fail(usage);
    };
    if port.starts_with("--") || target.starts_with("--") {
        return fail(usage);
    }
    let path = format!("/v1/devices/{target}/bind");
    if let Ok((status, answer)) = local_request(port_arg(args), "PUT", &path, port).await {
        if status == 200 {
            println!(
                "{port}: {target} ({})",
                answer.get("basis").and_then(|b| b.as_str()).unwrap_or("")
            );
            return 0;
        }
        return fail(answer.as_str().unwrap_or("refused"));
    }
    // No dogd running: bind against a fresh listing.
    let store = match storage::Store::open(&data_dir(args)) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };
    let ports = tokio::task::spawn_blocking(device::list_ports)
        .await
        .unwrap_or_default();
    let fps: Vec<identity::Fingerprint> = ports.iter().map(discovery::fingerprint).collect();
    let Some(fp) = fps
        .iter()
        .find(|f| f.port.as_deref() == Some(port.as_str()))
    else {
        return fail(&format!("nothing attached on {port}"));
    };
    let others: Vec<identity::Fingerprint> =
        fps.iter().filter(|f| f.port != fp.port).cloned().collect();
    let current = match store.preview(fp, &others, &[]) {
        identity::Resolution::Known { id, .. } => Some(id),
        _ => None,
    };
    match store.bind(fp, &others, &[], current.as_deref(), target) {
        Ok(o) => {
            println!("{port}: {target} ({})", o.basis);
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

    /// The network checks of `--source host` (ping, resolve, connect) run
    /// only when the operator chose that source: nothing else starts them.
    #[test]
    fn network_checks_only_when_asked() {
        for file in [
            include_str!("main.rs").split("mod laws").next().unwrap(),
            include_str!("api/mod.rs"),
            include_str!("discovery.rs"),
            include_str!("identity/mod.rs"),
            include_str!("sessions/mod.rs"),
            include_str!("storage/mod.rs"),
        ] {
            assert!(
                !file.contains("hostnet::run"),
                "hostnet started outside the host source"
            );
        }
        let transport = include_str!("transport/mod.rs");
        assert_eq!(transport.matches("hostnet::run").count(), 1);
        assert!(transport.contains("Source::Host =>"));
    }
}
