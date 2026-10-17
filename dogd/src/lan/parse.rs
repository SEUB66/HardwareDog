//! What the Camera Sniffer reads, parsed. Pure functions, no I/O: every
//! byte a neighbor sends is untrusted, so every parser here is bounded,
//! never panics, and keeps what it could not read as "unknown" rather than
//! guessing.
//!
//!   interfaces   `ip -j -4 addr show` (iproute2's JSON)
//!   neighbors    /proc/net/arp (the kernel's IPv4 neighbor table)
//!   OUI          the system's IEEE registry file, when one is installed
//!   mDNS         DNS-SD answers (RFC 6762 / RFC 6763), via simple-dns
//!   SSDP         M-SEARCH answers (UPnP Device Architecture 2.0, 1.3)
//!   UPnP         the device description a LOCATION points at
//!   WS-Discovery ProbeMatch (WS-Discovery 1.1; ONVIF Core 7: Types, Scopes, XAddrs)
//!   RTSP         the status line and headers of an OPTIONS answer (RFC 2326 10.1)

use std::collections::BTreeMap;
use std::net::Ipv4Addr;

use serde::Serialize;

/// The most a peer's text is kept as evidence (the raw answer shown to people).
pub const RAW_MAX: usize = 2048;

/// Keep at most RAW_MAX bytes of an answer, cut on a character boundary.
pub fn clip(s: &str) -> String {
    if s.len() <= RAW_MAX {
        return s.to_string();
    }
    let mut end = RAW_MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

// ------------------------------------------------------------ interfaces

/// One IPv4 address of one interface.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Iface {
    pub name: String,
    pub address: Ipv4Addr,
    pub prefix: u8,
    pub up: bool,
    /// Private (RFC 1918) or link-local: the only networks a scan may target.
    pub private: bool,
    pub loopback: bool,
}

impl Iface {
    pub fn network(&self) -> Ipv4Addr {
        mask(self.address, self.prefix)
    }
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        mask(ip, self.prefix) == self.network()
    }
}

pub fn mask(ip: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let p = prefix.min(32) as u32;
    let m = if p == 0 { 0 } else { u32::MAX << (32 - p) };
    Ipv4Addr::from(u32::from(ip) & m)
}

pub fn is_private(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// iproute2's `ip -j -4 addr show`. Unknown shapes are skipped, never fatal.
pub fn parse_ip_addr_json(text: &str) -> Vec<Iface> {
    let Ok(serde_json::Value::Array(links)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for l in links {
        let Some(name) = l.get("ifname").and_then(|v| v.as_str()) else {
            continue;
        };
        let flags: Vec<&str> = l
            .get("flags")
            .and_then(|f| f.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let up =
            flags.contains(&"UP") && l.get("operstate").and_then(|v| v.as_str()) != Some("DOWN");
        let loopback = flags.contains(&"LOOPBACK");
        for a in l
            .get("addr_info")
            .and_then(|a| a.as_array())
            .into_iter()
            .flatten()
        {
            if a.get("family").and_then(|v| v.as_str()) != Some("inet") {
                continue;
            }
            let (Some(local), Some(prefix)) = (
                a.get("local")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<Ipv4Addr>().ok()),
                a.get("prefixlen").and_then(|v| v.as_u64()),
            ) else {
                continue;
            };
            if prefix > 32 {
                continue;
            }
            out.push(Iface {
                name: name.to_string(),
                address: local,
                prefix: prefix as u8,
                up,
                private: is_private(local),
                loopback,
            });
        }
    }
    out
}

/// The directly connected IPv4 networks of /proc/net/route (no gateway,
/// route up, not the default route): interface, network, prefix. The
/// fallback when iproute2 is not installed; the local address then comes
/// from the kernel (a connected UDP socket, nothing sent).
pub fn parse_proc_route(text: &str) -> Vec<(String, Ipv4Addr, u8)> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 8 {
            continue;
        }
        let hex = |s: &str| {
            u32::from_str_radix(s, 16)
                .ok()
                .map(|v| Ipv4Addr::from(v.swap_bytes()))
        };
        let (Some(dest), Some(gw), Some(mask)) = (hex(f[1]), hex(f[2]), hex(f[7])) else {
            continue;
        };
        let flags = u32::from_str_radix(f[3], 16).unwrap_or(0);
        let m = u32::from(mask);
        // a real netmask is contiguous ones
        if flags & 0x1 == 0 || !gw.is_unspecified() || m == 0 || m.leading_ones() != m.count_ones()
        {
            continue;
        }
        out.push((f[0].to_string(), dest, m.count_ones() as u8));
    }
    out
}

/// Why a scan of this interface is refused, or None when it may run.
/// Only a private or link-local network the computer is on, never
/// wider than a /16 (the scan itself never sweeps it: it asks the
/// segment and checks only hosts that showed themselves).
pub fn refuse(iface: &Iface) -> Option<&'static str> {
    if iface.loopback {
        return Some("loopback: there is no network to look at");
    }
    if !iface.up {
        return Some("this interface is down");
    }
    if !iface.private {
        return Some("not a private network (RFC 1918 or link-local): Camera Sniffer only looks at the local network you are on");
    }
    if iface.prefix < 16 {
        return Some("wider than a /16: refused");
    }
    None
}

// ------------------------------------------------------------- neighbors

/// One line of the kernel's neighbor table.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Neighbor {
    pub ip: Ipv4Addr,
    pub mac: Option<String>,
    pub device: String,
    /// The kernel had a complete entry (ATF_COM): the host answered ARP recently.
    pub complete: bool,
}

/// /proc/net/arp:
/// `IP address  HW type  Flags  HW address  Mask  Device`
pub fn parse_proc_arp(text: &str) -> Vec<Neighbor> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let Ok(ip) = f[0].parse::<Ipv4Addr>() else {
            continue;
        };
        let flags = u32::from_str_radix(f[2].trim_start_matches("0x"), 16).unwrap_or(0);
        let mac = normalize_mac(f[3]).filter(|m| m != "00:00:00:00:00:00");
        out.push(Neighbor {
            ip,
            mac,
            device: f[5].to_string(),
            complete: flags & 0x2 != 0,
        });
    }
    out
}

/// "AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff"... to "aa:bb:cc:dd:ee:ff".
pub fn normalize_mac(s: &str) -> Option<String> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12
        || s.chars()
            .any(|c| !(c.is_ascii_hexdigit() || ":-.".contains(c)))
    {
        return None;
    }
    let h = hex.to_ascii_lowercase();
    Some(
        (0..6)
            .map(|i| &h[i * 2..i * 2 + 2])
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// A locally administered address (second bit of the first octet): set by
/// software, often random (phones on Wi-Fi). No manufacturer can be read.
pub fn mac_is_local(mac: &str) -> bool {
    u8::from_str_radix(mac.get(0..2).unwrap_or("00"), 16).is_ok_and(|b| b & 0x02 != 0)
}

// ------------------------------------------------------------------- OUI

/// The manufacturer registry, from a file the system has. Formats read:
/// IEEE `oui.txt` ("AC-DE-48   (hex)\t\tVendor"), arp-scan `ieee-oui.txt`
/// and nmap `nmap-mac-prefixes` ("ACDE48 Vendor" / "ACDE48\tVendor").
#[derive(Default)]
pub struct Oui {
    map: std::collections::HashMap<String, String>,
    pub source: Option<String>,
}

impl Oui {
    pub fn parse(text: &str, source: &str) -> Self {
        let mut map = std::collections::HashMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (prefix, vendor) = if let Some((p, v)) = line.split_once("(hex)") {
                (p.trim().replace('-', ""), v.trim())
            } else {
                match line.split_once(['\t', ' ']) {
                    Some((p, v)) => (p.trim().to_string(), v.trim()),
                    None => continue,
                }
            };
            if prefix.len() == 6
                && prefix.chars().all(|c| c.is_ascii_hexdigit())
                && !vendor.is_empty()
            {
                map.entry(prefix.to_ascii_uppercase())
                    .or_insert_with(|| vendor.to_string());
            }
        }
        Oui {
            map,
            source: Some(source.to_string()),
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// The registered owner of the MAC's prefix. None for a locally
    /// administered address (no registry applies) or an unknown prefix.
    pub fn lookup(&self, mac: &str) -> Option<&str> {
        if mac_is_local(mac) {
            return None;
        }
        let key: String = mac
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .take(6)
            .collect::<String>()
            .to_ascii_uppercase();
        self.map.get(&key).map(String::as_str)
    }
}

// ------------------------------------------------------------------ mDNS

/// What a DNS-SD answer said: services, their instances, targets, ports,
/// TXT attributes, and addresses. All names lower-cased as DNS is.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct MdnsAnswer {
    /// "_rtsp._tcp.local" from the _services._dns-sd._udp.local enumeration.
    pub service_types: Vec<String>,
    /// instance -> its service type ("Front door._rtsp._tcp.local" -> "_rtsp._tcp.local")
    pub instances: BTreeMap<String, String>,
    /// instance -> (target host, port)
    pub srv: BTreeMap<String, (String, u16)>,
    /// instance -> key=value
    pub txt: BTreeMap<String, BTreeMap<String, String>>,
    /// host name -> IPv4
    pub a: BTreeMap<String, Ipv4Addr>,
}

pub const SERVICES_ENUM: &str = "_services._dns-sd._udp.local";

/// A one-shot mDNS query (id 0, as RFC 6762 18.1 asks) for PTR records of
/// the given names. Sent from a port that is not 5353, it is a "legacy
/// unicast" query: responders answer to that port directly (RFC 6762 6.7).
pub fn mdns_query(names: &[&str]) -> Option<Vec<u8>> {
    use simple_dns::{Name, Packet, Question, CLASS, QCLASS, QTYPE, TYPE};
    let mut p = Packet::new_query(0);
    for n in names {
        let name = Name::new(n).ok()?;
        p.questions.push(Question::new(
            name,
            QTYPE::TYPE(TYPE::PTR),
            QCLASS::CLASS(CLASS::IN),
            false,
        ));
    }
    p.build_bytes_vec().ok()
}

/// Every record of an mDNS packet we use. A malformed packet is None.
pub fn parse_mdns(bytes: &[u8]) -> Option<MdnsAnswer> {
    use simple_dns::rdata::RData;
    let p = simple_dns::Packet::parse(bytes).ok()?;
    let mut out = MdnsAnswer::default();
    for rr in p.answers.iter().chain(p.additional_records.iter()) {
        let owner = rr.name.to_string().to_ascii_lowercase();
        match &rr.rdata {
            RData::PTR(ptr) => {
                let target = ptr.0.to_string();
                if owner == SERVICES_ENUM {
                    let t = target.to_ascii_lowercase();
                    if !out.service_types.contains(&t) && out.service_types.len() < 64 {
                        out.service_types.push(t);
                    }
                } else if owner.starts_with('_') && out.instances.len() < 256 {
                    // keep the instance's case for people: "Living Room TV._airplay._tcp.local"
                    out.instances.insert(target, owner);
                }
            }
            RData::SRV(srv) => {
                out.srv.insert(
                    rr.name.to_string(),
                    (srv.target.to_string().to_ascii_lowercase(), srv.port),
                );
            }
            RData::TXT(txt) => {
                let mut kv = BTreeMap::new();
                for (k, v) in txt.attributes().into_iter().take(32) {
                    kv.insert(
                        k.chars().take(64).collect(),
                        v.unwrap_or_default().chars().take(256).collect(),
                    );
                }
                out.txt.insert(rr.name.to_string(), kv);
            }
            RData::A(a) => {
                out.a.insert(owner, Ipv4Addr::from(a.address));
            }
            _ => {}
        }
    }
    Some(out)
}

// ------------------------------------------------------------------ SSDP

pub const SSDP_SEARCH: &str = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\nUSER-AGENT: Linux/1 UPnP/2.0 hwdog-dogd/1\r\n\r\n";

/// An M-SEARCH answer: status line 200 and its headers (upper-cased names).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SsdpAnswer {
    pub location: Option<String>,
    pub server: Option<String>,
    pub st: Option<String>,
    pub usn: Option<String>,
}

pub fn parse_ssdp(text: &str) -> Option<SsdpAnswer> {
    let mut lines = text.split("\r\n").flat_map(|l| l.split('\n'));
    let status = lines.next()?.trim();
    if !(status.starts_with("HTTP/1.1 200")
        || status.starts_with("HTTP/1.0 200")
        || status.starts_with("NOTIFY"))
    {
        return None;
    }
    let mut a = SsdpAnswer::default();
    for l in lines.take(64) {
        let Some((k, v)) = l.split_once(':') else {
            continue;
        };
        let v = v.trim().chars().take(512).collect::<String>();
        match k.trim().to_ascii_uppercase().as_str() {
            "LOCATION" => a.location = Some(v),
            "SERVER" => a.server = Some(v),
            "ST" | "NT" => a.st = Some(v),
            "USN" => a.usn = Some(v),
            _ => {}
        }
    }
    Some(a)
}

/// The host and port of an http://host:port/path LOCATION, and its path.
pub fn split_http_url(url: &str) -> Option<(Ipv4Addr, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (hostport, path) = rest
        .split_once('/')
        .map_or((rest, "/".to_string()), |(h, p)| (h, format!("/{p}")));
    let (host, port) = hostport
        .split_once(':')
        .map_or((hostport, Some(80)), |(h, p)| (h, p.parse().ok()));
    Some((host.parse().ok()?, port?, path))
}

/// The parts of a UPnP device description people need.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct UpnpDevice {
    pub device_type: Option<String>,
    pub friendly_name: Option<String>,
    pub manufacturer: Option<String>,
    pub model_name: Option<String>,
    pub model_number: Option<String>,
}

pub fn parse_upnp_description(xml: &str) -> Option<UpnpDevice> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let device = doc
        .descendants()
        .find(|n| n.tag_name().name() == "device")?;
    let field = |name: &str| {
        device
            .children()
            .find(|n| n.tag_name().name() == name)
            .and_then(|n| n.text())
            .map(|t| t.trim().chars().take(200).collect::<String>())
            .filter(|t| !t.is_empty())
    };
    Some(UpnpDevice {
        device_type: field("deviceType"),
        friendly_name: field("friendlyName"),
        manufacturer: field("manufacturer"),
        model_name: field("modelName"),
        model_number: field("modelNumber"),
    })
}

// ---------------------------------------------------------- WS-Discovery

/// A WS-Discovery Probe for ONVIF devices (ONVIF Core Specification 7.3):
/// `dn:NetworkVideoTransmitter`, the type ONVIF video devices announce.
pub fn wsd_probe(message_id: &str, types: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" "#,
            r#"xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">"#,
            r#"<e:Header><w:MessageID>uuid:{id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"#,
            r#"<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>"#,
            r#"<e:Body><d:Probe><d:Types>{types}</d:Types></d:Probe></e:Body></e:Envelope>"#
        ),
        id = message_id,
        types = types
    )
}

/// One ProbeMatch: what an ONVIF device says it is. Scopes are kept as
/// given; `name` and `hardware` are read from the onvif://www.onvif.org/
/// scopes when present (they are the device's own words, not verified).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct WsdMatch {
    pub endpoint: Option<String>,
    pub types: Vec<String>,
    pub scopes: Vec<String>,
    pub xaddrs: Vec<String>,
    pub name: Option<String>,
    pub hardware: Option<String>,
}

pub fn parse_wsd(xml: &str) -> Vec<WsdMatch> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    let words = |n: roxmltree::Node, tag: &str| -> Vec<String> {
        n.descendants()
            .find(|c| c.tag_name().name() == tag)
            .and_then(|c| c.text())
            .map(|t| {
                t.split_whitespace()
                    .take(64)
                    .map(|w| w.chars().take(300).collect())
                    .collect()
            })
            .unwrap_or_default()
    };
    doc.descendants()
        .filter(|n| n.tag_name().name() == "ProbeMatch")
        .take(32)
        .map(|m| {
            let scopes = words(m, "Scopes");
            let scope = |kind: &str| {
                scopes.iter().find_map(|s| {
                    s.strip_prefix(&format!("onvif://www.onvif.org/{kind}/"))
                        .map(percent_decode)
                })
            };
            WsdMatch {
                endpoint: m
                    .descendants()
                    .find(|c| c.tag_name().name() == "Address")
                    .and_then(|c| c.text())
                    .map(|t| t.trim().chars().take(200).collect()),
                types: words(m, "Types"),
                xaddrs: words(m, "XAddrs"),
                name: scope("name"),
                hardware: scope("hardware"),
                scopes,
            }
        })
        .collect()
}

/// %20 and friends in scope values; anything malformed is kept as is.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |c: u8| (c as char).to_digit(16);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The IPv4 host of an XAddr ("http://192.168.1.20/onvif/device_service").
pub fn xaddr_host(x: &str) -> Option<Ipv4Addr> {
    let rest = x
        .strip_prefix("http://")
        .or_else(|| x.strip_prefix("https://"))?;
    let host = rest.split(['/', ':']).next()?;
    host.parse().ok()
}

// ------------------------------------------------------------------ RTSP

/// What an RTSP OPTIONS answer says about the server: status line, Server
/// header and the methods it lists. No stream is described or opened.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RtspAnswer {
    pub status: String,
    pub server: Option<String>,
    pub public: Option<String>,
}

pub fn parse_rtsp(text: &str) -> Option<RtspAnswer> {
    let mut lines = text.lines();
    let status = lines.next()?.trim();
    if !status.starts_with("RTSP/") {
        return None;
    }
    let mut a = RtspAnswer {
        status: status.chars().take(80).collect(),
        ..Default::default()
    };
    for l in lines.take(32) {
        if let Some((k, v)) = l.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "server" => a.server = Some(v.trim().chars().take(200).collect()),
                "public" => a.public = Some(v.trim().chars().take(200).collect()),
                _ => {}
            }
        }
    }
    Some(a)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
