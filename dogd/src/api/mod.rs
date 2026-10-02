//! The local API. Small on purpose: HDP commands are not repeated as REST
//! endpoints, they go through the HDP socket like on every other transport.
//!
//!   GET  /v1/health                  alive, versions
//!   GET  /v1/link                    the device link: state, source, origin, device
//!   GET  /v1/devices                 serial ports + Hardware Dogs seen
//!   GET  /v1/sessions                stored sessions (the index)
//!   GET  /v1/sessions/{id}           one session
//!   GET  /v1/sessions/{id}/hdlog     the file, byte for byte
//!   PUT  /v1/sessions/{id}/hdlog     store a file the interface wrote
//!   WS   /v1/hdp                     raw HDP: device bytes out, command lines in
//!
//! Trust boundary: this machine. Requests must name a loopback host (no DNS
//! rebinding), and a browser page must come from an allowed origin: a web
//! page on the Internet cannot drive a device on this desk.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;

use crate::config::Config;
use crate::device;
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
    pub link: Arc<Link>,
    pub store: Arc<Store>,
    pub cfg: Arc<Config>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/link", get(link))
        .route("/v1/devices", get(devices))
        .route("/v1/sessions", get(sessions))
        .route("/v1/sessions/{id}", get(session))
        .route(
            "/v1/sessions/{id}/hdlog",
            get(get_hdlog)
                .put(put_hdlog)
                .layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        .route("/v1/hdp", get(hdp))
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

async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
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
                HeaderValue::from_static("content-type"),
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
    Json(serde_json::to_value(s.link.status()).unwrap())
}

async fn devices(State(s): State<AppState>) -> Json<serde_json::Value> {
    let ports = tokio::task::spawn_blocking(device::list_ports)
        .await
        .unwrap_or_default();
    Json(json!({ "link": s.link.status(), "ports": ports, "seen": s.store.devices() }))
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
    ws.max_message_size(MAX_LINE + 1024)
        .on_upgrade(move |socket| client(socket, s))
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
async fn client(socket: WebSocket, s: AppState) {
    let (mut tx, mut rx) = socket.split();
    let status = s.link.status();
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
    let mut bytes = s.link.subscribe();
    let mut state = s.link.watch();
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
                Some(Ok(Message::Text(t))) => s.link.send(t.as_bytes().to_vec()).await,
                Some(Ok(Message::Binary(b))) => s.link.send(b.to_vec()).await,
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
        let dir = std::env::temp_dir().join(format!(
            "dogd-api-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        a.extend(["--data".into(), dir.to_string_lossy().into()]);
        let cfg = parse_serve(&a).unwrap();
        let store = Arc::new(Store::open(&cfg.data_dir).unwrap());
        let link = Link::new(&Source::None, cfg.origin, |_, _| {});
        router(AppState {
            link,
            store,
            cfg: Arc::new(cfg),
        })
    }

    async fn call(
        app: Router,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, HeaderMapLite) {
        let mut req = HttpRequest::builder().method(method).uri(path);
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
}
