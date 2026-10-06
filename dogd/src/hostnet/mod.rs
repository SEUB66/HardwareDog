//! `--source host`: this computer, as a Hardware Dog for the network.
//!
//! No probe needed. A small device lives inside dogd and speaks HDP v1
//! like a probe would, with the capabilities it really has: `net` and
//! `probe`. It reads what the operating system knows (link, address,
//! default gateway, name server), and runs the same checks a probe runs
//! (net.watch: four pings to the gateway, a name resolved, a TCP
//! connection to port 443 beyond it; probe: PING, DNS, TCP, HTTP), from
//! this computer. The interface decodes its frames like any other's.
//!
//! It is a device, not the bridge: the bridge still forwards bytes it
//! never reads (protocol.rs). What this device says, it measured; what it
//! cannot know, it says UNKNOWN (no link state on Windows, no name server
//! outside resolv.conf).

pub mod parse;
mod system;

use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream};

pub use parse::Ping;
pub use system::System;

/// The device id in its hello: the source of these frames is this computer.
pub const HOST_DEVICE: &str = "HOST";
/// What a watch checks when the interface asks without details: one round
/// every 10 s, a name to resolve, a host to reach on 443. Until net.watch
/// says so, nothing ACTIVE runs: dogd only reads what the system knows.
pub const DEFAULT_EVERY_MS: u64 = 10_000;
pub const DEFAULT_DNS: &str = "example.com";
pub const DEFAULT_UPSTREAM: &str = "example.com";
/// Below this, a watch is refused: the network is not a benchmark.
pub const MIN_EVERY_MS: u64 = 1_000;

/// What the system knows about its network, read without sending anything.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Observation {
    /// None: this system does not say (Windows), or has no interface.
    pub link: Option<Link>,
    pub address: Option<Ipv4Addr>,
    pub gateway: Option<Ipv4Addr>,
    pub dns_server: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub up: bool,
    pub mbps: Option<f64>,
    pub duplex: Option<&'static str>,
}

/// The ACTIVE checks of one net.watch round. None: not run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Checks {
    /// None: no gateway to ping, or ping could not run.
    pub gateway: Option<Ping>,
    /// Some(true): the name resolved.
    pub dns: Option<bool>,
    /// Some(Some(true)): connected to upstream:443. Some(None): the name did
    /// not resolve, a DNS answer, not an upstream one.
    pub internet: Option<Option<bool>>,
}

/// The side effects, behind one door: the real system, or a test's.
pub trait Net: Send + Sync + 'static {
    fn observe(&self) -> impl std::future::Future<Output = Observation> + Send;
    /// Four pings. None: ping could not run here.
    fn ping(&self, to: Ipv4Addr) -> impl std::future::Future<Output = Option<Ping>> + Send;
    fn resolve(&self, name: &str) -> impl std::future::Future<Output = Option<Ipv4Addr>> + Send;
    /// A TCP connection within 3 s. Err(()) when the name does not resolve.
    fn connect(
        &self,
        host: &str,
        port: u16,
    ) -> impl std::future::Future<Output = Result<bool, ()>> + Send;
    /// The status line of `GET /` on port 80, if any.
    fn http_status(
        &self,
        host: &str,
    ) -> impl std::future::Future<Output = Result<Option<String>, ()>> + Send;
}

/// net.status from what was observed and checked. Pure: tested as is.
pub fn net_status(t: u64, obs: &Observation, checks: &Checks, ran: bool) -> Value {
    let link = obs
        .link
        .as_ref()
        .map(|l| json!({ "up": l.up, "mbps": l.mbps, "duplex": l.duplex }));
    let link_up = obs.link.as_ref().map(|l| l.up);
    // DHCP: an address that is not link-local. dogd cannot tell DHCP from a
    // static address: either way the computer has one (docs/DOGD.md).
    let dhcp = match (link_up, obs.address) {
        (Some(false), _) => "UNKNOWN",
        (_, Some(a)) if parse::is_link_local(a) => "FAIL",
        (_, Some(_)) => "PASS",
        (Some(true), None) => "FAIL",
        (None, None) => "UNKNOWN",
    };
    let has_address = obs.address.is_some_and(|a| !parse::is_link_local(a));
    let check = |c: Option<bool>| match c {
        Some(true) => "PASS",
        Some(false) => "FAIL",
        None => "UNKNOWN",
    };
    // Until a check ran, UNKNOWN, never guessed. An address and no route
    // out is a fact: the gateway fails.
    let gateway = if !ran || !has_address {
        "UNKNOWN"
    } else if obs.gateway.is_none() {
        "FAIL"
    } else {
        check(checks.gateway.map(|p| p.replies > 0))
    };
    let internet = if ran && has_address {
        check(checks.internet.flatten())
    } else {
        "UNKNOWN"
    };
    let dns = if ran && has_address {
        check(checks.dns)
    } else {
        "UNKNOWN"
    };
    json!({
        "type": "net.status",
        "t": t,
        "link": link,
        "address": obs.address.map(|a| a.to_string()),
        "dhcp": dhcp,
        "gateway": { "address": obs.gateway.map(|g| g.to_string()), "status": gateway },
        "dns": { "address": obs.dns_server, "status": dns },
        "internet": internet,
        "latency": if ran { checks.gateway.and_then(|p| p.avg_ms).map(|v| (v * 10.0).round() / 10.0) } else { None },
        "loss": if ran { checks.gateway.and_then(|p| p.loss_pct()) } else { None },
    })
}

/// The hello of this device.
pub fn hello(t: u64) -> Value {
    json!({
        "type": "hello", "t": t, "proto": 1, "device": HOST_DEVICE, "rev": "HOST",
        "fw": concat!("dogd-", env!("CARGO_PKG_VERSION")), "caps": ["net", "probe"],
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Watch {
    pub every_ms: u64,
    pub dns: Option<String>,
    pub upstream: Option<String>,
}

impl Watch {
    /// No ACTIVE check: the state at start, and after net.watch every_ms 0.
    pub fn off() -> Self {
        Watch {
            every_ms: 0,
            dns: None,
            upstream: None,
        }
    }
}

/// While the watch is off, how often the passive state is read and sent:
/// a cable pulled out shows within this, with nothing sent on the network.
const PASSIVE_EVERY_MS: u64 = 5_000;

impl Default for Watch {
    fn default() -> Self {
        Watch {
            every_ms: DEFAULT_EVERY_MS,
            dns: Some(DEFAULT_DNS.into()),
            upstream: Some(DEFAULT_UPSTREAM.into()),
        }
    }
}

/// One net.watch round: observe, then the ACTIVE checks.
pub async fn round<N: Net>(net: &N, w: &Watch) -> (Observation, Checks) {
    let obs = net.observe().await;
    let mut checks = Checks::default();
    if obs.address.is_some_and(|a| !parse::is_link_local(a)) {
        if let Some(gw) = obs.gateway {
            checks.gateway = net.ping(gw).await;
        }
        if let Some(name) = &w.dns {
            checks.dns = Some(net.resolve(name).await.is_some());
        }
        if let Some(host) = &w.upstream {
            checks.internet = Some(net.connect(host, 443).await.ok());
        }
    }
    (obs, checks)
}

/// The answers to one `probe` command, as a probe sends them.
pub async fn probe<N: Net>(
    net: &N,
    id: &str,
    target: &str,
    tests: &[String],
    t: impl Fn() -> u64,
) -> Vec<Value> {
    let mut out = Vec::new();
    let result = |test: &str, status: &str, detail: String, t: u64| json!({ "type": "probe.result", "t": t, "id": id, "test": test, "status": status, "detail": detail });
    for test in tests {
        let (status, detail) = match test.as_str() {
            "PING" => match net.resolve(target).await {
                None => ("FAIL", "name does not resolve".to_string()),
                Some(ip) => match net.ping(ip).await {
                    None => ("UNKNOWN", "ping could not run on this computer".to_string()),
                    Some(p) => (
                        if p.replies == p.sent {
                            "PASS"
                        } else if p.replies > 0 {
                            "WARN"
                        } else {
                            "FAIL"
                        },
                        match p.avg_ms {
                            Some(avg) => format!(
                                "{}/{} replies from {ip}, avg {} ms",
                                p.replies,
                                p.sent,
                                avg.round()
                            ),
                            None => format!("{}/{} replies from {ip}", p.replies, p.sent),
                        },
                    ),
                },
            },
            "DNS" => {
                if target.parse::<Ipv4Addr>().is_ok() {
                    (
                        "UNKNOWN",
                        "the target is an address: nothing to resolve".to_string(),
                    )
                } else {
                    match net.resolve(target).await {
                        Some(ip) => ("PASS", format!("resolved to {ip}")),
                        None => ("FAIL", "does not resolve".to_string()),
                    }
                }
            }
            "TCP" => match net.connect(target, 80).await {
                Err(()) => ("FAIL", "name does not resolve".to_string()),
                Ok(false) => ("FAIL", "port 80: no answer or refused".to_string()),
                Ok(true) => ("PASS", "port 80 open".to_string()),
            },
            "HTTP" => match net.http_status(target).await {
                Err(()) => ("FAIL", "name does not resolve".to_string()),
                Ok(None) => ("FAIL", "no HTTP answer on port 80".to_string()),
                Ok(Some(line)) => ("PASS", line),
            },
            other => ("UNKNOWN", format!("unknown test {other}")),
        };
        out.push(result(test, status, detail, t()));
    }
    out.push(json!({ "type": "probe.done", "t": t(), "id": id }));
    out
}

async fn send(w: &mut (impl AsyncWrite + Unpin), v: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(v).unwrap_or_default();
    line.push(b'\n');
    w.write_all(&line).await
}

fn log(t: u64, level: &str, message: impl Into<String>) -> Value {
    json!({ "type": "log", "t": t, "level": level, "message": message.into() })
}

/// The device: reads host commands from its end of the stream, writes
/// frames. Runs until the other end closes.
pub async fn run<N: Net>(net: N, stream: DuplexStream, mut watch: Watch) {
    let started = Instant::now();
    let t = move || started.elapsed().as_millis() as u64;
    let (r, mut w) = tokio::io::split(stream);
    let mut lines = BufReader::new(r).lines();
    // The first round at once: nobody should wait 10 s to see the network.
    let mut next = Instant::now();
    let mut probes: Vec<(String, String, Vec<String>)> = Vec::new();
    loop {
        // A probe asked for runs before the next watch round, one at a time.
        if let Some((id, target, tests)) = (!probes.is_empty()).then(|| probes.remove(0)) {
            for f in probe(&net, &id, &target, &tests, t).await {
                if send(&mut w, &f).await.is_err() {
                    return;
                }
            }
            continue;
        }
        let wait = next.saturating_duration_since(Instant::now());
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { return };
                let frames = match serde_json::from_str::<Value>(&line) {
                    Err(_) => vec![log(t(), "warn", "command refused: not JSON")],
                    Ok(cmd) => match cmd.get("cmd").and_then(Value::as_str) {
                        Some("hello") => {
                            next = Instant::now();
                            vec![hello(t())]
                        }
                        Some("time") => match cmd.get("id").and_then(Value::as_u64) {
                            Some(id) if id <= u64::from(u32::MAX) => vec![json!({ "type": "time", "t": t(), "id": id })],
                            _ => vec![log(t(), "warn", "time refused: id")],
                        },
                        Some("net.refresh") => {
                            next = Instant::now();
                            vec![]
                        }
                        Some("net.watch") => match parse_watch(&cmd) {
                            Ok(nw) => {
                                watch = nw;
                                next = Instant::now();
                                if watch.every_ms == 0 {
                                    let obs = net.observe().await;
                                    vec![net_status(t(), &obs, &Checks::default(), false)]
                                } else {
                                    vec![]
                                }
                            }
                            Err(e) => vec![log(t(), "warn", format!("net.watch refused: {e}"))],
                        },
                        Some("probe") => match parse_probe(&cmd) {
                            Ok(p) => {
                                probes.push(p);
                                vec![]
                            }
                            Err(e) => vec![log(t(), "warn", format!("probe refused: {e}"))],
                        },
                        Some(other) => vec![log(t(), "warn", format!("{other}: this computer does not observe that (caps: net, probe)"))],
                        None => vec![log(t(), "warn", "command refused: no cmd")],
                    },
                };
                for f in frames {
                    if send(&mut w, &f).await.is_err() {
                        return;
                    }
                }
            }
            _ = tokio::time::sleep(wait) => {
                let ran = watch.every_ms > 0;
                let (obs, checks) = if ran { round(&net, &watch).await } else { (net.observe().await, Checks::default()) };
                if send(&mut w, &net_status(t(), &obs, &checks, ran)).await.is_err() {
                    return;
                }
                let every = if ran { watch.every_ms.max(MIN_EVERY_MS) } else { PASSIVE_EVERY_MS };
                next = Instant::now() + Duration::from_millis(every);
            }
        }
    }
}

fn opt_name(cmd: &Value, key: &str) -> Result<Option<String>, String> {
    match cmd.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if parse::valid_target(s) => Ok(Some(s.clone())),
        Some(_) => Err(format!(
            "{key}: a host name (letters, digits, dots, dashes)"
        )),
    }
}

fn parse_watch(cmd: &Value) -> Result<Watch, String> {
    let every = cmd
        .get("every_ms")
        .and_then(Value::as_u64)
        .ok_or("every_ms")?;
    if every > 600_000 || (every != 0 && every < MIN_EVERY_MS) {
        return Err(format!("every_ms: 0, or {MIN_EVERY_MS} to 600000"));
    }
    Ok(Watch {
        every_ms: every,
        dns: opt_name(cmd, "dns")?,
        upstream: opt_name(cmd, "upstream")?,
    })
}

fn parse_probe(cmd: &Value) -> Result<(String, String, Vec<String>), String> {
    let id = cmd.get("id").and_then(Value::as_str).ok_or("id")?;
    let target = opt_name(cmd, "target")?.ok_or("target")?;
    let tests: Vec<String> = cmd
        .get("tests")
        .and_then(Value::as_array)
        .ok_or("tests")?
        .iter()
        .map(|v| v.as_str().map(str::to_string).ok_or("tests"))
        .collect::<Result<_, _>>()?;
    if tests.is_empty()
        || tests.len() > 8
        || !tests
            .iter()
            .all(|s| matches!(s.as_str(), "PING" | "DNS" | "TCP" | "HTTP"))
    {
        return Err("tests: 1 to 8 of PING, DNS, TCP, HTTP".into());
    }
    if id.is_empty() || id.len() > 32 {
        return Err("id".into());
    }
    Ok((id.to_string(), target, tests))
}

#[cfg(test)]
mod tests;
