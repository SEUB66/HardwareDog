//! Local session storage. The .hdlog file is the evidence; SQLite is only
//! the index. Files are stored byte for byte and never rewritten.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::protocol::Hello;
use crate::sessions::{inspect, Inspection};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  recording_id  TEXT    NOT NULL UNIQUE,
  session_label TEXT    NOT NULL,
  origin        TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  device_id     TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  integrity     TEXT    NOT NULL,
  closure       TEXT,
  sha256        TEXT    NOT NULL,
  bytes         INTEGER NOT NULL,
  hdlog_path    TEXT    NOT NULL,
  stored_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  device_id         TEXT PRIMARY KEY,
  hardware_revision TEXT NOT NULL,
  firmware_version  TEXT NOT NULL,
  hdp_version       INTEGER NOT NULL,
  port              TEXT,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL
);
PRAGMA user_version = 1;
";

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SessionRow {
    pub id: i64,
    pub recording_id: String,
    pub session_label: String,
    pub origin: String,
    pub source: String,
    pub device_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub integrity: String,
    pub closure: Option<String>,
    pub sha256: String,
    pub bytes: i64,
    pub hdlog_path: String,
    pub stored_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DeviceRow {
    pub device_id: String,
    pub hardware_revision: String,
    pub firmware_version: String,
    pub hdp_version: i64,
    pub port: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Debug, PartialEq)]
pub enum PutError {
    Invalid(String),
    /// A finalized recording with this id is already stored, with other bytes.
    Conflict(String),
    Io(String),
}

pub struct Store {
    db: Mutex<Connection>,
    dir: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_recording_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Store, String> {
        let dir = data_dir.join("sessions");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let db =
            Connection::open(data_dir.join("index.sqlite")).map_err(|e| format!("index: {e}"))?;
        db.execute_batch(SCHEMA)
            .map_err(|e| format!("index schema: {e}"))?;
        Ok(Store {
            db: Mutex::new(db),
            dir,
        })
    }

    /// Store a finalized or in-progress .hdlog under its recording id.
    pub fn put(&self, recording_id: &str, data: &[u8]) -> Result<(SessionRow, bool), PutError> {
        if !is_recording_id(recording_id) {
            return Err(PutError::Invalid(
                "recording id must be 32 hex characters".into(),
            ));
        }
        let i: Inspection = inspect(data).map_err(PutError::Invalid)?;
        if i.hdlog != 2 {
            return Err(PutError::Invalid(
                "dogd stores hdlog v2 files (with a recording id)".into(),
            ));
        }
        if i.recording != recording_id {
            return Err(PutError::Invalid(format!(
                "file is recording {}, not {recording_id}",
                i.recording
            )));
        }
        if let Some(existing) = self.session(recording_id) {
            if existing.sha256 == i.sha256 {
                return Ok((existing, false));
            }
            if matches!(
                existing.closure.as_deref(),
                Some("NORMAL") | Some("RECOVERED")
            ) {
                return Err(PutError::Conflict(format!(
                    "recording {recording_id} is already stored, finalized, with sha256 {}",
                    existing.sha256
                )));
            }
        }
        let path = self.dir.join(format!("{recording_id}.hdlog"));
        write_atomic(&path, data).map_err(|e| PutError::Io(e.to_string()))?;
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO sessions (recording_id, session_label, origin, source, device_id, started_at, ended_at,
               integrity, closure, sha256, bytes, hdlog_path, stored_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(recording_id) DO UPDATE SET
               session_label = excluded.session_label, origin = excluded.origin, source = excluded.source,
               device_id = excluded.device_id, started_at = excluded.started_at, ended_at = excluded.ended_at,
               integrity = excluded.integrity, closure = excluded.closure, sha256 = excluded.sha256,
               bytes = excluded.bytes, hdlog_path = excluded.hdlog_path, stored_at = excluded.stored_at",
            params![
                i.recording, i.session, i.origin, i.source, i.device_id, i.started_at, i.ended_at, i.integrity, i.closure,
                i.sha256, i.bytes as i64, path.to_string_lossy(), now_ms()
            ],
        )
        .map_err(|e| PutError::Io(e.to_string()))?;
        drop(db);
        Ok((self.session(recording_id).expect("row just written"), true))
    }

    pub fn sessions(&self) -> Vec<SessionRow> {
        let db = self.db.lock().unwrap();
        let mut q = db
            .prepare("SELECT * FROM sessions ORDER BY started_at DESC")
            .unwrap();
        q.query_map([], row)
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    pub fn session(&self, recording_id: &str) -> Option<SessionRow> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT * FROM sessions WHERE recording_id = ?1",
            [recording_id],
            row,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// The stored file, byte for byte.
    pub fn hdlog(&self, recording_id: &str) -> Option<Vec<u8>> {
        let s = self.session(recording_id)?;
        std::fs::read(s.hdlog_path).ok()
    }

    pub fn saw_device(&self, hello: &Hello, port: &str) {
        let t = now_ms();
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "INSERT INTO devices (device_id, hardware_revision, firmware_version, hdp_version, port, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(device_id) DO UPDATE SET hardware_revision = excluded.hardware_revision,
               firmware_version = excluded.firmware_version, hdp_version = excluded.hdp_version,
               port = excluded.port, last_seen = excluded.last_seen",
            params![hello.device, hello.rev, hello.fw, hello.proto as i64, port, t],
        );
    }

    pub fn devices(&self) -> Vec<DeviceRow> {
        let db = self.db.lock().unwrap();
        let mut q = db
            .prepare("SELECT * FROM devices ORDER BY last_seen DESC")
            .unwrap();
        q.query_map([], |r| {
            Ok(DeviceRow {
                device_id: r.get(0)?,
                hardware_revision: r.get(1)?,
                firmware_version: r.get(2)?,
                hdp_version: r.get(3)?,
                port: r.get(4)?,
                first_seen: r.get(5)?,
                last_seen: r.get(6)?,
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: r.get(0)?,
        recording_id: r.get(1)?,
        session_label: r.get(2)?,
        origin: r.get(3)?,
        source: r.get(4)?,
        device_id: r.get(5)?,
        started_at: r.get(6)?,
        ended_at: r.get(7)?,
        integrity: r.get(8)?,
        closure: r.get(9)?,
        sha256: r.get(10)?,
        bytes: r.get(11)?,
        hdlog_path: r.get(12)?,
        stored_at: r.get(13)?,
    })
}

/// Write to a temporary file, flush it to disk, then rename: a crash never
/// leaves a half-written recording under the real name.
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("hdlog.part");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dogd-test-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn case() -> (String, Vec<u8>) {
        let data = std::fs::read(format!(
            "{}/../cases/HD-C002.hdlog",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        (inspect(&data).unwrap().recording, data)
    }

    #[test]
    fn stores_byte_exact_and_survives_a_restart() {
        let dir = tmp();
        let (id, data) = case();
        {
            let s = Store::open(&dir).unwrap();
            let (row, created) = s.put(&id, &data).unwrap();
            assert!(created);
            assert_eq!(row.integrity, "VERIFIED");
            assert!(!s.put(&id, &data).unwrap().1); // idempotent
        }
        let s = Store::open(&dir).unwrap(); // restart
        assert_eq!(s.sessions().len(), 1);
        assert_eq!(s.hdlog(&id).unwrap(), data);
        assert_eq!(
            s.session(&id).unwrap().sha256,
            crate::sessions::sha256_hex(&data)
        );
    }

    #[test]
    fn never_overwrites_a_finalized_recording() {
        let dir = tmp();
        let (id, data) = case();
        let s = Store::open(&dir).unwrap();
        s.put(&id, &data).unwrap();
        let other = String::from_utf8(data.clone())
            .unwrap()
            .replacen("\"v\":5.0", "\"v\":5.1", 1);
        assert!(matches!(
            s.put(&id, other.as_bytes()),
            Err(PutError::Conflict(_))
        ));
        assert_eq!(s.hdlog(&id).unwrap(), data);
    }

    #[test]
    fn refuses_a_file_under_another_id() {
        let s = Store::open(&tmp()).unwrap();
        let (_, data) = case();
        assert!(matches!(
            s.put("0123456789abcdef0123456789abcdef", &data),
            Err(PutError::Invalid(_))
        ));
        assert!(matches!(
            s.put("../../etc/passwd", &data),
            Err(PutError::Invalid(_))
        ));
    }

    #[test]
    fn remembers_devices() {
        let s = Store::open(&tmp()).unwrap();
        s.saw_device(
            &Hello {
                device: "HD-001".into(),
                rev: "A".into(),
                fw: "0.1.0".into(),
                proto: 1,
            },
            "serial:/dev/ttyACM0",
        );
        assert_eq!(s.devices()[0].device_id, "HD-001");
    }
}
