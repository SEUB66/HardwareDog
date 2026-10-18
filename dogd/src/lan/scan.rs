//! The scan itself: each step bounded in time and in work. Called by
//! LanScanner::start on a task that a stop aborts.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

use super::parse::{self, Iface};
use super::{LanScanner, Observation, CONCURRENCY, MAX_HOSTS, SERVICE_PORTS};

const MDNS: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(224, 0, 0, 251), 5353);
const SSDP: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
const WSD: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 3702);

/// How long each step listens for answers.
const LISTEN: Duration = Duration::from_millis(2500);
const CONNECT: Duration = Duration::from_millis(700);
const READ: Duration = Duration::from_millis(1500);
/// A UPnP description larger than this is not read.
const DESCRIPTION_MAX: usize = 64 * 1024;
/// Descriptions fetched at most per scan.
const DESCRIPTIONS_MAX: usize = 32;

/// This computer's IPv4 interfaces. HWDOG_LAN_IP_JSON names a file with
/// `ip -j -4 addr show` output (tests, demos).
pub async fn interfaces() -> Option<Vec<Iface>> {
    if let Some(p) = std::env::var_os("HWDOG_LAN_IP_JSON") {
        return std::fs::read_to_string(p)
            .ok()
            .map(|t| parse::parse_ip_addr_json(&t));
    }
    if !cfg!(target_os = "linux") {
        return None;
    }
    let ip = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("ip")
            .args(["-j", "-4", "addr", "show"])
            .kill_on_drop(true)
            .output(),
    )
    .await;
    if let Ok(Ok(out)) = ip {
        if out.status.success() {
            return Some(parse::parse_ip_addr_json(&String::from_utf8_lossy(
                &out.stdout,
            )));
        }
    }
    // No iproute2: the connected routes, and the address the kernel would use on each.
    let text = std::fs::read_to_string("/proc/net/route").ok()?;
    Some(
        parse::parse_proc_route(&text)
            .into_iter()
            .filter_map(|(name, net, prefix)| {
                let probe = Ipv4Addr::from(u32::from(net).wrapping_add(1));
                let address = local_address(probe).filter(|a| parse::mask(*a, prefix) == net)?;
                Some(Iface {
                    name,
                    address,
                    prefix,
                    up: true,
                    private: parse::is_private(address),
                    loopback: false,
                })
            })
            .collect(),
    )
}

/// The address this computer would use to reach `to`: a connected UDP
/// socket, never written to. No packet leaves.
fn local_address(to: Ipv4Addr) -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect(SocketAddr::from((to, 9))).ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(a) if !a.is_unspecified() && !a.is_loopback() => Some(a),
        _ => None,
    }
}

fn obs(kind: &str, method: &str, iface: &Iface) -> Observation {
    Observation {
        kind: kind.into(),
        method: method.into(),
        iface: iface.name.clone(),
        ..Default::default()
    }
}

/// The whole scan. Ok: a one-line summary.
pub async fn run(
    me: Arc<LanScanner>,
    iface: Iface,
    methods: Vec<String>,
) -> Result<String, String> {
    let on = |m: &str| methods.iter().any(|x| x == m);
    // Every host seen in this scan, in the chosen network only.
    let mut hosts: BTreeSet<Ipv4Addr> = BTreeSet::new();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();

    if on("neighbors") {
        me.update(|s| s.step = Some("neighbors".into()));
        let n = neighbors(&me, &iface, &mut hosts);
        counts.insert("neighbors", n);
    }
    if on("mdns") {
        me.update(|s| s.step = Some("mdns".into()));
        let n = mdns(&me, &iface, &mut hosts).await;
        counts.insert("mdns", n);
    }
    if on("ssdp") {
        me.update(|s| s.step = Some("ssdp".into()));
        let n = ssdp(&me, &iface, &mut hosts).await;
        counts.insert("ssdp", n);
    }
    if on("wsd") {
        me.update(|s| s.step = Some("wsd".into()));
        let n = wsd(&me, &iface, &mut hosts).await;
        counts.insert("wsd", n);
    }
    if on("services") {
        me.update(|s| s.step = Some("services".into()));
        let n = services(&me, &iface, &hosts).await;
        counts.insert("services", n);
    }
    let parts: Vec<String> = counts.iter().map(|(k, v)| format!("{k} {v}")).collect();
    Ok(format!(
        "{} host(s) seen on {} · answers: {} · no answer excludes nothing",
        hosts.len(),
        iface.name,
        parts.join(", ")
    ))
}

/// Step 1: the kernel's neighbor table. Nothing is sent.
fn neighbors(me: &LanScanner, iface: &Iface, hosts: &mut BTreeSet<Ipv4Addr>) -> usize {
    let path = std::env::var_os("HWDOG_LAN_ARP")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/proc/net/arp".into());
    let Ok(text) = std::fs::read_to_string(&path) else {
        let mut o = obs("note", "neighbors", iface);
        o.fields.insert(
            "note".into(),
            format!("{} could not be read", path.display()),
        );
        me.push(o);
        return 0;
    };
    let mut n = 0;
    for nb in parse::parse_proc_arp(&text) {
        if nb.device != iface.name
            || !nb.complete
            || !iface.contains(nb.ip)
            || nb.ip == iface.address
        {
            continue;
        }
        hosts.insert(nb.ip);
        let mut o = obs("neighbor", "neighbors", iface);
        o.ip = Some(nb.ip.to_string());
        if let Some(mac) = &nb.mac {
            if parse::mac_is_local(mac) {
                o.fields.insert(
                    "mac_kind".into(),
                    "locally administered (often random): no manufacturer applies".into(),
                );
            } else if let Some(v) = me.oui().lookup(mac) {
                o.vendor = Some(v.to_string());
                o.vendor_source = me.oui().source.clone();
            }
        }
        o.mac = nb.mac;
        o.raw = text
            .lines()
            .find(|l| l.starts_with(&format!("{} ", nb.ip)))
            .map(parse::clip);
        me.push(o);
        n += 1;
    }
    n
}

/// A UDP socket bound to the interface's address, sending multicast out of it.
fn multicast_socket(iface: &Iface, ttl: u32) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_multicast_if_v4(&iface.address)?;
    s.set_multicast_ttl_v4(ttl)?;
    s.set_multicast_loop_v4(false)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::V4(SocketAddrV4::new(iface.address, 0)).into())?;
    UdpSocket::from_std(s.into())
}

/// Answers to a datagram for `wait`, from hosts of the chosen network only.
async fn listen(
    sock: &UdpSocket,
    iface: &Iface,
    wait: Duration,
    mut each: impl FnMut(Ipv4Addr, &[u8]),
) {
    let mut buf = vec![0u8; 9000];
    let deadline = tokio::time::Instant::now() + wait;
    let mut seen = 0usize;
    while seen < 2000 {
        match tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, SocketAddr::V4(from)))) => {
                seen += 1;
                if iface.contains(*from.ip()) && *from.ip() != iface.address {
                    each(*from.ip(), &buf[..n]);
                }
            }
            Ok(Ok(_)) | Ok(Err(_)) => continue,
            Err(_) => break,
        }
    }
}

fn note(me: &LanScanner, iface: &Iface, method: &str, text: String) {
    let mut o = obs("note", method, iface);
    o.fields.insert("note".into(), text);
    me.push(o);
}

/// Step 2: DNS-SD. The service types announced, then their instances.
async fn mdns(me: &LanScanner, iface: &Iface, hosts: &mut BTreeSet<Ipv4Addr>) -> usize {
    let sock = match multicast_socket(iface, 255) {
        Ok(s) => s,
        Err(e) => {
            note(me, iface, "mdns", format!("mDNS socket: {e}"));
            return 0;
        }
    };
    let mut types: Vec<String> = Vec::new();
    let mut answers: Vec<(Ipv4Addr, parse::MdnsAnswer)> = Vec::new();
    let Some(q) = parse::mdns_query(&[parse::SERVICES_ENUM]) else {
        return 0;
    };
    let _ = sock.send_to(&q, MDNS).await;
    listen(&sock, iface, Duration::from_millis(1500), |from, b| {
        if let Some(a) = parse::parse_mdns(b) {
            for t in &a.service_types {
                if !types.contains(t) && types.len() < 24 {
                    types.push(t.clone());
                }
            }
            answers.push((from, a));
        }
    })
    .await;
    for chunk in types.chunks(8) {
        let names: Vec<&str> = chunk.iter().map(String::as_str).collect();
        if let Some(q) = parse::mdns_query(&names) {
            let _ = sock.send_to(&q, MDNS).await;
        }
    }
    if !types.is_empty() {
        listen(&sock, iface, LISTEN, |from, b| {
            if let Some(a) = parse::parse_mdns(b) {
                answers.push((from, a));
            }
        })
        .await;
    }
    let mut n = 0;
    let mut said: BTreeSet<(Ipv4Addr, String)> = BTreeSet::new();
    for (from, a) in &answers {
        for (instance, stype) in &a.instances {
            let (target, port) = a
                .srv
                .get(instance)
                .cloned()
                .map_or((None, None), |(t, p)| (Some(t), Some(p)));
            let ip = target
                .as_ref()
                .and_then(|t| a.a.get(t))
                .copied()
                .filter(|ip| iface.contains(*ip))
                .unwrap_or(*from);
            if !said.insert((ip, instance.clone())) {
                continue;
            }
            hosts.insert(ip);
            let mut o = obs("mdns", "mdns", iface);
            o.ip = Some(ip.to_string());
            o.name = Some(instance.trim_end_matches(&format!(".{stype}")).to_string());
            o.service = Some(stype.clone());
            o.port = port;
            if let Some(t) = target {
                o.fields.insert("host".into(), t);
            }
            for (k, v) in a.txt.get(instance).into_iter().flatten().take(16) {
                o.fields.insert(format!("txt.{k}"), v.clone());
            }
            o.raw = Some(parse::clip(&format!(
                "{stype} {instance} -> {:?}",
                a.srv.get(instance)
            )));
            me.push(o);
            n += 1;
        }
        // a responder that only listed types still showed itself
        if a.instances.is_empty()
            && !a.service_types.is_empty()
            && said.insert((*from, String::new()))
        {
            hosts.insert(*from);
            let mut o = obs("mdns", "mdns", iface);
            o.ip = Some(from.to_string());
            o.service = Some(parse::SERVICES_ENUM.into());
            o.fields.insert("types".into(), a.service_types.join(" "));
            o.raw = Some(parse::clip(&a.service_types.join("\n")));
            me.push(o);
            n += 1;
        }
    }
    n
}

/// Step 3: SSDP, then each LOCATION's description (bounded).
async fn ssdp(me: &LanScanner, iface: &Iface, hosts: &mut BTreeSet<Ipv4Addr>) -> usize {
    let sock = match multicast_socket(iface, 2) {
        Ok(s) => s,
        Err(e) => {
            note(me, iface, "ssdp", format!("SSDP socket: {e}"));
            return 0;
        }
    };
    for _ in 0..2 {
        let _ = sock.send_to(parse::SSDP_SEARCH.as_bytes(), SSDP).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut seen: BTreeMap<(Ipv4Addr, String), (parse::SsdpAnswer, String)> = BTreeMap::new();
    listen(&sock, iface, Duration::from_millis(3000), |from, b| {
        let text = String::from_utf8_lossy(b);
        if let Some(a) = parse::parse_ssdp(&text) {
            let key = (from, a.usn.clone().or(a.st.clone()).unwrap_or_default());
            if seen.len() < 512 {
                seen.entry(key).or_insert((a, parse::clip(&text)));
            }
        }
    })
    .await;
    let mut locations: BTreeSet<String> = BTreeSet::new();
    let mut n = 0;
    for ((ip, _), (a, raw)) in &seen {
        hosts.insert(*ip);
        let mut o = obs("ssdp", "ssdp", iface);
        o.ip = Some(ip.to_string());
        o.service = a.st.clone();
        if let Some(s) = &a.server {
            o.fields.insert("server".into(), s.clone());
        }
        if let Some(u) = &a.usn {
            o.fields.insert("usn".into(), u.clone());
        }
        if let Some(l) = &a.location {
            o.fields.insert("location".into(), l.clone());
            if parse::split_http_url(l).is_some_and(|(h, _, _)| h == *ip && iface.contains(h))
                && locations.len() < DESCRIPTIONS_MAX
            {
                locations.insert(l.clone());
            }
        }
        o.raw = Some(raw.clone());
        me.push(o);
        n += 1;
    }
    // The descriptions, four at a time. A JoinSet: when the scan is stopped
    // (its task aborted), dropping the set aborts every fetch still running.
    let sem = Arc::new(tokio::sync::Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for loc in locations {
        let sem = sem.clone();
        tasks.spawn(async move {
            let _permit = sem.acquire().await.ok()?;
            let (host, port, path) = parse::split_http_url(&loc)?;
            let body = http_get(host, port, &path).await?;
            Some((
                host,
                loc,
                parse::parse_upnp_description(&body),
                parse::clip(&body),
            ))
        });
    }
    while let Some(t) = tasks.join_next().await {
        if let Ok(Some((host, loc, desc, raw))) = t {
            let mut o = obs("upnp", "ssdp", iface);
            o.ip = Some(host.to_string());
            o.fields.insert("location".into(), loc);
            match desc {
                Some(d) => {
                    o.name = d.friendly_name;
                    o.service = d.device_type;
                    for (k, v) in [
                        ("manufacturer", d.manufacturer),
                        ("model_name", d.model_name),
                        ("model_number", d.model_number),
                    ] {
                        if let Some(v) = v {
                            o.fields.insert(k.into(), v);
                        }
                    }
                }
                None => {
                    o.fields.insert(
                        "note".into(),
                        "the description could not be read as UPnP XML".into(),
                    );
                }
            }
            o.raw = Some(raw);
            me.push(o);
        }
    }
    n
}

/// A small, bounded HTTP/1.1 GET to a device on the network: the body, or None.
async fn http_get(host: Ipv4Addr, port: u16, path: &str) -> Option<String> {
    let mut s = tokio::time::timeout(CONNECT, TcpStream::connect((host, port)))
        .await
        .ok()?
        .ok()?;
    let path: String = path.chars().filter(|c| !c.is_control()).take(512).collect();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nUser-Agent: hwdog-dogd/1\r\n\r\n");
    tokio::time::timeout(READ, s.write_all(req.as_bytes()))
        .await
        .ok()?
        .ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while buf.len() < DESCRIPTION_MAX {
        match tokio::time::timeout_at(deadline, s.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n.min(DESCRIPTION_MAX - buf.len())]),
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.") || !head.split_whitespace().nth(1).is_some_and(|c| c == "200") {
        return None;
    }
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        return Some(dechunk(body));
    }
    Some(body.to_string())
}

/// A chunked body, as far as it is well formed.
pub fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16) else {
            break;
        };
        if n == 0 || after.len() < n || !after.is_char_boundary(n) {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].strip_prefix("\r\n").unwrap_or(&after[n..]);
    }
    out
}

/// Step 4: ONVIF WS-Discovery.
async fn wsd(me: &LanScanner, iface: &Iface, hosts: &mut BTreeSet<Ipv4Addr>) -> usize {
    let sock = match multicast_socket(iface, 1) {
        Ok(s) => s,
        Err(e) => {
            note(me, iface, "wsd", format!("WS-Discovery socket: {e}"));
            return 0;
        }
    };
    // One MessageID per probe: devices drop a message whose id they already saw.
    for (i, types) in ["dn:NetworkVideoTransmitter", "tds:Device"]
        .iter()
        .enumerate()
    {
        let id = format!(
            "{:08x}-4864-4000-800{i}-{:012x}",
            crate::ble::wall_ms() as u32,
            me.mono_ms()
        );
        let _ = sock
            .send_to(parse::wsd_probe(&id, types).as_bytes(), WSD)
            .await;
    }
    let mut got: BTreeMap<(Ipv4Addr, String), (parse::WsdMatch, String)> = BTreeMap::new();
    listen(&sock, iface, Duration::from_millis(3000), |from, b| {
        let text = String::from_utf8_lossy(b);
        for m in parse::parse_wsd(&text) {
            if got.len() < 256 {
                let key = (from, m.endpoint.clone().unwrap_or_default());
                got.entry(key).or_insert((m, parse::clip(&text)));
            }
        }
    })
    .await;
    let mut n = 0;
    for ((from, _), (m, raw)) in got {
        // the device's own address in XAddrs, when it is in this network
        let ip = m
            .xaddrs
            .iter()
            .filter_map(|x| parse::xaddr_host(x))
            .find(|h| iface.contains(*h))
            .unwrap_or(from);
        hosts.insert(ip);
        let mut o = obs("wsd", "wsd", iface);
        o.ip = Some(ip.to_string());
        o.name = m.name.clone();
        o.service = Some(m.types.join(" "));
        if let Some(h) = &m.hardware {
            o.fields.insert("hardware".into(), h.clone());
        }
        if let Some(e) = &m.endpoint {
            o.fields.insert("endpoint".into(), e.clone());
        }
        o.fields.insert("scopes".into(), m.scopes.join(" "));
        o.fields.insert("xaddrs".into(), m.xaddrs.join(" "));
        o.raw = Some(raw);
        me.push(o);
        n += 1;
    }
    n
}

/// Step 5: a short list of ports on hosts that showed themselves.
async fn services(me: &Arc<LanScanner>, iface: &Iface, hosts: &BTreeSet<Ipv4Addr>) -> usize {
    let targets: Vec<Ipv4Addr> = hosts
        .iter()
        .copied()
        .filter(|h| iface.contains(*h) && *h != iface.address)
        .take(MAX_HOSTS)
        .collect();
    if hosts.len() > MAX_HOSTS {
        note(
            me,
            iface,
            "services",
            format!(
                "{} hosts seen: only the first {MAX_HOSTS} were checked",
                hosts.len()
            ),
        );
    }
    let total = (targets.len() * SERVICE_PORTS.len()) as u64;
    me.update(|s| {
        s.done = 0;
        s.total = Some(total);
    });
    if targets.is_empty() {
        note(
            me,
            iface,
            "services",
            "no host showed itself: nothing to check (no answer excludes nothing)".into(),
        );
        return 0;
    }
    let sem = Arc::new(tokio::sync::Semaphore::new(CONCURRENCY));
    // A JoinSet, so that a stop (the scan's task aborted) aborts every check still running.
    let mut tasks = tokio::task::JoinSet::new();
    for host in targets {
        for (port, proto) in SERVICE_PORTS {
            let sem = sem.clone();
            let me = me.clone();
            let iface = iface.clone();
            tasks.spawn(async move {
                let _permit = sem.acquire().await.ok()?;
                let res = check(host, port, proto).await;
                me.update(|s| s.done += 1);
                let (rtsp, raw) = res?;
                let mut o = obs("service", "services", &iface);
                o.ip = Some(host.to_string());
                o.port = Some(port);
                o.service = Some(proto.into());
                o.fields
                    .insert("state".into(), "open (TCP connection accepted)".into());
                if let Some(r) = rtsp {
                    o.fields.insert("rtsp_status".into(), r.status);
                    if let Some(s) = r.server {
                        o.fields.insert("server".into(), s);
                    }
                    if let Some(p) = r.public {
                        o.fields.insert("public".into(), p);
                    }
                }
                o.raw = raw;
                me.push(o);
                Some(())
            });
        }
    }
    let mut open = 0;
    while let Some(t) = tasks.join_next().await {
        if let Ok(Some(())) = t {
            open += 1;
        }
    }
    open
}

/// One port: None when nothing accepted the connection in time. For RTSP,
/// the OPTIONS answer (RFC 2326 10.1): methods and server, nothing more.
async fn check(
    host: Ipv4Addr,
    port: u16,
    proto: &str,
) -> Option<(Option<parse::RtspAnswer>, Option<String>)> {
    let mut s = tokio::time::timeout(CONNECT, TcpStream::connect((host, port)))
        .await
        .ok()?
        .ok()?;
    if proto != "rtsp" {
        return Some((None, None));
    }
    let req = format!(
        "OPTIONS rtsp://{host}:{port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: hwdog-dogd/1\r\n\r\n"
    );
    if tokio::time::timeout(READ, s.write_all(req.as_bytes()))
        .await
        .is_err()
    {
        return Some((None, None));
    }
    let mut buf = vec![0u8; 4096];
    let n = match tokio::time::timeout(READ, s.read(&mut buf)).await {
        Ok(Ok(n)) => n,
        _ => 0,
    };
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    Some((
        parse::parse_rtsp(&text),
        (n > 0).then(|| parse::clip(&text)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A fake RTSP server: answers OPTIONS, and records what it was sent.
    async fn rtsp_server(answer: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(answer.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (port, h)
    }

    #[tokio::test]
    async fn rtsp_is_asked_options_only_and_its_answer_kept() {
        let (port, sent) = rtsp_server(
            "RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: TestCam/1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n",
        )
        .await;
        let (rtsp, raw) = check(Ipv4Addr::LOCALHOST, port, "rtsp").await.unwrap();
        let rtsp = rtsp.unwrap();
        assert_eq!(rtsp.server.as_deref(), Some("TestCam/1"));
        assert!(raw.unwrap().starts_with("RTSP/1.0 200"));
        let req = sent.await.unwrap();
        // one OPTIONS, no credentials, no DESCRIBE / SETUP / PLAY
        assert!(req.starts_with("OPTIONS rtsp://127.0.0.1:"));
        for word in ["DESCRIBE", "SETUP", "PLAY", "Authorization"] {
            assert!(!req.contains(word), "{word} sent");
        }
    }

    #[tokio::test]
    async fn a_closed_port_is_no_answer_and_a_mute_server_is_still_open() {
        // nothing listens on the port just freed
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(check(Ipv4Addr::LOCALHOST, port, "rtsp").await.is_none());
        // accepts, never answers: open, nothing read, within the read deadline
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let _keep = tokio::spawn(async move {
            let (_s, _) = l.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let t = std::time::Instant::now();
        let (rtsp, raw) = check(Ipv4Addr::LOCALHOST, port, "rtsp").await.unwrap();
        assert!(rtsp.is_none() && raw.is_none());
        assert!(t.elapsed() < Duration::from_secs(3));
        // a web port is a TCP connection only: nothing is sent
        let (port, sent) = rtsp_server("").await;
        let _ = check(Ipv4Addr::LOCALHOST, port, "http").await.unwrap();
        drop(sent);
    }
}
