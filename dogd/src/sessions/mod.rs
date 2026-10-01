//! Inspecting .hdlog files dogd is asked to store.
//!
//! dogd does not write .hdlog: the interface does, with the one writer
//! (web/src/core/session.ts). dogd checks what it receives with the same
//! integrity algorithm as the reader (docs/PROTOCOL.md) and indexes it.
//! Cross-checked by tests: the same files give the same status on both
//! sides.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Inspection {
    pub hdlog: u64,
    pub recording: String,
    pub session: String,
    pub origin: String,
    pub source: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub closure: Option<String>,
    /// VERIFIED | RECOVERED | INCOMPLETE | MODIFIED | UNVERIFIED
    pub integrity: String,
    pub device_id: Option<String>,
    pub sha256: String,
    pub bytes: u64,
    pub problems: Vec<String>,
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const KINDS: [&str; 6] = ["frame", "reject", "cmd", "mark", "thresholds", "lost"];

/// Check a whole file. Structure errors are Err (the file is refused);
/// integrity problems are reported in the Inspection, never hidden.
pub fn inspect(data: &[u8]) -> Result<Inspection, String> {
    if data.len() > MAX_BYTES {
        return Err(format!("file larger than {} MiB", MAX_BYTES / 1024 / 1024));
    }
    std::str::from_utf8(data).map_err(|_| "not UTF-8 text".to_string())?;
    let mut lines: Vec<&[u8]> = data.split(|&b| b == b'\n').collect();
    if lines.last() == Some(&&b""[..]) {
        lines.pop();
    }
    let first = *lines.first().ok_or("empty file")?;
    let header: Value =
        serde_json::from_slice(first).map_err(|_| "line 1: header is not JSON".to_string())?;
    let hdlog = header
        .get("hdlog")
        .and_then(Value::as_u64)
        .ok_or("line 1: not an .hdlog file")?;
    if hdlog != 1 && hdlog != 2 {
        return Err(format!("line 1: unknown hdlog version {hdlog}"));
    }
    let text = |k: &str| header.get(k).and_then(Value::as_str).map(str::to_string);
    let source = text("source").ok_or("line 1: header field \"source\" missing")?;
    let derived = if source == "SIMULATOR" {
        "SIMULATED"
    } else {
        "PHYSICAL"
    };
    let origin = text("origin").unwrap_or_else(|| derived.to_string());
    let mut out = Inspection {
        hdlog,
        recording: text("recording").unwrap_or_default(),
        session: text("id").ok_or("line 1: header field \"id\" missing")?,
        origin,
        source,
        started_at: header
            .get("startedAt")
            .and_then(Value::as_i64)
            .ok_or("line 1: header field \"startedAt\" missing")?,
        ended_at: None,
        closure: None,
        integrity: "UNVERIFIED".into(),
        device_id: None,
        sha256: sha256_hex(data),
        bytes: data.len() as u64,
        problems: Vec::new(),
    };

    let mut chain = sha256_hex(&[first, b"\n"].concat());
    let mut payload = Sha256::new();
    payload.update(first);
    payload.update(b"\n");
    let mut block = Vec::<u8>::new();
    let mut block_lines = 0u64;
    let mut seals = 0u64;
    let mut counts = [0u64; 6];
    let mut entries = 0u64;
    let mut device: Value = Value::Null;
    let mut footer: Option<(Value, usize)> = None;
    let mut last_at = i64::MIN;

    for (n, line) in lines.iter().enumerate().skip(1) {
        let at = n + 1;
        if footer.is_some() {
            out.problems
                .push(format!("line {at}: data after the footer"));
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            if hdlog == 2 {
                out.problems.push(format!("line {at}: blank line inserted"));
            }
            continue;
        }
        let e: Value = serde_json::from_slice(line).map_err(|_| format!("line {at}: not JSON"))?;
        if hdlog == 2 {
            if let Some(seal) = e.get("seal") {
                let claimed = seal
                    .get("sha256")
                    .and_then(Value::as_str)
                    .ok_or(format!("line {at}: malformed seal"))?;
                chain = sha256_hex(&[chain.as_bytes(), &block].concat());
                seals += 1;
                if claimed != chain {
                    out.problems.push(format!(
                        "line {at}: seal {seals} does not match the {block_lines} lines above it"
                    ));
                } else if seal.get("lines").and_then(Value::as_u64) != Some(block_lines)
                    || seal.get("n").and_then(Value::as_u64) != Some(seals)
                {
                    out.problems
                        .push(format!("line {at}: seal {seals} numbering does not match"));
                }
                chain = claimed.to_string();
                payload.update(line);
                payload.update(b"\n");
                block.clear();
                block_lines = 0;
                continue;
            }
            if let Some(end) = e.get("end") {
                footer = Some((end.clone(), at));
                continue;
            }
        }
        let t = e
            .get("at")
            .and_then(Value::as_f64)
            .ok_or(format!("line {at}: entry without \"at\""))?;
        if (t as i64) < last_at {
            return Err(format!("line {at}: time goes backwards"));
        }
        last_at = t as i64;
        let kinds: Vec<usize> = (0..6).filter(|&k| e.get(KINDS[k]).is_some()).collect();
        if kinds.len() != 1 {
            return Err(format!(
                "line {at}: entry must have exactly one of {}",
                KINDS.join(" / ")
            ));
        }
        counts[kinds[0]] += 1;
        entries += 1;
        if let Some(f) = e.get("frame") {
            if f.get("type").and_then(Value::as_str) == Some("hello") {
                device = serde_json::json!({ "id": f.get("device"), "rev": f.get("rev"), "fw": f.get("fw") });
            }
        }
        block.extend_from_slice(line);
        block.push(b'\n');
        block_lines += 1;
        payload.update(line);
        payload.update(b"\n");
    }

    if hdlog == 1 {
        return Ok(out);
    }
    if let Some((end, at)) = &footer {
        let at = format!("line {at}");
        if block_lines > 0 {
            out.problems.push(format!(
                "{at}: {block_lines} entries before the footer are not sealed"
            ));
        }
        if end.get("sha256").and_then(Value::as_str) != Some(&hex(&payload.finalize())) {
            out.problems
                .push(format!("{at}: footer hash does not match the file"));
        }
        let expect = [
            ("entries", entries),
            ("frames", counts[0]),
            ("rejects", counts[1]),
            ("commands", counts[2]),
            ("marks", counts[3]),
            ("thresholds", counts[4]),
            ("lost", counts[5]),
            ("seals", seals),
        ];
        for (k, v) in expect {
            if end.get(k).and_then(Value::as_u64) != Some(v) {
                out.problems.push(format!(
                    "{at}: footer says {k} = {}, file has {v}",
                    end.get(k).unwrap_or(&Value::Null)
                ));
            }
        }
        if end.get("startedAt").and_then(Value::as_i64) != Some(out.started_at) {
            out.problems
                .push(format!("{at}: footer startedAt does not match the header"));
        }
        if end.get("device").unwrap_or(&Value::Null) != &device {
            out.problems.push(format!(
                "{at}: footer device does not match the hello frame"
            ));
        }
        out.ended_at = end.get("endedAt").and_then(Value::as_i64);
        out.closure = end
            .get("closed")
            .and_then(Value::as_str)
            .map(str::to_string);
        out.device_id = end
            .get("device")
            .and_then(|d| d.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    out.integrity = if !out.problems.is_empty() {
        "MODIFIED"
    } else if footer.is_none() {
        "INCOMPLETE"
    } else if out.closure.as_deref() == Some("RECOVERED") {
        "RECOVERED"
    } else {
        "VERIFIED"
    }
    .into();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Files written by the interface (web/src/core/session.ts).
    fn case(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/../cases/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn verifies_files_written_by_the_interface() {
        for name in ["HD-C001.hdlog", "HD-C002.hdlog", "HD-C003.hdlog"] {
            let data = case(name);
            let i = inspect(&data).unwrap();
            assert_eq!(i.integrity, "VERIFIED", "{name}: {:?}", i.problems);
            assert_eq!(i.origin, "SIMULATED");
            assert_eq!(i.closure.as_deref(), Some("NORMAL"));
            assert_eq!(i.device_id.as_deref(), Some("HD-001"));
            assert_eq!(i.recording.len(), 32);
        }
    }

    #[test]
    fn the_case_file_names_the_same_hash() {
        let c: Value = serde_json::from_slice(&case("HD-C002.case.json")).unwrap();
        assert_eq!(
            inspect(&case("HD-C002.hdlog")).unwrap().sha256,
            c["recording"]["sha256"].as_str().unwrap()
        );
    }

    #[test]
    fn detects_what_the_interface_detects() {
        let text = String::from_utf8(case("HD-C002.hdlog")).unwrap();
        let changed = text.replacen("\"v\":5.0", "\"v\":5.1", 1);
        let i = inspect(changed.as_bytes()).unwrap();
        assert_eq!(i.integrity, "MODIFIED");
        assert!(
            i.problems[0].contains("seal 1 does not match"),
            "{:?}",
            i.problems
        );

        let crlf = text.replace('\n', "\r\n");
        assert_eq!(inspect(crlf.as_bytes()).unwrap().integrity, "MODIFIED");

        let lines: Vec<&str> = text.lines().collect();
        let truncated = lines[..lines.len() - 1].join("\n") + "\n";
        assert_eq!(
            inspect(truncated.as_bytes()).unwrap().integrity,
            "INCOMPLETE"
        );

        let extra = format!("{text}{{\"at\":1,\"mark\":\"late\"}}\n");
        assert!(inspect(extra.as_bytes()).unwrap().problems[0].contains("after the footer"));
    }

    #[test]
    fn refuses_broken_files() {
        assert!(inspect(b"").is_err());
        assert!(inspect(b"{\"hdlog\":9}\n")
            .unwrap_err()
            .contains("unknown hdlog version"));
        assert!(inspect(&[0xff, 0xfe]).is_err());
    }
}
