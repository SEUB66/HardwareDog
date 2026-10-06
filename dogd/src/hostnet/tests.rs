use std::net::Ipv4Addr;
use std::sync::Mutex;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::*;

/// A network a test describes: what the system says, and how checks go.
#[derive(Default)]
struct Fake {
    obs: Observation,
    ping: Option<Ping>,
    names: Vec<(&'static str, Ipv4Addr)>,
    open: Vec<(Ipv4Addr, u16)>,
    http: Option<String>,
    pinged: Mutex<Vec<Ipv4Addr>>,
}

impl Net for Fake {
    async fn observe(&self) -> Observation {
        self.obs.clone()
    }
    async fn ping(&self, to: Ipv4Addr) -> Option<Ping> {
        self.pinged.lock().unwrap().push(to);
        self.ping
    }
    async fn resolve(&self, name: &str) -> Option<Ipv4Addr> {
        self.names.iter().find(|(n, _)| *n == name).map(|(_, a)| *a)
    }
    async fn connect(&self, host: &str, port: u16) -> Result<bool, ()> {
        let ip = self.resolve(host).await.ok_or(())?;
        Ok(self.open.contains(&(ip, port)))
    }
    async fn http_status(&self, host: &str) -> Result<Option<String>, ()> {
        self.resolve(host).await.ok_or(())?;
        Ok(self.http.clone())
    }
}

const GW: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 1);
const ME: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 23);
const EX: Ipv4Addr = Ipv4Addr::new(93, 184, 215, 14);

fn healthy() -> Fake {
    Fake {
        obs: Observation {
            link: Some(Link {
                up: true,
                mbps: Some(1000.0),
                duplex: Some("FULL"),
            }),
            address: Some(ME),
            gateway: Some(GW),
            dns_server: Some("192.168.1.1".into()),
        },
        ping: Some(Ping {
            sent: 4,
            replies: 4,
            avg_ms: Some(1.84),
        }),
        names: vec![("example.com", EX)],
        open: vec![(EX, 443), (EX, 80)],
        http: Some("HTTP/1.0 200 OK".into()),
        ..Default::default()
    }
}

async fn status_of(net: Fake) -> Value {
    let (obs, checks) = round(&net, &Watch::default()).await;
    net_status(1000, &obs, &checks, true)
}

fn layers(v: &Value) -> (Value, &str, &str, &str, &str) {
    (
        v["link"]["up"].clone(),
        v["dhcp"].as_str().unwrap(),
        v["gateway"]["status"].as_str().unwrap(),
        v["dns"]["status"].as_str().unwrap(),
        v["internet"].as_str().unwrap(),
    )
}

#[tokio::test]
async fn a_healthy_network_passes_every_layer() {
    let v = status_of(healthy()).await;
    assert_eq!(
        layers(&v),
        (Value::Bool(true), "PASS", "PASS", "PASS", "PASS")
    );
    assert_eq!(v["address"], "192.168.1.23");
    assert_eq!(v["gateway"]["address"], "192.168.1.1");
    assert_eq!(v["link"]["mbps"], 1000.0);
    assert_eq!(v["latency"], 1.8);
    assert_eq!(v["loss"], 0.0);
}

#[tokio::test]
async fn each_fault_shows_at_its_layer() {
    // Cable out: the link is down, and nothing above it is judged.
    let mut n = healthy();
    n.obs = Observation {
        link: Some(Link {
            up: false,
            mbps: None,
            duplex: None,
        }),
        ..Default::default()
    };
    assert_eq!(
        layers(&status_of(n).await),
        (
            Value::Bool(false),
            "UNKNOWN",
            "UNKNOWN",
            "UNKNOWN",
            "UNKNOWN"
        )
    );

    // Link up, DHCP did not answer: a 169.254 address.
    let mut n = healthy();
    n.obs.address = Some(Ipv4Addr::new(169, 254, 3, 9));
    n.obs.gateway = None;
    let v = status_of(n).await;
    assert_eq!(
        layers(&v),
        (Value::Bool(true), "FAIL", "UNKNOWN", "UNKNOWN", "UNKNOWN")
    );

    // Link up, no address at all.
    let mut n = healthy();
    n.obs.address = None;
    assert_eq!(layers(&status_of(n).await).1, "FAIL");

    // The router does not answer.
    let mut n = healthy();
    n.ping = Some(Ping {
        sent: 4,
        replies: 0,
        avg_ms: None,
    });
    let v = status_of(n).await;
    assert_eq!(layers(&v).2, "FAIL");
    assert_eq!(v["loss"], 100.0);
    assert_eq!(v["latency"], Value::Null);

    // An address and no route out.
    let mut n = healthy();
    n.obs.gateway = None;
    assert_eq!(layers(&status_of(n).await).2, "FAIL");

    // Names do not resolve: DNS fails, the Internet is not judged on a name.
    let mut n = healthy();
    n.names.clear();
    assert_eq!(
        layers(&status_of(n).await),
        (Value::Bool(true), "PASS", "PASS", "FAIL", "UNKNOWN")
    );

    // Everything local fine, nothing beyond.
    let mut n = healthy();
    n.open.clear();
    assert_eq!(
        layers(&status_of(n).await),
        (Value::Bool(true), "PASS", "PASS", "PASS", "FAIL")
    );
}

#[tokio::test]
async fn what_cannot_be_known_is_unknown() {
    // Windows: no link state, no name server; ping missing.
    let mut n = healthy();
    n.obs.link = None;
    n.obs.dns_server = None;
    n.ping = None;
    let v = status_of(n).await;
    assert_eq!(v["link"], Value::Null);
    assert_eq!(v["dns"]["address"], Value::Null);
    assert_eq!(layers(&v).1, "PASS");
    assert_eq!(layers(&v).2, "UNKNOWN");
    assert_eq!(v["loss"], Value::Null);
    // Before any round ran, checks are UNKNOWN, never guessed.
    let n = healthy();
    let v = net_status(0, &n.obs, &Checks::default(), false);
    assert_eq!(
        layers(&v),
        (Value::Bool(true), "PASS", "UNKNOWN", "UNKNOWN", "UNKNOWN")
    );
}

#[tokio::test]
async fn nothing_active_without_an_address() {
    let mut n = healthy();
    n.obs.address = None;
    let (_, checks) = round(&n, &Watch::default()).await;
    assert_eq!(checks, Checks::default());
    assert!(n.pinged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn probes_answer_like_a_probe() {
    let n = healthy();
    let tests: Vec<String> = ["PING", "DNS", "TCP", "HTTP"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let out = probe(&n, "p1", "example.com", &tests, || 5).await;
    let got: Vec<(String, String)> = out[..4]
        .iter()
        .map(|f| {
            (
                f["test"].as_str().unwrap().into(),
                f["status"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("PING".into(), "PASS".into()),
            ("DNS".into(), "PASS".into()),
            ("TCP".into(), "PASS".into()),
            ("HTTP".into(), "PASS".into())
        ]
    );
    assert_eq!(out[0]["detail"], "4/4 replies from 93.184.215.14, avg 2 ms");
    assert_eq!(out[3]["detail"], "HTTP/1.0 200 OK");
    assert_eq!(
        out[4],
        serde_json::json!({ "type": "probe.done", "t": 5, "id": "p1" })
    );

    let out = probe(&n, "p2", "nowhere.invalid", &tests, || 5).await;
    assert!(out[..4].iter().all(|f| f["status"] == "FAIL"));
    let out = probe(&n, "p3", "93.184.215.14", &["DNS".to_string()], || 5).await;
    assert_eq!(out[0]["status"], "UNKNOWN");
}

#[test]
fn commands_are_checked() {
    let ok = serde_json::json!({ "cmd": "net.watch", "every_ms": 5000, "dns": "example.org" });
    assert_eq!(
        parse_watch(&ok).unwrap(),
        Watch {
            every_ms: 5000,
            dns: Some("example.org".into()),
            upstream: None
        }
    );
    assert!(parse_watch(&serde_json::json!({ "cmd": "net.watch", "every_ms": 10 })).is_err());
    assert!(parse_watch(
        &serde_json::json!({ "cmd": "net.watch", "every_ms": 5000, "dns": "a b" })
    )
    .is_err());
    assert!(parse_probe(
        &serde_json::json!({ "cmd": "probe", "id": "x", "target": "h; reboot", "tests": ["PING"] })
    )
    .is_err());
    assert!(parse_probe(
        &serde_json::json!({ "cmd": "probe", "id": "x", "target": "h", "tests": ["NMAP"] })
    )
    .is_err());
}

/// The device end to end: hello, a status at once, commands answered.
#[tokio::test]
async fn the_device_speaks_hdp() {
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    tokio::spawn(run(healthy(), theirs, Watch::default()));
    let (r, mut w) = tokio::io::split(ours);
    let mut lines = BufReader::new(r).lines();
    macro_rules! next {
        () => {{
            let l = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            serde_json::from_str::<Value>(&l).unwrap()
        }};
    }
    w.write_all(b"{\"cmd\":\"hello\",\"proto\":1}\n")
        .await
        .unwrap();
    let mut seen = Vec::new();
    for _ in 0..2 {
        seen.push(next!());
    }
    let types: Vec<&str> = seen.iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert!(
        types.contains(&"hello") && types.contains(&"net.status"),
        "{types:?}"
    );
    let h = seen.iter().find(|f| f["type"] == "hello").unwrap();
    assert_eq!(h["device"], HOST_DEVICE);
    assert_eq!(h["caps"], serde_json::json!(["net", "probe"]));

    w.write_all(b"{\"cmd\":\"time\",\"id\":7}\n").await.unwrap();
    let f = next!();
    assert_eq!(
        (f["type"].as_str(), f["id"].as_u64()),
        (Some("time"), Some(7))
    );

    w.write_all(b"{\"cmd\":\"i2c.scan\"}\n").await.unwrap();
    let f = next!();
    assert_eq!(f["type"], "log");
    assert!(f["message"].as_str().unwrap().contains("does not observe"));

    w.write_all(
        b"{\"cmd\":\"probe\",\"id\":\"p\",\"target\":\"example.com\",\"tests\":[\"DNS\"]}\n",
    )
    .await
    .unwrap();
    let f = next!();
    assert_eq!(
        (f["type"].as_str(), f["status"].as_str()),
        (Some("probe.result"), Some("PASS"))
    );
    assert_eq!(next!()["type"], "probe.done");

    // Stopping the watch says so at once: checks back to UNKNOWN.
    w.write_all(b"{\"cmd\":\"net.watch\",\"every_ms\":0}\n")
        .await
        .unwrap();
    let f = next!();
    assert_eq!(
        (f["type"].as_str(), f["gateway"]["status"].as_str()),
        (Some("net.status"), Some("UNKNOWN"))
    );
}

/// At start the device is passive: it says what the system knows, and
/// judges nothing it would have to send a packet for.
#[tokio::test]
async fn passive_until_asked() {
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    tokio::spawn(run(healthy(), theirs, Watch::off()));
    let (r, _w) = tokio::io::split(ours);
    let mut lines = BufReader::new(r).lines();
    let l = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let f: Value = serde_json::from_str(&l).unwrap();
    assert_eq!(f["type"], "net.status");
    assert_eq!(f["address"], "192.168.1.23");
    assert_eq!(
        layers(&f),
        (Value::Bool(true), "PASS", "UNKNOWN", "UNKNOWN", "UNKNOWN")
    );
}
