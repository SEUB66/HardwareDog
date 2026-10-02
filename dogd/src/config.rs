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
}

impl Source {
    pub fn describe(&self) -> String {
        match self {
            Source::None => "NONE".into(),
            Source::Serial(p) => format!("serial:{p}"),
            Source::Tcp(a) => format!("tcp:{a}"),
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

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub lan: bool,
    pub source: Source,
    pub origin: Origin,
    pub data_dir: PathBuf,
    /// Browser origins allowed to talk to dogd, besides localhost pages.
    pub allow_origins: Vec<String>,
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
  --source-origin simulated   the TCP source is a simulator (default: physical)
  --listen ADDR:PORT          default 127.0.0.1:4782, loopback only
  --listen-lan                listen on the network (0.0.0.0): explicit only
  --allow-origin URL          a browser origin allowed to connect (repeatable)
  --data DIR                  sessions and index (default ~/.local/share/hwdog)

LOCAL FIRST. NO ACCOUNT. NO CLOUD. NO TELEMETRY.";

/// Parse `serve` options.
pub fn parse_serve(args: &[String]) -> Result<Config, String> {
    let mut listen: Option<SocketAddr> = None;
    let mut lan = false;
    let mut source = Source::None;
    let mut origin: Option<Origin> = None;
    let mut data_dir = default_data_dir();
    let mut allow_origins = Vec::new();
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
                source = if let Some(p) = v.strip_prefix("serial:") {
                    Source::Serial(p.to_string())
                } else if let Some(t) = v.strip_prefix("tcp:") {
                    Source::Tcp(t.to_string())
                } else {
                    return Err(format!("unknown source {v} (serial:PATH or tcp:HOST:PORT)"));
                };
            }
            "--source-origin" => {
                origin = Some(
                    match value("--source-origin")?.to_ascii_lowercase().as_str() {
                        "physical" => Origin::Physical,
                        "simulated" => Origin::Simulated,
                        o => return Err(format!("unknown origin {o} (physical or simulated)")),
                    },
                );
            }
            "--listen" => {
                listen = Some(
                    value("--listen")?
                        .parse()
                        .map_err(|e| format!("--listen: {e}"))?,
                )
            }
            "--listen-lan" => lan = true,
            "--allow-origin" => {
                allow_origins.push(value("--allow-origin")?.trim_end_matches('/').to_string())
            }
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
    if matches!(source, Source::Serial(_)) && origin == Some(Origin::Simulated) {
        return Err(
            "a serial port is physical hardware: --source-origin simulated only applies to tcp"
                .into(),
        );
    }
    Ok(Config {
        listen,
        lan,
        source,
        origin: origin.unwrap_or(Origin::Physical),
        data_dir,
        allow_origins,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn local_by_default() {
        let c = parse_serve(&[]).unwrap();
        assert_eq!(c.listen.to_string(), "127.0.0.1:4782");
        assert!(!c.lan);
        assert_eq!(c.source, Source::None);
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
        assert_eq!(c.source, Source::Tcp("127.0.0.1:5000".into()));
        assert_eq!(c.origin, Origin::Simulated);
        assert!(parse_serve(&args(
            "--source serial:/dev/ttyACM0 --source-origin simulated"
        ))
        .is_err());
        assert!(parse_serve(&args("--source usb:x")).is_err());
    }
}
