//! The link to one device. Bytes from the device are broadcast to every
//! interface client unchanged; bytes from a client go to the device
//! unchanged. When the link drops, dogd retries; clients are told the link
//! was lost and reconnect, so no session ever spans two links.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch, Mutex};

use crate::config::{Origin, Source};
use crate::protocol::{Hello, LineWatch, HELLO_COMMAND};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LinkState {
    /// No source configured.
    None,
    Connecting,
    Online,
    Lost,
}

#[derive(Clone, Debug, Serialize)]
pub struct LinkStatus {
    /// Its place among dogd's links: D1, D2... (one link: D1).
    pub dog: String,
    pub state: LinkState,
    pub source: String,
    pub origin: &'static str,
    /// What the interface shows as the endpoint, e.g. "DOGD / serial:/dev/ttyACM0".
    pub label: String,
    pub device: Option<Hello>,
    /// Increments on every new connection: a client belongs to one epoch.
    pub epoch: u64,
    pub reason: Option<String>,
}

type Reader = Box<dyn AsyncRead + Unpin + Send>;
/// Called with every hello frame seen and the source it came from.
type OnHello = Box<dyn Fn(&Hello, &str) + Send + Sync>;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

pub struct Link {
    status: watch::Sender<LinkStatus>,
    from_device: broadcast::Sender<Vec<u8>>,
    to_device: mpsc::Sender<Vec<u8>>,
    to_device_rx: Mutex<mpsc::Receiver<Vec<u8>>>,
    /// Called with every hello frame seen, to keep the device index.
    on_hello: OnHello,
}

impl Link {
    pub fn new(
        dog: &str,
        source: &Source,
        origin: Origin,
        on_hello: impl Fn(&Hello, &str) + Send + Sync + 'static,
    ) -> Arc<Link> {
        let state = if *source == Source::None {
            LinkState::None
        } else {
            LinkState::Connecting
        };
        let (status, _) = watch::channel(LinkStatus {
            dog: dog.to_string(),
            state,
            source: source.describe(),
            origin: origin.as_str(),
            label: format!("DOGD / {}", source.describe()),
            device: None,
            epoch: 0,
            reason: None,
        });
        let (from_device, _) = broadcast::channel(4096);
        let (to_device, rx) = mpsc::channel(256);
        Arc::new(Link {
            status,
            from_device,
            to_device,
            to_device_rx: Mutex::new(rx),
            on_hello: Box::new(on_hello),
        })
    }

    pub fn status(&self) -> LinkStatus {
        self.status.borrow().clone()
    }

    pub fn watch(&self) -> watch::Receiver<LinkStatus> {
        self.status.subscribe()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.from_device.subscribe()
    }

    /// Queue bytes for the device. Dropped when no device is online.
    pub async fn send(&self, bytes: Vec<u8>) {
        if self.status.borrow().state == LinkState::Online {
            let _ = self.to_device.send(bytes).await;
        }
    }

    /// Connect, bridge, and reconnect after a loss, for as long as dogd runs.
    pub async fn run(self: Arc<Self>, source: Source) {
        if source == Source::None {
            return;
        }
        let mut rx = self.to_device_rx.lock().await;
        loop {
            self.status.send_modify(|s| s.state = LinkState::Connecting);
            match open(&source).await {
                Ok((reader, writer)) => {
                    // Commands queued for a previous link are stale: never replay them.
                    while rx.try_recv().is_ok() {}
                    self.status.send_modify(|s| {
                        s.state = LinkState::Online;
                        s.epoch += 1;
                        s.reason = None;
                        s.device = None;
                    });
                    let reason = self.bridge(reader, writer, &mut rx, &source).await;
                    self.status.send_modify(|s| {
                        s.state = LinkState::Lost;
                        s.reason = Some(reason);
                    });
                }
                Err(e) => self.status.send_modify(|s| {
                    s.state = LinkState::Lost;
                    s.reason = Some(e);
                }),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn bridge(
        &self,
        mut reader: Reader,
        mut writer: Writer,
        rx: &mut mpsc::Receiver<Vec<u8>>,
        source: &Source,
    ) -> String {
        if let Err(e) = writer.write_all(HELLO_COMMAND).await {
            return format!("write failed: {e}");
        }
        let mut watch = LineWatch::default();
        let mut buf = vec![0u8; 8192];
        loop {
            tokio::select! {
                n = reader.read(&mut buf) => match n {
                    Ok(0) => return "device closed the stream".into(),
                    Err(e) => return format!("read failed: {e}"),
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        for hello in watch.push(&chunk) {
                            (self.on_hello)(&hello, &source.describe());
                            self.status.send_modify(|s| s.device = Some(hello.clone()));
                        }
                        // No receiver is not an error: nobody is watching yet.
                        let _ = self.from_device.send(chunk);
                    }
                },
                cmd = rx.recv() => match cmd {
                    Some(bytes) => {
                        if let Err(e) = writer.write_all(&bytes).await {
                            return format!("write failed: {e}");
                        }
                    }
                    None => return "dogd shutting down".into(),
                },
            }
        }
    }
}

async fn open(source: &Source) -> Result<(Reader, Writer), String> {
    match source {
        Source::None => Err("no source".into()),
        Source::Tcp(addr) => {
            let s = tokio::net::TcpStream::connect(addr)
                .await
                .map_err(|e| format!("tcp {addr}: {e}"))?;
            let _ = s.set_nodelay(true);
            let (r, w) = s.into_split();
            Ok((Box::new(r), Box::new(w)))
        }
        Source::Serial(path) => {
            use tokio_serial::SerialPortBuilderExt;
            let port = tokio_serial::new(path, 115_200)
                .open_native_async()
                .map_err(|e| format!("serial {path}: {e}"))?;
            let (r, w) = tokio::io::split(port);
            Ok((Box::new(r), Box::new(w)))
        }
    }
}
