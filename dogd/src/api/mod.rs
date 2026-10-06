//! The local API. Small on purpose: HDP commands are not repeated as REST
//! endpoints, they go through the HDP socket like on every other transport.
//!
//!   GET  /v1/health                  alive, versions
//!   GET  /v1/link                    the first device link (D1): state, source, origin, device
//!   GET  /v1/links                   every device link, D1, D2...: a pack when several
//!   GET  /v1/devices                 attached devices and who they are, known identities
//!   GET  /v1/devices/events?since=N  plug / unplug / identified, in order
//!   PUT  /v1/devices/{id}/alias      a label for people (text body, empty clears)
//!   PUT  /v1/devices/{id}/bind       the device on the port in the body is {id}
//!   GET  /v1/sessions                stored sessions (the index)
//!   GET  /v1/sessions/{id}           one session
//!   GET  /v1/sessions/{id}/hdlog     the file, byte for byte
//!   PUT  /v1/sessions/{id}/hdlog     store a file the interface wrote
//!   WS   /v1/hdp                     raw HDP of D1: device bytes out, command lines in
//!   WS   /v1/hdp/{dog}               raw HDP of one link of a pack (D2...)
//!
//! Trust boundary: this machine. Requests must name a loopback host (no DNS
//! rebinding), and a browser page must come from an allowed origin: a web
//! page on the Internet cannot drive a device on this desk.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;

use crate::config::Config;
use crate::device;
use crate::discovery::Discovery;
use crate::protocol::{HDP_VERSION, MAX_LINE};
use crate::sessions::MAX_BYTES;
use crate::storage::{PutError, Store};
use crate::transport::{Link, LinkState};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// WebSocket close codes. The interface shows the reason as given.
pub const CLOSE_NO_DEVICE: u16 = 4404;
pub const CLOSE_LINK_LOST: u16 = 4001;
pub const CLOSE_TOO_SLOW: u16 = 4008;

#[derive(Clone)]
pub struct AppState {
    /// D1, D2...: never empty (with no source, D1 is a link with no device).
    pub links: Arc<Vec<Arc<Link>>>,
    pub store: Arc<Store>,
    pub discovery: Arc<Discovery>,
    pub cfg: Arc<Config>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/link", get(link))
        .route("/v1/links", get(links))
        .route("/v1/devices", get(devices))
        .route("/v1/usb", get(usb_devices))
        .route("/v1/devices/events", get(device_events))
        .route("/v1/devices/{id}/alias", axum::routing::put(put_alias))
        .route("/v1/devices/{id}/bind", axum::routing::put(put_bind))
        .route("/v1/sessions", get(sessions))
        .route("/v1/sessions/{id}", get(session))
        .route(
            "/v1/sessions/{id}/hdlog",
            get(get_hdlog)
                .put(put_hdlog)
                .layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        .route("/v1/hdp", get(hdp))
        .route("/v1/hdp/{dog}", get(hdp_of))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

// ------------------------------------------------------------------ guard

fn host_allowed(host: &str, cfg: &Config) -> bool {
    if cfg.lan {
        return true;
    }
    let name = host.rsplit_once(':').map_or(host, |(h, p)| {
        if p.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            host
        }
    });
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

pub fn origin_allowed(origin: &str, cfg: &Config) -> bool {
    let o = origin.trim_end_matches('/');
    for local in ["http://localhost", "http://127.0.0.1", "http://[::1]"] {
        if o == local
            || o.strip_prefix(local).is_some_and(|rest| {
                rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit())
            })
        {
            return true;
        }
    }
    cfg.allow_origins.iter().any(|a| a == o)
}

/// The token a request shows: `Authorization: Bearer <t>`, or `?token=<t>`
/// (a browser cannot set headers on a WebSocket).
fn shown_token(req: &Request) -> Option<String> {
    if let Some(t) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
    {
        return Some(t.trim().to_string());
    }
    req.uri().query().and_then(|q| {
        q.split('&')
            .find_map(|kv| kv.strip_prefix("token="))
            .map(str::to_string)
    })
}

/// Compared in constant time: how much of a guess matched never shows.
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// A peer on this machine. Unknown is not local.
fn from_this_machine(req: &Request) -> bool {
    req.extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .is_some_and(|c| c.0.ip().is_loopback())
}

async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
    // On the network (--listen-lan), another machine shows the token printed at start:
    // without it, anyone on the LAN could read sessions and drive the device.
    if s.cfg.lan && !from_this_machine(&req) {
        let ok = match (&s.cfg.lan_token, shown_token(&req)) {
            (Some(want), Some(got)) => same_token(want, &got),
            _ => false,
        };
        if !ok {
            return (
                StatusCode::UNAUTHORIZED,
                "dogd on the network: show the token it printed at start (Authorization: Bearer, or ?token=)",
            )
                .into_response();
        }
    }
    let headers = req.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !host_allowed(host, &s.cfg) {
        return (
            StatusCode::FORBIDDEN,
            "dogd is local: requests must name a loopback host",
        )
            .into_response();
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string);
    if let Some(o) = &origin {
        if !origin_allowed(o, &s.cfg) {
            return (
                StatusCode::FORBIDDEN,
                format!("origin {o} is not allowed (dogd --allow-origin)"),
            )
                .into_response();
        }
    }
    let preflight = req.method() == Method::OPTIONS;
    let private_network = headers
        .get("access-control-request-private-network")
        .is_some();
    let mut res = if preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    if let Some(o) = origin {
        let h = res.headers_mut();
        h.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_str(&o).unwrap_or(HeaderValue::from_static("null")),
        );
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
        if preflight {
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, PUT, OPTIONS"),
            );
            h.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("content-type, authorization"),
            );
            if private_network {
                // An allowed page served from the network may reach this machine's dogd.
                h.insert(
                    "access-control-allow-private-network",
                    HeaderValue::from_static("true"),
                );
            }
        }
    }
    res
}

// ------------------------------------------------------------------ handlers

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "dogd": VERSION, "hdp": HDP_VERSION }))
}

async fn link(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(s.links[0].status()).unwrap())
}

async fn links(State(s): State<AppState>) -> Json<serde_json::Value> {
    let all: Vec<_> = s.links.iter().map(|l| l.status()).collect();
    Json(json!({ "links": all }))
}

/// The USB devices plugged into this computer, read from the system:
/// nothing is opened or written. For the host source's USB screen.
async fn usb_devices() -> Json<serde_json::Value> {
    let found = tokio::task::spawn_blocking(crate::hostnet::usb::scan)
        .await
        .unwrap_or(None);
    Json(json!({ "supported": found.is_some(), "devices": found.unwrap_or_default() }))
}

async fn devices(State(s): State<AppState>) -> Json<serde_json::Value> {
    let ports = tokio::task::spawn_blocking(device::list_ports)
        .await
        .unwrap_or_default();
    Json(json!({
        "link": s.links[0].status(),
        "links": s.links.iter().map(|l| l.status()).collect::<Vec<_>>(),
        "ports": ports,
        "attached": s.discovery.present(),
        "known": s.store.hw_devices(),
        "seen": s.store.devices(),
    }))
}

#[derive(serde::Deserialize)]
struct Since {
    since: Option<i64>,
}

async fn device_events(
    State(s): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<Since>,
) -> Json<serde_json::Value> {
    Json(json!({ "events": s.store.hw_events(q.since.unwrap_or(0), 500) }))
}

async fn put_alias(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Ok(name) = std::str::from_utf8(&body) else {
        return (StatusCode::UNPROCESSABLE_ENTITY, "an alias is text").into_response();
    };
    match s.store.set_alias(&id, name) {
        Ok(()) => Json(s.store.hw_device(&id)).into_response(),
        Err(e) => identity_error(e),
    }
}

async fn put_bind(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Ok(port) = std::str::from_utf8(&body) else {
        return (StatusCode::UNPROCESSABLE_ENTITY, "the body is a port name").into_response();
    };
    match s.discovery.bind(&s.store, port.trim(), &id) {
        Ok(o) => Json(o).into_response(),
        Err(e) => identity_error(e),
    }
}

/// Not found, not stored (the index failed: said, never hidden), or refused.
fn identity_error(e: String) -> Response {
    let code = if e.starts_with("no device") || e.starts_with("nothing attached") {
        StatusCode::NOT_FOUND
    } else if e.starts_with("index:") {
        StatusCode::INTERNAL_SERVER_ERROR
    } else if e.starts_with("refused")
        || e.contains("attached on another port")
        || e.contains("was bound to")
    {
        StatusCode::CONFLICT
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    (code, e).into_response()
}

async fn sessions(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "sessions": s.store.sessions() }))
}

async fn session(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.store.session(&id) {
        Some(row) => Json(row).into_response(),
        None => (StatusCode::NOT_FOUND, "no such recording").into_response(),
    }
}

async fn get_hdlog(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.store.hdlog(&id) {
        Some(bytes) => ([(header::CONTENT_TYPE, "application/x-ndjson")], bytes).into_response(),
        None => (StatusCode::NOT_FOUND, "no such recording").into_response(),
    }
}

async fn put_hdlog(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let store = s.store.clone();
    let result = tokio::task::spawn_blocking(move || store.put(&id, &body)).await;
    match result {
        Ok(Ok((row, created))) => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(row),
        )
            .into_response(),
        Ok(Err(PutError::Invalid(e))) => (StatusCode::UNPROCESSABLE_ENTITY, e).into_response(),
        Ok(Err(PutError::Conflict(e))) => (StatusCode::CONFLICT, e).into_response(),
        Ok(Err(PutError::Io(_))) | Err(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "storage failed").into_response()
        }
    }
}

// ------------------------------------------------------------------ HDP socket

async fn hdp(ws: WebSocketUpgrade, State(s): State<AppState>) -> Response {
    let link = s.links[0].clone();
    ws.max_message_size(MAX_LINE + 1024)
        .on_upgrade(move |socket| client(socket, link))
}

async fn hdp_of(
    ws: WebSocketUpgrade,
    State(s): State<AppState>,
    Path(dog): Path<String>,
) -> Response {
    let Some(link) = s.links.iter().find(|l| l.status().dog == dog).cloned() else {
        return (StatusCode::NOT_FOUND, format!("no link {dog}")).into_response();
    };
    ws.max_message_size(MAX_LINE + 1024)
        .on_upgrade(move |socket| client(socket, link))
}

fn close(code: u16, reason: String) -> Message {
    let mut reason = reason;
    reason.truncate(120); // close reasons are limited to 123 bytes
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// One interface client: device bytes out as binary messages, exactly as
/// received; command lines in, written to the device exactly as sent.
async fn client(socket: WebSocket, link: Arc<Link>) {
    let (mut tx, mut rx) = socket.split();
    let status = link.status();
    if status.state != LinkState::Online {
        let why = status
            .reason
            .unwrap_or_else(|| "no device connected".into());
        let _ = tx
            .send(close(CLOSE_NO_DEVICE, format!("no device: {why}")))
            .await;
        return;
    }
    let epoch = status.epoch;
    let mut bytes = link.subscribe();
    let mut state = link.watch();
    loop {
        tokio::select! {
            chunk = bytes.recv() => match chunk {
                Ok(c) => {
                    if tx.send(Message::Binary(c.into())).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // A gap would corrupt the stream: say so, never hide it.
                    let _ = tx.send(close(CLOSE_TOO_SLOW, format!("client too slow, {n} chunks lost"))).await;
                    return;
                }
                Err(_) => return,
            },
            changed = state.changed() => {
                let st = state.borrow().clone();
                if changed.is_err() || st.epoch != epoch || st.state != LinkState::Online {
                    // The device's last bytes arrived before the loss: deliver them first.
                    while let Ok(c) = bytes.try_recv() {
                        if tx.send(Message::Binary(c.into())).await.is_err() {
                            return;
                        }
                    }
                    let why = st.reason.unwrap_or_else(|| "link restarted".into());
                    let _ = tx.send(close(CLOSE_LINK_LOST, format!("device link lost: {why}"))).await;
                    return;
                }
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(t))) => link.send(t.as_bytes().to_vec()).await,
                Some(Ok(Message::Binary(b))) => link.send(b.to_vec()).await,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_serve;

    #[test]
    fn hosts() {
        let local = parse_serve(&[]).unwrap();
        assert!(host_allowed("127.0.0.1:4782", &local));
        assert!(host_allowed("localhost:4782", &local));
        assert!(host_allowed("[::1]:4782", &local));
        assert!(!host_allowed("evil.example:4782", &local));
        assert!(!host_allowed("127.0.0.1.evil.example", &local));
        assert!(!host_allowed("", &local));
    }

    #[test]
    fn origins() {
        let cfg = parse_serve(&["--allow-origin".into(), "https://hw.example".into()]).unwrap();
        assert!(origin_allowed("http://localhost:5173", &cfg));
        assert!(origin_allowed("http://127.0.0.1:4173", &cfg));
        assert!(origin_allowed("https://hw.example", &cfg));
        assert!(!origin_allowed("https://evil.example", &cfg));
        assert!(!origin_allowed("http://localhost.evil.example", &cfg));
        assert!(!origin_allowed("http://localhost:80@evil.example", &cfg));
        assert!(!origin_allowed("null", &cfg));
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use crate::config::{parse_serve, Source};
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn app(args: &[&str]) -> Router {
        app_with(args, None)
    }

    fn app_with(args: &[&str], lan_token: Option<&str>) -> Router {
        let dir = std::env::temp_dir().join(format!(
            "dogd-api-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        a.extend(["--data".into(), dir.to_string_lossy().into()]);
        let mut cfg = parse_serve(&a).unwrap();
        cfg.lan_token = lan_token.map(str::to_string);
        let store = Arc::new(Store::open(&cfg.data_dir).unwrap());
        let links: Vec<Arc<Link>> = if cfg.links.is_empty() {
            vec![Link::new(
                "D1",
                &Source::None,
                crate::config::Origin::Physical,
                |_, _| {},
            )]
        } else {
            // Links that never connect: a test has no device.
            cfg.links
                .iter()
                .enumerate()
                .map(|(n, l)| Link::new(&format!("D{}", n + 1), &l.source, l.origin, |_, _| {}))
                .collect()
        };
        router(AppState {
            links: Arc::new(links),
            store,
            discovery: Arc::new(crate::discovery::Discovery::default()),
            cfg: Arc::new(cfg),
        })
    }

    async fn call(
        app: Router,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, HeaderMapLite) {
        call_from(app, "127.0.0.1:50000", method, path, headers).await
    }

    /// A request from a peer at `peer` (this machine, or another one on the LAN).
    async fn call_from(
        app: Router,
        peer: &str,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, HeaderMapLite) {
        let mut req = HttpRequest::builder()
            .method(method)
            .uri(path)
            .extension(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let h = res
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        (res.status(), h)
    }

    type HeaderMapLite = Vec<(String, String)>;

    #[tokio::test]
    async fn local_requests_are_served() {
        let (s, _) = call(app(&[]), "GET", "/v1/health", &[("host", "127.0.0.1:4782")]).await;
        assert_eq!(s, StatusCode::OK);
        let (s, h) = call(
            app(&[]),
            "GET",
            "/v1/sessions",
            &[
                ("host", "localhost:4782"),
                ("origin", "http://localhost:5173"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(h.contains(&(
            "access-control-allow-origin".into(),
            "http://localhost:5173".into()
        )));
    }

    #[tokio::test]
    async fn a_web_page_from_elsewhere_cannot_drive_the_device() {
        let (s, _) = call(
            app(&[]),
            "GET",
            "/v1/hdp",
            &[
                ("host", "127.0.0.1:4782"),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _) = call(
            app(&[]),
            "PUT",
            "/v1/sessions/x/hdlog",
            &[
                ("host", "127.0.0.1:4782"),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn dns_rebinding_is_refused() {
        let (s, _) = call(
            app(&[]),
            "GET",
            "/v1/health",
            &[("host", "attacker.example:4782")],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // with --listen-lan the operator decided: the host check is lifted, origins still apply
        let (s, _) = call(
            app(&["--listen-lan"]),
            "GET",
            "/v1/health",
            &[("host", "192.168.1.20:4782")],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call(
            app(&["--listen-lan"]),
            "GET",
            "/v1/health",
            &[
                ("host", "192.168.1.20:4782"),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_allowed_site_gets_private_network_access() {
        let app = app(&["--allow-origin", "https://hardwaredog.example"]);
        let (s, h) = call(
            app,
            "OPTIONS",
            "/v1/link",
            &[
                ("host", "127.0.0.1:4782"),
                ("origin", "https://hardwaredog.example"),
                ("access-control-request-private-network", "true"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert!(h.contains(&("access-control-allow-private-network".into(), "true".into())));
    }

    #[tokio::test]
    async fn every_source_is_a_link_of_its_own() {
        let res = app(&[
            "--source",
            "tcp:127.0.0.1:9",
            "--source-origin",
            "simulated",
            "--source",
            "tcp:127.0.0.1:10",
            "--source-origin",
            "simulated",
        ])
        .oneshot(
            HttpRequest::get("/v1/links")
                .header("host", "127.0.0.1:4782")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let links = v["links"].as_array().unwrap();
        let rows: Vec<_> = links
            .iter()
            .map(|l| (l["dog"].clone(), l["source"].clone(), l["origin"].clone()))
            .collect();
        assert_eq!(
            rows,
            vec![
                (json!("D1"), json!("tcp:127.0.0.1:9"), json!("SIMULATED")),
                (json!("D2"), json!("tcp:127.0.0.1:10"), json!("SIMULATED")),
            ]
        );
    }

    /// A WebSocket upgrade over a real socket: the status line of the answer.
    async fn upgrade(app: Router, path: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr.port()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 512];
        let n = s.read(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        text.lines().next().unwrap_or("").to_string()
    }

    #[tokio::test]
    async fn each_dog_has_its_own_stream() {
        let two = || {
            app(&[
                "--source",
                "tcp:127.0.0.1:9",
                "--source",
                "tcp:127.0.0.1:10",
            ])
        };
        assert!(upgrade(two(), "/v1/hdp/D2").await.contains("101"));
        assert!(upgrade(two(), "/v1/hdp").await.contains("101")); // D1, as before packs
        assert!(upgrade(two(), "/v1/hdp/D3").await.contains("404"));
    }

    #[tokio::test]
    async fn on_the_network_another_machine_shows_the_token() {
        let lan = || app_with(&["--listen-lan"], Some("0123456789abcdef0123456789abcdef"));
        let host = ("host", "192.168.1.20:4782");
        let peer = "192.168.1.77:50123";
        // without it, nothing: no session, no device
        for path in ["/v1/sessions", "/v1/link", "/v1/hdp"] {
            let (s, _) = call_from(lan(), peer, "GET", path, &[host]).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{path}");
        }
        let (s, _) = call_from(lan(), peer, "PUT", "/v1/devices/HW-X/alias", &[host]).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // a wrong one, or one of another length
        for bad in [
            "Bearer 0123456789abcdef0123456789abcdee",
            "Bearer 0123",
            "Basic xyz",
        ] {
            let (s, _) = call_from(
                lan(),
                peer,
                "GET",
                "/v1/sessions",
                &[host, ("authorization", bad)],
            )
            .await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{bad}");
        }
        // the token, as a header or in the query (a browser WebSocket cannot set headers)
        let (s, _) = call_from(
            lan(),
            peer,
            "GET",
            "/v1/sessions",
            &[
                host,
                ("authorization", "Bearer 0123456789abcdef0123456789abcdef"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call_from(
            lan(),
            peer,
            "GET",
            "/v1/sessions?token=0123456789abcdef0123456789abcdef",
            &[host],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        // a browser on another machine still needs an allowed origin too
        let (s, _) = call_from(
            lan(),
            peer,
            "GET",
            "/v1/sessions?token=0123456789abcdef0123456789abcdef",
            &[host, ("origin", "https://evil.example")],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // this machine needs no token, as before
        let (s, _) = call_from(lan(), "127.0.0.1:50000", "GET", "/v1/sessions", &[host]).await;
        assert_eq!(s, StatusCode::OK);
        // a peer that cannot be told apart is not this machine
        let res = lan()
            .oneshot(
                HttpRequest::get("/v1/sessions")
                    .header("host", "192.168.1.20:4782")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn tokens_are_new_each_time_and_long_enough() {
        let a = crate::config::new_token().unwrap();
        let b = crate::config::new_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn health_is_exactly_what_was_promised() {
        let res = app(&[])
            .oneshot(
                HttpRequest::get("/v1/health")
                    .header("host", "127.0.0.1:4782")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v, json!({ "status": "ok", "dogd": VERSION, "hdp": 1 }));
    }

    #[tokio::test]
    async fn device_identity_endpoints_answer_and_stay_guarded() {
        let host = [("host", "127.0.0.1:4782")];
        let (s, _) = call(app(&[]), "GET", "/v1/devices", &host).await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call(app(&[]), "GET", "/v1/devices/events?since=0", &host).await;
        assert_eq!(s, StatusCode::OK);
        // Naming a device that does not exist: not found, nothing created.
        let (s, _) = call(app(&[]), "PUT", "/v1/devices/HW-NOPE/alias", &host).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        // A page from elsewhere cannot rename devices on this desk.
        let (s, _) = call(
            app(&[]),
            "PUT",
            "/v1/devices/HW-NOPE/alias",
            &[
                ("host", "127.0.0.1:4782"),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // Binding a port where nothing is attached: not found, nothing written.
        let (s, _) = call(app(&[]), "PUT", "/v1/devices/HW-NOPE/bind", &host).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(
            app(&[]),
            "PUT",
            "/v1/devices/HW-NOPE/bind",
            &[
                ("host", "127.0.0.1:4782"),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
}
