//! Reading what the operating system says about the network. Pure
//! functions over text, so every format is tested without the machine.

use std::net::Ipv4Addr;

/// The default route, from Linux `/proc/net/route`: the interface and the
/// gateway. Addresses there are hex, little-endian.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_default_route(table: &str) -> Option<(String, Option<Ipv4Addr>)> {
    let mut best: Option<(u32, String, Option<Ipv4Addr>)> = None;
    for line in table.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 8 || f[1] != "00000000" || f[7] != "00000000" {
            continue;
        }
        let flags = u32::from_str_radix(f[3], 16).unwrap_or(0);
        // RTF_UP
        if flags & 0x1 == 0 {
            continue;
        }
        let metric: u32 = f[6].parse().unwrap_or(u32::MAX);
        let gw = u32::from_str_radix(f[2], 16)
            .ok()
            .filter(|g| *g != 0)
            .map(|g| Ipv4Addr::from(g.swap_bytes()));
        if best.as_ref().is_none_or(|(m, _, _)| metric < *m) {
            best = Some((metric, f[0].to_string(), gw));
        }
    }
    best.map(|(_, i, g)| (i, g))
}

/// macOS / BSD `route -n get default`: the gateway and the interface.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn bsd_route_get(out: &str) -> (Option<Ipv4Addr>, Option<String>) {
    let mut gw = None;
    let mut iface = None;
    for line in out.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("gateway:") {
            gw = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix("interface:") {
            iface = Some(v.trim().to_string());
        }
    }
    (gw, iface)
}

/// Windows `route print -4 0.0.0.0`: the active default route with the
/// lowest metric. The table is the same in every language: five columns,
/// network 0.0.0.0, mask 0.0.0.0.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_default_gateway(out: &str) -> Option<Ipv4Addr> {
    let mut best: Option<(u32, Ipv4Addr)> = None;
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() != 5 || f[0] != "0.0.0.0" || f[1] != "0.0.0.0" {
            continue;
        }
        let (Ok(gw), Ok(metric)) = (f[2].parse::<Ipv4Addr>(), f[4].parse::<u32>()) else {
            continue;
        };
        if best.is_none_or(|(m, _)| metric < m) {
            best = Some((metric, gw));
        }
    }
    best.map(|(_, g)| g)
}

/// The first name server in `/etc/resolv.conf` (Linux, macOS).
pub fn resolv_conf_server(conf: &str) -> Option<String> {
    conf.lines().find_map(|l| {
        let mut f = l.split_whitespace();
        (f.next()? == "nameserver")
            .then(|| f.next().map(str::to_string))
            .flatten()
    })
}

/// The result of one ping run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ping {
    pub sent: u32,
    pub replies: u32,
    /// Mean round trip of the replies, milliseconds.
    pub avg_ms: Option<f64>,
}

impl Ping {
    pub fn loss_pct(&self) -> Option<f64> {
        (self.sent > 0).then(|| {
            100.0 * f64::from(self.sent - self.replies.min(self.sent)) / f64::from(self.sent)
        })
    }
}

/// Count the replies in the output of `ping`, on any system and in any
/// language: a reply line carries "ttl=" (TTL= on Windows) and its time
/// ("time=1.23 ms", "time<1ms", "temps=2 ms", "Zeit=3ms"...).
pub fn ping_output(out: &str, sent: u32) -> Ping {
    let mut replies = 0u32;
    let mut times = Vec::new();
    for line in out.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("ttl=") {
            continue;
        }
        replies += 1;
        if let Some(t) = reply_time(&lower) {
            times.push(t);
        }
    }
    let avg_ms = (!times.is_empty()).then(|| times.iter().sum::<f64>() / times.len() as f64);
    Ping {
        sent,
        replies: replies.min(sent),
        avg_ms,
    }
}

/// The time on one reply line: the number after the first `=` or `<` that
/// follows a word ending in a letter, then "ms". `time<1ms` counts as 1.
fn reply_time(line: &str) -> Option<f64> {
    for (i, c) in line.char_indices() {
        if c != '=' && c != '<' {
            continue;
        }
        let before = line[..i].trim_end();
        if before.ends_with("ttl")
            || before.ends_with("bytes")
            || before.ends_with("icmp_seq")
            || before.ends_with("seq")
        {
            continue;
        }
        let rest = &line[i + 1..];
        let num: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
            .collect();
        let tail = rest[num.len()..].trim_start();
        if num.is_empty() || !tail.starts_with("ms") {
            continue;
        }
        return num.replace(',', ".").parse().ok();
    }
    None
}

/// Whether an IPv4 address was given by nobody: 169.254.x.x is what a host
/// takes when DHCP did not answer.
pub fn is_link_local(a: Ipv4Addr) -> bool {
    a.octets()[0] == 169 && a.octets()[1] == 254
}

/// One name for an HDP target: letters, digits, dots, dashes (HDP v1).
pub fn valid_target(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_route_table() {
        let t =
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
                 wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n\
                 eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
                 eth0\t0000000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n";
        // The lowest metric wins: the wired link.
        assert_eq!(
            linux_default_route(t),
            Some(("eth0".into(), Some(Ipv4Addr::new(10, 0, 0, 1))))
        );
        assert_eq!(linux_default_route("Iface\tDestination\n"), None);
    }

    #[test]
    fn bsd_and_windows_routes() {
        let mac = "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n";
        assert_eq!(
            bsd_route_get(mac),
            (Some(Ipv4Addr::new(192, 168, 1, 1)), Some("en0".into()))
        );
        let win = "===========================================================================\n\
                   IPv4-Routentabelle\n\
                   ===========================================================================\n\
                   Aktive Routen:\n\
                        Netzwerkziel    Netzwerkmaske          Gateway    Schnittstelle Metrik\n\
                             0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.23     35\n\
                             0.0.0.0          0.0.0.0         10.8.0.1        10.8.0.5     25\n";
        assert_eq!(
            windows_default_gateway(win),
            Some(Ipv4Addr::new(10, 8, 0, 1))
        );
        assert_eq!(windows_default_gateway("no routes"), None);
    }

    #[test]
    fn name_server() {
        assert_eq!(
            resolv_conf_server(
                "# generated\nsearch lan\nnameserver 192.168.1.1\nnameserver 1.1.1.1\n"
            ),
            Some("192.168.1.1".into())
        );
        assert_eq!(resolv_conf_server("search lan\n"), None);
    }

    #[test]
    fn ping_on_every_system() {
        let linux = "PING 192.168.1.1 (192.168.1.1) 56(84) bytes of data.\n\
                     64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=1.20 ms\n\
                     64 bytes from 192.168.1.1: icmp_seq=2 ttl=64 time=2.80 ms\n\
                     64 bytes from 192.168.1.1: icmp_seq=4 ttl=64 time=2.00 ms\n\
                     --- 192.168.1.1 ping statistics ---\n4 packets transmitted, 3 received, 25% packet loss\n";
        let p = ping_output(linux, 4);
        assert_eq!((p.sent, p.replies), (4, 3));
        assert!((p.avg_ms.unwrap() - 2.0).abs() < 1e-9);
        assert_eq!(p.loss_pct(), Some(25.0));

        let mac = "64 bytes from 10.0.0.1: icmp_seq=0 ttl=255 time=3.512 ms\n";
        assert_eq!(ping_output(mac, 4).avg_ms, Some(3.512));

        // Windows, French: "temps" and a decimal comma never appear, "<1ms" does.
        let win = "Réponse de 192.168.0.1 : octets=32 temps<1ms TTL=64\n\
                   Réponse de 192.168.0.1 : octets=32 temps=2 ms TTL=64\n\
                   Délai d'attente de la demande dépassé.\n";
        let p = ping_output(win, 4);
        assert_eq!(p.replies, 2);
        assert_eq!(p.avg_ms, Some(1.5));
        assert_eq!(p.loss_pct(), Some(50.0));

        // Nothing came back.
        let none = ping_output("Request timeout for icmp_seq 0\n", 4);
        assert_eq!(
            (none.replies, none.avg_ms, none.loss_pct()),
            (0, None, Some(100.0))
        );
    }

    #[test]
    fn addresses_and_targets() {
        assert!(is_link_local(Ipv4Addr::new(169, 254, 12, 7)));
        assert!(!is_link_local(Ipv4Addr::new(192, 168, 1, 7)));
        assert!(valid_target("example.com"));
        assert!(!valid_target("a b"));
        assert!(!valid_target("x;rm -rf"));
        assert!(!valid_target(""));
    }
}
