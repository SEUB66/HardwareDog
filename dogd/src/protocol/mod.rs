//! HDP v1 as dogd sees it: a byte stream it forwards unchanged.
//!
//! dogd never decodes, validates, converts or invents HDP events. The only
//! thing it reads is the `hello` frame, to know which device is on the
//! other end. Validation belongs to the one HDP decoder the interface uses
//! for every transport.

use serde::Serialize;

pub const HDP_VERSION: u32 = 1;
/// Longest HDP line (docs/PROTOCOL.md). Longer lines are skipped by the watcher.
pub const MAX_LINE: usize = 64 * 1024;

/// What the host sends when it opens a link, as the Web Serial transport does.
pub const HELLO_COMMAND: &[u8] = b"{\"cmd\":\"hello\",\"proto\":1}\n";

/// Identity a device announces in its `hello` frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Hello {
    pub device: String,
    pub rev: String,
    pub fw: String,
    pub proto: u64,
    /// 48-bit factory id (12 lowercase hex: the ESP32 eFuse MAC). Absent
    /// on devices from before it, or when it is not well formed: `device`
    /// is 24 bits of the MAC and is not unique.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chip: Option<String>,
}

fn chip_id(v: &serde_json::Value) -> Option<String> {
    let c = v.get("chip")?.as_str()?;
    (c.len() == 12
        && c.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then(|| c.to_string())
}

/// A `hello` frame, or None for any other line (including broken ones:
/// rejecting them is the decoder's job, not dogd's).
pub fn parse_hello(line: &[u8]) -> Option<Hello> {
    let v: serde_json::Value = serde_json::from_slice(line).ok()?;
    if !v.get("type")?.as_str()?.eq_ignore_ascii_case("hello") {
        return None;
    }
    Some(Hello {
        device: v.get("device")?.as_str()?.to_string(),
        rev: v.get("rev")?.as_str()?.to_string(),
        fw: v.get("fw")?.as_str()?.to_string(),
        proto: v.get("proto")?.as_u64()?,
        chip: chip_id(&v),
    })
}

/// Watches a byte stream for `hello` frames without changing it.
#[derive(Default)]
pub struct LineWatch {
    buf: Vec<u8>,
    overflow: bool,
}

impl LineWatch {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Hello> {
        let mut found = Vec::new();
        for &b in chunk {
            if b == b'\n' {
                if !self.overflow {
                    if let Some(h) = parse_hello(&self.buf) {
                        found.push(h);
                    }
                }
                self.buf.clear();
                self.overflow = false;
            } else if !self.overflow {
                self.buf.push(b);
                if self.buf.len() > MAX_LINE {
                    self.buf.clear();
                    self.overflow = true;
                }
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_hello_across_chunks_and_ignores_the_rest() {
        let mut w = LineWatch::default();
        assert!(w
            .push(b"{\"type\":\"power\",\"t\":1,\"v\":5,\"i\":0.1}\n{\"type\":\"hel")
            .is_empty());
        let found = w.push(b"lo\",\"t\":0,\"proto\":1,\"device\":\"HD-001\",\"rev\":\"A\",\"fw\":\"0.1.0\"}\nnot json\n");
        assert_eq!(
            found,
            vec![Hello {
                device: "HD-001".into(),
                rev: "A".into(),
                fw: "0.1.0".into(),
                proto: 1,
                chip: None
            }]
        );
    }

    #[test]
    fn reads_the_48_bit_chip_id_only_when_well_formed() {
        let hello = |chip: &str| {
            parse_hello(format!("{{\"type\":\"hello\",\"t\":0,\"proto\":1,\"device\":\"HD-3A1F2C\",\"rev\":\"A\",\"fw\":\"1\",\"chip\":{chip}}}").as_bytes())
                .unwrap()
                .chip
        };
        assert_eq!(hello("\"7cdfa13a1f2c\""), Some("7cdfa13a1f2c".into()));
        for bad in ["\"3a1f2c\"", "\"7CDFA13A1F2C\"", "\"7cdfa13a1f2g\"", "42"] {
            assert_eq!(hello(bad), None, "{bad}");
        }
    }

    #[test]
    fn skips_oversized_lines() {
        let mut w = LineWatch::default();
        let mut big = vec![b'x'; MAX_LINE + 10];
        big.push(b'\n');
        assert!(w.push(&big).is_empty());
        assert_eq!(w.push(b"{\"type\":\"hello\",\"t\":0,\"proto\":1,\"device\":\"D\",\"rev\":\"A\",\"fw\":\"1\"}\n").len(), 1);
    }
}
