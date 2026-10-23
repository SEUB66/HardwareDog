//! Command line configuration. Local by default, and only by default:
//! listening beyond this machine is an explicit decision.

use std::net::SocketAddr;
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 4782;

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// No device yet: dogd serves sessions and waits.
    None,
    /// A serial port (USB CDC), e.g. /dev/ttyACM0 or COM4.
    Serial(String),
    /// Any HDP byte stream over TCP, e.g. a device on Wi-Fi.
    Tcp(String),
    /// This computer, for the network: no probe needed (hostnet).
    Host,
}

impl Source {
    pub fn describe(&self) -> String {
        match self {
            Source::None => "NONE".into(),
            Source::Serial(p) => format!("serial:{p}"),
            Source::Tcp(a) => format!("tcp:{a}"),
            Source::Host => "host".into(),
        }
    }
}

/// Where the events come from. dogd cannot tell a simulator on a TCP port
/// from real hardware, so the operator says it; a serial port is physical.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Origin {
    Physical,
    Simulated,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Physical => "PHYSICAL",
            Origin::Simulated => "SIMULATED",
        }
    }
}

/// One device link: where its bytes come from, and what they are worth.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkConfig {
    pub source: Source,
    pub origin: Origin,
}

/// A pack is a bench, not a fleet.
pub const MAX_SOURCES: usize = 8;

/// The project's own interface. Allowed by default: dogd is installed from
/// this site (its installer), so trusting the page adds no new party;
/// --no-site-origin refuses it.
pub const SITE_ORIGIN: &str = "https://hardwaredog.org";

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub lan: bool,
    /// The device links, in order: D1, D2... Empty: no device yet.
    pub links: Vec<LinkConfig>,
    pub data_dir: PathBuf,
    /// Browser origins allowed to talk to dogd, besides localhost pages.
    pub allow_origins: Vec<String>,
    /// SITE_ORIGIN allowed too (default; --no-site-origin turns it off).
    pub site_origin: bool,
    /// With --listen-lan: the token a client on another machine must show
    /// (Authorization: Bearer, or ?token= for a WebSocket). Made at start.
    pub lan_token: Option<String>,
}

/// A new LAN access token: 128 random bits, hex.
pub fn new_token() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| format!("no randomness from the system: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

pub fn default_data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(d).join("hwdog");
    }
    if let Some(d) = std::env::var_os("APPDATA") {
        return PathBuf::from(d).join("hwdog");
    }
    if let Some(h) = std::env::var_os("HOME") {
        return PathBuf::from(h).join(".local/share/hwdog");
    }
    PathBuf::from("hwdog-data")
}

pub const USAGE: &str = "\
HW DOG / DOGD — local Hardware Dog daemon

USAGE
  dogd [serve] [options]      run the daemon
  dogd status [--port N]      ask a running dogd how it is
  dogd devices [--identify]   what is plugged in, and who it is (read only);
                              --identify sends one HDP hello per port
  dogd devices --known        every device identity dogd remembers
  dogd alias HW-ID NAME       a label for people (--clear removes it); it
                              tells no look-alikes apart
  dogd bind PORT HW-ID        the device on PORT is HW-ID: settles an
                              ambiguity, confirms a hint (refused if their
                              chip id, MAC or serial differ)
  dogd sessions [--data DIR]  list stored sessions (works with dogd stopped)

OPTIONS (serve)
  --source serial:PATH        a device on a serial port (/dev/ttyACM0, COM4)
  --source tcp:HOST:PORT      a device on any HDP byte stream over TCP
  --source host               this computer, for the network: no probe needed.
                              Link, address, gateway, DNS, Internet, and the
                              PROBE tests, checked from here. Passive until
                              the interface asks: then it pings the gateway,
                              resolves a name, connects to 443 (ACTIVE)
                              repeat --source for a pack: each is a Dog,
                              D1, D2... in this order (at most 8)
  --source-origin simulated   the TCP source just before it is a simulator
                              (default: physical)
  --listen ADDR:PORT          default 127.0.0.1:4782, loopback only
  --listen-lan                listen on the network (0.0.0.0): explicit only;
                              other machines need the token printed at start
  --allow-origin URL          a browser origin allowed to connect (repeatable)
  --no-site-origin            refuse https://hardwaredog.org too (allowed by
                              default: the interface dogd was installed from)
  --data DIR                  sessions and index (default ~/.local/share/hwdog)

LOCAL FIRST. NO ACCOUNT. NO CLOUD. NO TELEMETRY.";

/// Parse `serve` options.
pub fn parse_serve(args: &[String]) -> Result<Config, String> {
    let mut listen: Option<SocketAddr> = None;
    let mut lan = false;
    let mut sources: Vec<(Source, Option<Origin>)> = Vec::new();
    // Given before any --source: it is for the first one.
    let mut early_origin: Option<Origin> = None;
    let mut data_dir = default_data_dir();
    let mut allow_origins = Vec::new();
    let mut site_origin = true;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--source" => {
                let v = value("--source")?;
                let source = if v == "host" {
                    Source::Host
                } else if let Some(p) = v.strip_prefix("serial:") {
                    Source::Serial(p.to_string())
                } else if let Some(t) = v.strip_prefix("tcp:") {
                    Source::Tcp(t.to_string())
                } else {
                    return Err(format!(
                        "unknown source {v} (host, serial:PATH or tcp:HOST:PORT)"
                    ));
                };
                if sources.iter().any(|(s, _)| *s == source) {
                    return Err(format!("{v} is given twice: one link per device"));
                }
                sources.push((source, None));
            }
            "--source-origin" => {
                let o = match value("--source-origin")?.to_ascii_lowercase().as_str() {
                    "physical" => Origin::Physical,
                    "simulated" => Origin::Simulated,
                    o => return Err(format!("unknown origin {o} (physical or simulated)")),
                };
                let slot = match sources.last_mut() {
                    Some((_, slot)) => slot,
                    None => &mut early_origin,
                };
                if slot.is_some() {
                    return Err("--source-origin given twice for one source".into());
                }
                *slot = Some(o);
            }
            "--listen" => {
                listen = Some(
                    value("--listen")?
                        .parse()
                        .map_err(|e| format!("--listen: {e}"))?,
                )
            }
            "--listen-lan" => lan = true,
            "--allow-origin" => allow_origins.push(parse_origin(&value("--allow-origin")?)?),
            "--no-site-origin" => site_origin = false,
            "--data" => data_dir = PathBuf::from(value("--data")?),
            other => return Err(format!("unknown option {other}\n\n{USAGE}")),
        }
    }
    let listen = listen.unwrap_or_else(|| {
        let ip = if lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
        SocketAddr::from((ip, DEFAULT_PORT))
    });
    if !lan && !listen.ip().is_loopback() {
        return Err(format!("refusing to listen on {listen}: dogd is local only. Add --listen-lan to decide otherwise."));
    }
    if let Some(o) = early_origin {
        match sources.first_mut() {
            Some((_, slot)) if slot.is_none() => *slot = Some(o),
            Some(_) => return Err("--source-origin given twice for one source".into()),
            None => return Err("--source-origin without a --source".into()),
        }
    }
    if sources.len() > MAX_SOURCES {
        return Err(format!("at most {MAX_SOURCES} sources: a pack is a bench"));
    }
    let mut links = Vec::new();
    for (source, origin) in sources {
        if matches!(source, Source::Host) && origin == Some(Origin::Simulated) {
            return Err("host is this computer, measured for real: --source-origin simulated only applies to tcp".into());
        }
        if matches!(source, Source::Serial(_)) && origin == Some(Origin::Simulated) {
            return Err(
                "a serial port is physical hardware: --source-origin simulated only applies to tcp"
                    .into(),
            );
        }
        links.push(LinkConfig {
            source,
            origin: origin.unwrap_or(Origin::Physical),
        });
    }
    Ok(Config {
        listen,
        lan,
        links,
        data_dir,
        allow_origins,
        site_origin,
        lan_token: None,
    })
}

/// A browser origin as browsers send it: scheme://host[:port], nothing else.
/// "null" (sandboxed frames, file: and data: pages of any site) and "*" are
/// refused; plain http only for this machine, where no one can rewrite the
/// page on the way.
pub fn parse_origin(value: &str) -> Result<String, String> {
    let o = value.trim().trim_end_matches('/');
    let bad = |why: &str| Err(format!("--allow-origin {value}: {why}"));
    if o == "null" || o == "*" {
        return bad("any site can send this origin");
    }
    let (scheme, rest) = match o.split_once("://") {
        Some(("https", rest)) => ("https", rest),
        Some(("http", rest)) => ("http", rest),
        _ => return bad("an origin starts with https:// (or http:// on this machine)"),
    };
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ']) {
        return bad("an origin is scheme://host[:port], with no path");
    }
    let port_ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit());
    let host = match rest.strip_prefix('[').and_then(|r| r.find(']')) {
        // [v6]:port
        Some(close) => {
            let (h, after) = rest.split_at(close + 2);
            if !after.is_empty() && !after.strip_prefix(':').is_some_and(port_ok) {
                return bad("the port must be a number");
            }
            h
        }
        None => match rest.split_once(':') {
            Some((h, p)) if port_ok(p) => h,
            Some(_) => return bad("the port must be a number"),
            None => rest,
        },
    };
    if scheme == "http" && !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        return bad(
            "plain http is only for this machine: anyone on the way could change that page",
        );
    }
    Ok(o.to_string())
}

/// Whether a link's hello names a board to remember in the identity index:
/// not this computer (it has no chip id), not a simulator (its identity is
/// invented, and simulated data never passes for real hardware).
pub fn remembers_identity(source: &Source, origin: Origin) -> bool {
    !matches!(source, Source::Host) && origin == Origin::Physical
}

#[cfg(test)]
mod tests {
    #[test]
    fn allow_origin_takes_origins_only() {
        assert_eq!(
            parse_origin("https://bench.example/").unwrap(),
            "https://bench.example"
        );
        assert_eq!(
            parse_origin("https://bench.example:8443").unwrap(),
            "https://bench.example:8443"
        );
        assert_eq!(
            parse_origin("http://localhost:3000").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            parse_origin("http://[::1]:5173").unwrap(),
            "http://[::1]:5173"
        );
        for bad in [
            "null",
            "*",
            "bench.example",
            "https://site/app",
            "http://bench.example",
            "ftp://x",
            "https://",
            "https://x:abc",
            "https://u@x",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn only_physical_boards_enter_the_identity_index() {
        let tcp = Source::Tcp("10.0.0.5:4782".into());
        assert!(remembers_identity(&tcp, Origin::Physical));
        assert!(!remembers_identity(&tcp, Origin::Simulated));
        assert!(!remembers_identity(&Source::Host, Origin::Physical));
    }

    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn local_by_default() {
        let c = parse_serve(&[]).unwrap();
        assert_eq!(c.listen.to_string(), "127.0.0.1:4782");
        assert!(!c.lan);
        assert!(c.links.is_empty());
    }

    #[test]
    fn network_only_when_asked() {
        assert!(parse_serve(&args("--listen 0.0.0.0:4782"))
            .unwrap_err()
            .contains("--listen-lan"));
        assert_eq!(
            parse_serve(&args("--listen-lan"))
                .unwrap()
                .listen
                .to_string(),
            "0.0.0.0:4782"
        );
        assert!(parse_serve(&args("--listen [::1]:5000")).is_ok());
    }

    #[test]
    fn sources_and_origin() {
        let c = parse_serve(&args(
            "--source tcp:127.0.0.1:5000 --source-origin simulated",
        ))
        .unwrap();
        assert_eq!(
            c.links,
            [LinkConfig {
                source: Source::Tcp("127.0.0.1:5000".into()),
                origin: Origin::Simulated
            }]
        );
        // The order dogd 0.1 accepted: the origin first.
        let c = parse_serve(&args("--source-origin simulated --source tcp:h:1")).unwrap();
        assert_eq!(c.links[0].origin, Origin::Simulated);
        assert!(parse_serve(&args(
            "--source serial:/dev/ttyACM0 --source-origin simulated"
        ))
        .is_err());
        assert!(parse_serve(&args("--source usb:x")).is_err());
        let c = parse_serve(&args("--source host")).unwrap();
        assert_eq!(c.links[0].source, Source::Host);
        assert_eq!(c.links[0].origin, Origin::Physical);
        assert!(parse_serve(&args("--source host --source-origin simulated")).is_err());
    }

    #[test]
    fn several_sources_are_a_pack() {
        let c = parse_serve(&args(
            "--source tcp:h:1 --source-origin simulated --source serial:/dev/ttyACM0 --source tcp:h:2",
        ))
        .unwrap();
        let got: Vec<(String, Origin)> = c
            .links
            .iter()
            .map(|l| (l.source.describe(), l.origin))
            .collect();
        assert_eq!(
            got,
            [
                ("tcp:h:1".to_string(), Origin::Simulated),
                ("serial:/dev/ttyACM0".to_string(), Origin::Physical),
                ("tcp:h:2".to_string(), Origin::Physical),
            ]
        );
        assert!(parse_serve(&args("--source tcp:h:1 --source tcp:h:1"))
            .unwrap_err()
            .contains("twice"));
        assert!(parse_serve(&args(
            "--source tcp:h:1 --source-origin simulated --source-origin physical"
        ))
        .is_err());
        assert!(parse_serve(&args("--source-origin simulated")).is_err());
        let nine: String = (1..=9).map(|n| format!("--source tcp:h:{n} ")).collect();
        assert!(parse_serve(&args(&nine)).unwrap_err().contains("at most 8"));
    }
}
