//! The listening socket, bounded: a peer cannot exhaust dogd before it
//! has even said who it is.
//!
//! CONNECTIONS   64 at a time; the 65th waits for one to close. dogd keeps
//!               file descriptors for the serial port, the store, the
//!               interface: a flood of half-open connections never takes
//!               them.
//! HEADERS       a connection has 10 s to send its first request's headers;
//!               a peer that trickles bytes (slowloris) is dropped before
//!               the guard runs. Refusals close their connection (guard:
//!               `Connection: close`), so a refused peer holds nothing.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Sleep;

pub const MAX_CONNECTIONS: usize = 64;
pub const HEADER_DEADLINE: Duration = Duration::from_secs(10);

pub struct Bounded {
    inner: TcpListener,
    permits: Arc<Semaphore>,
    deadline: Duration,
}

impl Bounded {
    pub fn new(inner: TcpListener, connections: usize, deadline: Duration) -> Self {
        Self {
            inner,
            permits: Arc::new(Semaphore::new(connections)),
            deadline,
        }
    }
}

impl axum::serve::Listener for Bounded {
    type Io = BoundedIo;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .expect("the semaphore is never closed");
        loop {
            match self.inner.accept().await {
                Ok((io, addr)) => {
                    let deadline = Some(Box::pin(tokio::time::sleep(self.deadline)));
                    return (
                        BoundedIo {
                            io,
                            _permit: permit,
                            deadline,
                            seen: 0,
                        },
                        addr,
                    );
                }
                // Out of descriptors, a connection reset before accept: wait, never spin.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// One accepted connection: its slot goes back when it is dropped.
pub struct BoundedIo {
    io: TcpStream,
    _permit: OwnedSemaphorePermit,
    /// Until the first request's headers end (CRLF CRLF): then none.
    deadline: Option<Pin<Box<Sleep>>>,
    /// How much of CRLF CRLF the bytes so far end with.
    seen: u8,
}

const END_OF_HEADERS: [u8; 4] = *b"\r\n\r\n";

/// The next state of the CRLF CRLF search after byte `b`.
fn advance(seen: u8, b: u8) -> u8 {
    if b == END_OF_HEADERS[seen as usize] {
        seen + 1
    } else if b == b'\r' {
        1
    } else {
        0
    }
}

impl AsyncRead for BoundedIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if let Some(deadline) = this.deadline.as_mut() {
            if deadline.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "request headers took longer than 10 s",
                )));
            }
        }
        let before = buf.filled().len();
        let read = Pin::new(&mut this.io).poll_read(cx, buf);
        if let (Poll::Ready(Ok(())), Some(_)) = (&read, &this.deadline) {
            for &b in &buf.filled()[before..] {
                this.seen = advance(this.seen, b);
                if this.seen == 4 {
                    this.deadline = None;
                    break;
                }
            }
        }
        read
    }
}

impl AsyncWrite for BoundedIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write(cx, data)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::serve::Listener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn finds_the_end_of_headers_across_reads() {
        let mut seen = 0;
        for &b in b"GET / HTTP/1.1\r\nHost: x\r\n\r" {
            seen = advance(seen, b);
        }
        assert_eq!(seen, 3);
        assert_eq!(advance(seen, b'\n'), 4);
        assert_eq!(advance(advance(0, b'\r'), b'\r'), 1);
    }

    /// A peer that trickles its headers is cut off; one that finishes them is served.
    #[tokio::test]
    async fn slow_headers_are_dropped_and_connections_are_bounded() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let mut l = Bounded::new(tcp, 1, Duration::from_millis(200));

        let mut slow = TcpStream::connect(addr).await.unwrap();
        slow.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let (mut io, _) = l.accept().await;
        let mut buf = [0u8; 64];
        assert!(io.read(&mut buf).await.unwrap() > 0);
        let err = io.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);

        // its slot is held until it is dropped: the next peer waits
        let _next = TcpStream::connect(addr).await.unwrap();
        let waiting = tokio::time::timeout(Duration::from_millis(100), l.accept()).await;
        assert!(waiting.is_err());
        drop(io);
        let (mut io, _) = tokio::time::timeout(Duration::from_secs(1), l.accept())
            .await
            .unwrap();

        // headers complete within the deadline: no deadline after them
        let mut fast = _next;
        fast.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        assert!(io.read(&mut buf).await.unwrap() > 0);
        tokio::time::sleep(Duration::from_millis(300)).await;
        fast.write_all(b"x").await.unwrap();
        assert_eq!(io.read(&mut buf).await.unwrap(), 1);
    }
}
