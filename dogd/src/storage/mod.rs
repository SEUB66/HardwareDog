//! Local session storage. The .hdlog file is the evidence; SQLite is only
//! the index. Files are stored byte for byte and never rewritten.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::identity::{self, Fingerprint, Known, Resolution, Strength};
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
";

/// Index v2: hardware identities (identity/mod.rs), plug events, and the
/// serials proven shared. Added next to v1, which is kept as is: an older
/// index opens, and its Hardware Dogs become identities by their legacy
/// (24-bit) HDP device id.
const SCHEMA_V2: &str = "
CREATE TABLE IF NOT EXISTS hw_devices (
  id             TEXT PRIMARY KEY,
  alias          TEXT,
  transport      TEXT,
  vid            INTEGER,
  pid            INTEGER,
  manufacturer   TEXT,
  product        TEXT,
  serial         TEXT,
  serial_trusted INTEGER NOT NULL DEFAULT 1,
  usb_path       TEXT,
  interface      TEXT,
  mac            TEXT,
  chip_id        TEXT,
  legacy_id      TEXT,
  strength       TEXT    NOT NULL,
  basis          TEXT    NOT NULL,
  ambiguous_with TEXT,
  hint           TEXT,
  superseded_by  TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  last_port      TEXT
);
CREATE TABLE IF NOT EXISTS hw_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  t         INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  device_id TEXT,
  port      TEXT    NOT NULL,
  strength  TEXT,
  basis     TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS hw_shared_serials (
  vid    INTEGER NOT NULL,
  pid    INTEGER NOT NULL,
  serial TEXT    NOT NULL,
  t      INTEGER NOT NULL,
  reason TEXT    NOT NULL,
  PRIMARY KEY (vid, pid, serial)
);
";

pub const INDEX_VERSION: i64 = 2;

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
        migrate(&db).map_err(|e| format!("index migration: {e}"))?;
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
        if i.hdlog < 2 {
            return Err(PutError::Invalid(
                "dogd stores hdlog v2 and v3 files (with a recording id)".into(),
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

/// Bring an index up to INDEX_VERSION. Additive only: a table is never
/// dropped or rewritten, so an older dogd's data stays readable.
fn migrate(db: &Connection) -> rusqlite::Result<()> {
    let v: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v > INDEX_VERSION {
        // A newer dogd wrote this index: read what we know, change nothing.
        return Ok(());
    }
    if v < 2 {
        db.execute_batch(SCHEMA_V2)?;
        // The Hardware Dogs seen by v1 are known by their HDP device id: 24
        // bits of the MAC, not unique. Carried over as a legacy key (GOOD),
        // never as a chip id.
        let old: Vec<(String, Option<String>, i64, i64)> = {
            let mut q = db.prepare("SELECT device_id, port, first_seen, last_seen FROM devices")?;
            let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (device, port, first, last) in old {
            let l = device.trim().to_ascii_lowercase();
            db.execute(
                "INSERT OR IGNORE INTO hw_devices (id, legacy_id, strength, basis, first_seen, last_seen, last_port)
                 VALUES (?1, ?2, 'GOOD', ?3, ?4, ?5, ?6)",
                params![
                    identity::identity_id(&format!("hdp24:{l}")),
                    device,
                    format!("HDP device id {l} (24 bits of the MAC, not unique: legacy, from index v1)"),
                    first,
                    last,
                    port
                ],
            )?;
        }
        db.execute_batch("PRAGMA user_version = 2;")?;
    }
    Ok(())
}

/// One hardware identity, as stored.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HwDevice {
    pub id: String,
    pub alias: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    /// Kept for display even when it is not trusted.
    pub serial: Option<String>,
    /// False once the serial is proven shared: it is no longer a key.
    pub serial_trusted: bool,
    pub usb_path: Option<String>,
    pub interface: Option<String>,
    pub mac: Option<String>,
    pub chip_id: Option<String>,
    pub legacy_id: Option<String>,
    pub strength: String,
    pub basis: String,
    /// Look-alikes it could not be told from, until the user binds it.
    pub ambiguous_with: Option<String>,
    /// A known identity a weaker key pointed to, not merged.
    pub hint: Option<String>,
    /// Bound by the user to another identity: kept, no longer resolved.
    pub superseded_by: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    pub last_port: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HwEvent {
    pub seq: i64,
    pub t: i64,
    pub kind: String,
    pub device_id: Option<String>,
    pub port: String,
    pub strength: Option<String>,
    pub basis: String,
}

/// What an attachment resolved to. `id` None: no identity (a bare port).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Observation {
    pub port: String,
    pub id: Option<String>,
    pub alias: Option<String>,
    pub strength: Option<String>,
    pub basis: String,
    /// Created by this attachment.
    pub new: bool,
    pub ambiguous_with: Vec<String>,
    pub hint: Option<String>,
    pub fingerprint: Fingerprint,
}

const HW_COLUMNS: &str =
    "id, alias, vid, pid, manufacturer, product, serial, serial_trusted, usb_path, interface, mac, chip_id,
    legacy_id, strength, basis, ambiguous_with, hint, superseded_by, first_seen, last_seen, last_port";

fn hw_row(r: &rusqlite::Row) -> rusqlite::Result<HwDevice> {
    Ok(HwDevice {
        id: r.get(0)?,
        alias: r.get(1)?,
        vid: r.get::<_, Option<i64>>(2)?.map(|v| v as u16),
        pid: r.get::<_, Option<i64>>(3)?.map(|v| v as u16),
        manufacturer: r.get(4)?,
        product: r.get(5)?,
        serial: r.get(6)?,
        serial_trusted: r.get::<_, i64>(7)? != 0,
        usb_path: r.get(8)?,
        interface: r.get(9)?,
        mac: r.get(10)?,
        chip_id: r.get(11)?,
        legacy_id: r.get(12)?,
        strength: r.get(13)?,
        basis: r.get(14)?,
        ambiguous_with: r.get(15)?,
        hint: r.get(16)?,
        superseded_by: r.get(17)?,
        first_seen: r.get(18)?,
        last_seen: r.get(19)?,
        last_port: r.get(20)?,
    })
}

/// The strength a stored identity has, from the keys it holds.
fn record_strength(d: &HwDevice) -> Strength {
    if d.chip_id.is_some() || d.mac.is_some() || (d.serial.is_some() && d.serial_trusted) {
        Strength::Excellent
    } else if d.legacy_id.is_some() || d.usb_path.is_some() {
        Strength::Good
    } else {
        Strength::Medium
    }
}

fn db_err(e: rusqlite::Error) -> String {
    format!("index: {e}")
}

impl Store {
    pub fn hw_devices(&self) -> Vec<HwDevice> {
        let db = self.db.lock().unwrap();
        let mut q = db
            .prepare(&format!(
                "SELECT {HW_COLUMNS} FROM hw_devices ORDER BY last_seen DESC, id"
            ))
            .unwrap();
        q.query_map([], hw_row)
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    pub fn hw_device(&self, id: &str) -> Option<HwDevice> {
        let db = self.db.lock().unwrap();
        db.query_row(
            &format!("SELECT {HW_COLUMNS} FROM hw_devices WHERE id = ?1"),
            [id],
            hw_row,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Identities the resolver may answer with: not superseded, and with a
    /// serial only while it is trusted.
    pub fn known(&self) -> Vec<Known> {
        self.hw_devices()
            .into_iter()
            .filter(|d| d.superseded_by.is_none())
            .map(|d| Known {
                id: d.id,
                alias: d.alias,
                vid: d.vid,
                pid: d.pid,
                manufacturer: d.manufacturer,
                product: d.product,
                serial: d.serial.filter(|_| d.serial_trusted),
                usb_path: d.usb_path,
                interface: d.interface,
                mac: d.mac,
                chip_id: d.chip_id,
                legacy_id: d.legacy_id,
            })
            .collect()
    }

    fn serial_distrusted(&self, vid: Option<u16>, pid: Option<u16>, serial: &str) -> bool {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT 1 FROM hw_shared_serials WHERE vid = ?1 AND pid = ?2 AND serial = ?3",
            params![vid.map(i64::from), pid.map(i64::from), serial],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    }

    /// The serial this fingerprint can be recognised by: plausible, not
    /// shared right now, and never proven shared before. Read only.
    pub fn trusted_serial(&self, fp: &Fingerprint, others: &[Fingerprint]) -> Option<String> {
        identity::usable_serial(fp, others).filter(|s| !self.serial_distrusted(fp.vid, fp.pid, s))
    }

    /// Read-only resolution, as `observe` would answer without recording.
    pub fn preview(
        &self,
        fp: &Fingerprint,
        others: &[Fingerprint],
        present: &[String],
    ) -> Resolution {
        let serial = self.trusted_serial(fp, others);
        identity::resolve(fp, &serial, &self.known(), present)
    }

    /// Proof that a serial is not unique: remember it, and take it away
    /// from every identity that was relying on it. Once is for good.
    fn distrust_serial(
        &self,
        fp: &Fingerprint,
        serial: &str,
        reason: &str,
        t: i64,
    ) -> Result<(), String> {
        let (Some(vid), Some(pid)) = (fp.vid, fp.pid) else {
            return Ok(());
        };
        let port = fp.port.clone().unwrap_or_default();
        let affected: Vec<HwDevice> = {
            let db = self.db.lock().unwrap();
            let n = db
                .execute(
                    "INSERT OR IGNORE INTO hw_shared_serials (vid, pid, serial, t, reason) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![i64::from(vid), i64::from(pid), serial, t, reason],
                )
                .map_err(db_err)?;
            if n == 0 {
                return Ok(()); // already known to be shared
            }
            let mut q = db
                .prepare(&format!(
                    "SELECT {HW_COLUMNS} FROM hw_devices
                     WHERE vid = ?1 AND pid = ?2 AND lower(serial) = ?3 AND serial_trusted = 1"
                ))
                .map_err(db_err)?;
            let rows = q
                .query_map(params![i64::from(vid), i64::from(pid), serial], hw_row)
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        let basis = format!(
            "serial {serial} on {vid:04X}:{pid:04X} is not unique ({reason}): no longer an identity"
        );
        for mut d in affected {
            d.serial_trusted = false;
            let strength = record_strength(&d).as_str();
            self.db
                .lock()
                .unwrap()
                .execute(
                    "UPDATE hw_devices SET serial_trusted = 0, strength = ?2 WHERE id = ?1",
                    params![d.id, strength],
                )
                .map_err(db_err)?;
            self.event(
                t,
                "SERIAL_DOWNGRADED",
                Some(&d.id),
                &port,
                Some(strength),
                &basis,
            )?;
        }
        Ok(())
    }

    /// A device was attached (or said who it is): resolve it, remember it,
    /// log the event. `others`: what else is plugged in; `present`: their
    /// ids. `adopt`: the identity this same attachment created, which may
    /// take a stronger key the device declares (it has no other past).
    /// Nothing is claimed stored unless it was: an index error is returned.
    pub fn observe(
        &self,
        kind: &str,
        fp: &Fingerprint,
        others: &[Fingerprint],
        present: &[String],
        adopt: Option<&str>,
    ) -> Result<Observation, String> {
        let t = now_ms();
        // Proofs that a serial is shared, kept for good.
        if let Some(s) = identity::plausible_serial(fp) {
            if identity::serial_shared_now(fp, others) {
                self.distrust_serial(fp, &s, "two devices plugged in at the same time", t)?;
            } else if let Some(chip) = fp.chip_id.as_deref() {
                let other_chip = self.known().into_iter().any(|k| {
                    k.vid == fp.vid
                        && k.pid == fp.pid
                        && k.serial.as_deref().map(str::to_ascii_lowercase).as_deref()
                            == Some(s.as_str())
                        && k.chip_id
                            .as_deref()
                            .is_some_and(|c| !c.eq_ignore_ascii_case(chip))
                });
                if other_chip {
                    self.distrust_serial(fp, &s, "the same serial on two chip ids", t)?;
                }
            }
        }
        let serial = self.trusted_serial(fp, others);
        let r = identity::resolve(fp, &serial, &self.known(), present);
        let port = fp.port.clone().unwrap_or_default();
        let (id, new, ambiguous, hint, basis) = match r {
            Resolution::Unidentified { basis } => (None, false, vec![], None, basis),
            Resolution::Known { id, basis, .. } => (Some(id), false, vec![], None, basis),
            // The record this attachment created a moment ago: its whole
            // past is this attachment, it takes the stronger key.
            Resolution::New {
                basis,
                hint: Some(h),
                ..
            } if adopt == Some(h.as_str()) => (
                Some(h),
                true,
                vec![],
                None,
                format!("{basis}, declared on its first attachment"),
            ),
            Resolution::New { basis, hint, .. } => {
                let basis = match &hint {
                    Some(h) => format!(
                        "{basis}; {h} was matched by a weaker key only: not merged (dogd bind PORT {h} if they are the same device)"
                    ),
                    None => basis,
                };
                (
                    Some(self.fresh_id(&identity::identity_key(fp, &serial))),
                    true,
                    vec![],
                    hint,
                    basis,
                )
            }
            Resolution::Ambiguous { candidates, basis } => {
                // Not one of them: a provisional identity of its own, with
                // the look-alikes named, until the user binds it.
                let key = format!("{}:ambiguous", identity::identity_key(fp, &serial));
                (Some(self.fresh_id(&key)), true, candidates, None, basis)
            }
        };
        let record = match &id {
            Some(id) => {
                Some(self.upsert(id, fp, &serial, &basis, &ambiguous, hint.as_deref(), t)?)
            }
            None => None,
        };
        let strength = record.as_ref().map(|d| d.strength.clone());
        self.event(t, kind, id.as_deref(), &port, strength.as_deref(), &basis)?;
        Ok(Observation {
            port,
            id,
            alias: record.and_then(|d| d.alias),
            strength,
            basis,
            new,
            ambiguous_with: ambiguous,
            hint,
            fingerprint: fp.clone(),
        })
    }

    /// The user says what is attached here is `target`: the one operation
    /// that settles an ambiguity or confirms a hint. Refused when the two
    /// cannot be the same device (different chip id, MAC, HDP id or trusted
    /// serial) or when `target` is attached elsewhere right now. `current`:
    /// the identity the attachment has now; it is kept, marked superseded.
    pub fn bind(
        &self,
        fp: &Fingerprint,
        others: &[Fingerprint],
        present: &[String],
        current: Option<&str>,
        target: &str,
    ) -> Result<Observation, String> {
        let Some(d) = self.hw_device(target) else {
            return Err(format!("no device {target}"));
        };
        if let Some(by) = &d.superseded_by {
            return Err(format!("{target} was bound to {by}: bind to {by}"));
        }
        if present.iter().any(|p| p == target) {
            return Err(format!(
                "{target} is attached on another port right now: it cannot be this device"
            ));
        }
        let serial = self.trusted_serial(fp, others);
        let k = self
            .known()
            .into_iter()
            .find(|k| k.id == target)
            .expect("not superseded, so known");
        if let Some(why) = identity::conflict(fp, &serial, &k) {
            return Err(format!("refused: {why}, never the same device"));
        }
        let port = fp.port.clone().unwrap_or_default();
        let t = now_ms();
        let was = current.filter(|c| *c != target);
        let basis = match was {
            Some(c) => format!("bound by the user on {port} (was {c})"),
            None => format!("bound by the user on {port}"),
        };
        let record = self.upsert(target, fp, &serial, &basis, &[], None, t)?;
        {
            let db = self.db.lock().unwrap();
            db.execute(
                "UPDATE hw_devices SET ambiguous_with = NULL, hint = NULL WHERE id = ?1",
                [target],
            )
            .map_err(db_err)?;
            if let Some(c) = was {
                db.execute(
                    "UPDATE hw_devices SET superseded_by = ?2 WHERE id = ?1",
                    params![c, target],
                )
                .map_err(db_err)?;
            }
        }
        self.event(
            t,
            "BOUND",
            Some(target),
            &port,
            Some(&record.strength),
            &basis,
        )?;
        Ok(Observation {
            port,
            id: Some(target.to_string()),
            alias: record.alias,
            strength: Some(record.strength),
            basis,
            new: false,
            ambiguous_with: vec![],
            hint: None,
            fingerprint: fp.clone(),
        })
    }

    pub fn detached(&self, port: &str, id: Option<&str>) -> Result<(), String> {
        self.event(now_ms(), "DETACHED", id, port, None, "unplugged")
    }

    /// An id derived from the key, made unique if the key is shared.
    fn fresh_id(&self, key: &str) -> String {
        let base = identity::identity_id(key);
        let mut id = base.clone();
        let mut n = 2;
        while self.hw_device(&id).is_some() {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert(
        &self,
        id: &str,
        fp: &Fingerprint,
        serial: &Option<String>,
        basis: &str,
        ambiguous: &[String],
        hint: Option<&str>,
        t: i64,
    ) -> Result<HwDevice, String> {
        let old = self.hw_device(id);
        let keep = |new: &Option<String>, old: Option<&Option<String>>| {
            new.clone().or_else(|| old.cloned().flatten())
        };
        let o = old.as_ref();
        // The serial: a trusted one is a key; otherwise what was stored is
        // kept, and a new record keeps the reported value, untrusted, for
        // display only.
        let (serial, serial_trusted) = match (serial, o) {
            (Some(s), _) => (Some(s.clone()), true),
            (None, Some(d)) if d.serial.is_some() => (d.serial.clone(), d.serial_trusted),
            (None, _) => (
                fp.serial
                    .as_ref()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                false,
            ),
        };
        let mut d = HwDevice {
            id: id.to_string(),
            alias: o.and_then(|d| d.alias.clone()),
            vid: fp.vid.or(o.and_then(|d| d.vid)),
            pid: fp.pid.or(o.and_then(|d| d.pid)),
            manufacturer: keep(&fp.manufacturer, o.map(|d| &d.manufacturer)),
            product: keep(&fp.product, o.map(|d| &d.product)),
            serial,
            serial_trusted,
            usb_path: keep(&fp.usb_path, o.map(|d| &d.usb_path)),
            interface: keep(&fp.interface, o.map(|d| &d.interface)),
            mac: keep(&fp.mac, o.map(|d| &d.mac)),
            chip_id: keep(&fp.chip_id, o.map(|d| &d.chip_id)),
            legacy_id: keep(&fp.legacy_id, o.map(|d| &d.legacy_id)),
            strength: String::new(),
            basis: basis.to_string(),
            ambiguous_with: if ambiguous.is_empty() {
                o.and_then(|d| d.ambiguous_with.clone())
            } else {
                Some(ambiguous.join(" "))
            },
            hint: hint
                .map(String::from)
                .or_else(|| o.and_then(|d| d.hint.clone())),
            superseded_by: o.and_then(|d| d.superseded_by.clone()),
            first_seen: o.map_or(t, |d| d.first_seen),
            last_seen: t,
            last_port: fp.port.clone().or(o.and_then(|d| d.last_port.clone())),
        };
        d.strength = record_strength(&d).as_str().to_string();
        let transport = fp.transport.map(|t| format!("{t:?}").to_ascii_uppercase());
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO hw_devices (id, alias, transport, vid, pid, manufacturer, product, serial, serial_trusted, usb_path,
               interface, mac, chip_id, legacy_id, strength, basis, ambiguous_with, hint, superseded_by, first_seen, last_seen, last_port)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
             ON CONFLICT(id) DO UPDATE SET transport = COALESCE(excluded.transport, transport), vid = excluded.vid, pid = excluded.pid,
               manufacturer = excluded.manufacturer, product = excluded.product, serial = excluded.serial,
               serial_trusted = excluded.serial_trusted, usb_path = excluded.usb_path, interface = excluded.interface,
               mac = excluded.mac, chip_id = excluded.chip_id, legacy_id = excluded.legacy_id, strength = excluded.strength,
               basis = excluded.basis, ambiguous_with = excluded.ambiguous_with, hint = excluded.hint,
               last_seen = excluded.last_seen, last_port = excluded.last_port",
            params![
                d.id, d.alias, transport, d.vid.map(i64::from), d.pid.map(i64::from), d.manufacturer, d.product, d.serial,
                d.serial_trusted as i64, d.usb_path, d.interface, d.mac, d.chip_id, d.legacy_id, d.strength, d.basis,
                d.ambiguous_with, d.hint, d.superseded_by, d.first_seen, d.last_seen, d.last_port
            ],
        )
        .map_err(db_err)?;
        Ok(d)
    }

    fn event(
        &self,
        t: i64,
        kind: &str,
        id: Option<&str>,
        port: &str,
        strength: Option<&str>,
        basis: &str,
    ) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO hw_events (t, kind, device_id, port, strength, basis) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![t, kind, id, port, strength, basis],
        )
        .map(|_| ())
        .map_err(db_err)
    }

    pub fn hw_events(&self, since: i64, limit: i64) -> Vec<HwEvent> {
        let db = self.db.lock().unwrap();
        let mut q = db
            .prepare("SELECT seq, t, kind, device_id, port, strength, basis FROM hw_events WHERE seq > ?1 ORDER BY seq LIMIT ?2")
            .unwrap();
        q.query_map(params![since, limit], |r| {
            Ok(HwEvent {
                seq: r.get(0)?,
                t: r.get(1)?,
                kind: r.get(2)?,
                device_id: r.get(3)?,
                port: r.get(4)?,
                strength: r.get(5)?,
                basis: r.get(6)?,
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// A label for people. It does not tell look-alikes apart and settles
    /// nothing: an ambiguous identity stays ambiguous (that is `bind`).
    /// Empty clears it.
    pub fn set_alias(&self, id: &str, alias: &str) -> Result<(), String> {
        let alias = alias.trim();
        if alias.chars().count() > 64 || alias.chars().any(char::is_control) {
            return Err("an alias is 64 printable characters at most".into());
        }
        let db = self.db.lock().unwrap();
        let n = db
            .execute(
                "UPDATE hw_devices SET alias = ?2 WHERE id = ?1",
                params![id, if alias.is_empty() { None } else { Some(alias) }],
            )
            .map_err(db_err)?;
        if n == 0 {
            return Err(format!("no device {id}"));
        }
        Ok(())
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
        // Unique per call: tests run in parallel, often within the same millisecond.
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d =
            std::env::temp_dir().join(format!("dogd-test-{}-{}-{n}", std::process::id(), now_ms()));
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
                chip: None,
            },
            "serial:/dev/ttyACM0",
        );
        assert_eq!(s.devices()[0].device_id, "HD-001");
    }

    /// The index exactly as dogd 0.1 (index v1) wrote it.
    const V1_INDEX: &str = "
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE, session_label TEXT NOT NULL, origin TEXT NOT NULL,
  source TEXT NOT NULL, device_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, integrity TEXT NOT NULL,
  closure TEXT, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, hdlog_path TEXT NOT NULL, stored_at INTEGER NOT NULL);
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY, hardware_revision TEXT NOT NULL, firmware_version TEXT NOT NULL,
  hdp_version INTEGER NOT NULL, port TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
PRAGMA user_version = 1;
INSERT INTO sessions VALUES (1, 'f5db768b4dfb92c6a433abbdb061a370', 'HD-20260930-1421', 'SIMULATED', 'SIMULATOR', 'HD-001',
  1759242060000, 1759242090000, 'VERIFIED', 'NORMAL', 'abc', 123, '/old/path.hdlog', 1759242091000);
INSERT INTO devices VALUES ('HD-3A1F2C', 'DEVKIT-S3', '0.1.0', 1, 'serial:/dev/ttyACM0', 1759000000000, 1759100000000);
";

    #[test]
    fn an_index_from_dogd_0_1_stays_readable_after_migration() {
        let dir = tmp();
        Connection::open(dir.join("index.sqlite"))
            .unwrap()
            .execute_batch(V1_INDEX)
            .unwrap();
        let s = Store::open(&dir).unwrap();
        // Old history: unchanged, readable.
        let rows = s.sessions();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].recording_id, "f5db768b4dfb92c6a433abbdb061a370");
        assert_eq!(s.devices()[0].device_id, "HD-3A1F2C");
        // The Hardware Dog it knew is now an identity by its legacy 24-bit
        // HDP id: GOOD, never a chip id.
        let hw = s.hw_devices();
        assert_eq!(hw.len(), 1);
        assert_eq!(hw[0].legacy_id.as_deref(), Some("HD-3A1F2C"));
        assert_eq!(hw[0].chip_id, None);
        assert_eq!(hw[0].strength, "GOOD");
        let v: i64 =
            s.db.lock()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
        assert_eq!(v, INDEX_VERSION);
        // Opening again changes nothing: migrations run once.
        drop(s);
        let s = Store::open(&dir).unwrap();
        assert_eq!(s.hw_devices().len(), 1);
        assert_eq!(s.sessions().len(), 1);
    }

    fn ch340(port: &str, path: &str) -> Fingerprint {
        Fingerprint {
            transport: Some(identity::Transport::Usb),
            vid: Some(0x1a86),
            pid: Some(0x7523),
            product: Some("USB Serial".into()),
            usb_path: Some(path.into()),
            interface: Some("1.0 class ff".into()),
            port: Some(port.into()),
            ..Default::default()
        }
    }

    fn obs(s: &Store, fp: &Fingerprint, others: &[Fingerprint], present: &[String]) -> Observation {
        s.observe("ATTACHED", fp, others, present, None).unwrap()
    }

    #[test]
    fn unplug_replug_and_restart_keep_one_identity_and_its_alias() {
        let dir = tmp();
        let s = Store::open(&dir).unwrap();
        let a = obs(&s, &ch340("/dev/ttyUSB0", "1-2"), &[], &[]);
        assert!(a.new);
        let id = a.id.clone().unwrap();
        s.set_alias(&id, "bench probe A").unwrap();
        s.detached("/dev/ttyUSB0", Some(&id)).unwrap();
        drop(s);
        let s = Store::open(&dir).unwrap(); // dogd restarted
        let again = obs(&s, &ch340("/dev/ttyUSB4", "1-2"), &[], &[]);
        assert_eq!(again.id.as_deref(), Some(id.as_str()));
        assert!(!again.new);
        assert_eq!(again.alias.as_deref(), Some("bench probe A"));
        assert_eq!(s.hw_devices().len(), 1, "a replug never creates a device");
        let kinds: Vec<String> = s.hw_events(0, 10).into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, ["ATTACHED", "DETACHED", "ATTACHED"]);
    }

    #[test]
    fn identical_dongles_get_two_identities_and_a_bare_port_gets_none() {
        let s = Store::open(&tmp()).unwrap();
        let a = ch340("/dev/ttyUSB0", "1-2");
        let b = ch340("/dev/ttyUSB1", "1-3");
        let oa = obs(&s, &a, std::slice::from_ref(&b), &[]);
        let ob = obs(&s, &b, std::slice::from_ref(&a), &[oa.id.clone().unwrap()]);
        assert_ne!(oa.id, ob.id);
        assert_eq!(s.hw_devices().len(), 2);
        let bare = Fingerprint {
            port: Some("COM3".into()),
            ..Default::default()
        };
        assert_eq!(obs(&s, &bare, &[], &[]).id, None);
        assert_eq!(
            s.hw_devices().len(),
            2,
            "a port name is not stored as a device"
        );
        assert!(s.set_alias("HW-NOPE", "x").is_err());
        assert!(s
            .set_alias(oa.id.as_deref().unwrap(), "line\nbreak")
            .is_err());
    }

    #[test]
    fn an_alias_is_a_label_and_only_bind_settles_an_ambiguity() {
        let s = Store::open(&tmp()).unwrap();
        let ida = obs(&s, &ch340("/dev/ttyUSB0", "1-2"), &[], &[]).id.unwrap();
        let idb = obs(
            &s,
            &ch340("/dev/ttyUSB1", "1-3"),
            &[],
            std::slice::from_ref(&ida),
        )
        .id
        .unwrap();
        // A moves to a third socket while B is away: not guessed.
        let moved_fp = ch340("/dev/ttyUSB2", "1-4");
        let moved = obs(&s, &moved_fp, &[], &[]);
        let mut named = moved.ambiguous_with.clone();
        named.sort();
        let mut both = vec![ida.clone(), idb.clone()];
        both.sort();
        assert_eq!(named, both);
        let id = moved.id.clone().unwrap();
        assert!(id != ida && id != idb);
        // An alias names it, and settles nothing.
        s.set_alias(&id, "probe C").unwrap();
        assert!(s.hw_device(&id).unwrap().ambiguous_with.is_some());
        // Bind: this attachment is A. The provisional identity is kept,
        // marked, and no longer answers.
        let bound = s.bind(&moved_fp, &[], &[], Some(&id), &ida).unwrap();
        assert_eq!(bound.id.as_deref(), Some(ida.as_str()));
        let p = s.hw_device(&id).unwrap();
        assert_eq!(p.superseded_by.as_deref(), Some(ida.as_str()));
        assert!(s.known().iter().all(|k| k.id != id));
        assert_eq!(s.hw_device(&ida).unwrap().usb_path.as_deref(), Some("1-4"));
        assert_eq!(s.hw_device(&ida).unwrap().ambiguous_with, None);
        // Next time on that socket: A, by the socket.
        let back = obs(&s, &ch340("/dev/ttyUSB7", "1-4"), &[], &[]);
        assert_eq!(back.id.as_deref(), Some(ida.as_str()));
        let kinds: Vec<String> = s.hw_events(0, 10).into_iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&"BOUND".to_string()));
        // A superseded identity is not a bind target.
        assert!(s.bind(&moved_fp, &[], &[], None, &id).is_err());
    }

    #[test]
    fn bind_refuses_what_cannot_be_the_same_device() {
        let s = Store::open(&tmp()).unwrap();
        let board = |chip: &str, path: &str| Fingerprint {
            chip_id: Some(chip.into()),
            ..ch340("/dev/ttyACM0", path)
        };
        let a = obs(&s, &board("7cdfa1000001", "1-2"), &[], &[]).id.unwrap();
        let other = board("7cdfa1000002", "1-3");
        let b = obs(&s, &other, &[], &[]).id.unwrap();
        let e = s.bind(&other, &[], &[], Some(&b), &a).unwrap_err();
        assert!(e.contains("different chip ids"), "{e}");
        // Attached elsewhere right now: cannot be this one.
        let dongle = ch340("/dev/ttyUSB3", "1-5");
        let e = s
            .bind(&dongle, &[], std::slice::from_ref(&a), None, &a)
            .unwrap_err();
        assert!(e.contains("attached on another port"), "{e}");
        assert!(s.bind(&dongle, &[], &[], None, "HW-NOPE").is_err());
    }

    #[test]
    fn a_serial_proven_shared_is_downgraded_for_good() {
        let s = Store::open(&tmp()).unwrap();
        let with_sn = |port: &str, path: &str| Fingerprint {
            serial: Some("A50285BI".into()),
            ..ch340(port, path)
        };
        let a = with_sn("/dev/ttyUSB0", "1-2");
        let first = obs(&s, &a, &[], &[]);
        let ida = first.id.unwrap();
        assert_eq!(first.strength.as_deref(), Some("EXCELLENT"));
        // A twin with the same serial, plugged in at the same time.
        let b = with_sn("/dev/ttyUSB1", "1-3");
        let twin = obs(&s, &b, std::slice::from_ref(&a), std::slice::from_ref(&ida));
        assert_ne!(twin.id.as_deref(), Some(ida.as_str()));
        let d = s.hw_device(&ida).unwrap();
        assert!(!d.serial_trusted);
        assert_eq!(d.serial.as_deref(), Some("a50285bi"), "kept for display");
        assert_eq!(d.strength, "GOOD", "down to its USB path");
        assert!(
            s.hw_events(0, 20)
                .iter()
                .any(|e| e.kind == "SERIAL_DOWNGRADED"
                    && e.device_id.as_deref() == Some(ida.as_str()))
        );
        // Alone later, on another socket: the serial is no longer a key.
        assert_eq!(s.trusted_serial(&with_sn("/dev/ttyUSB0", "2-1"), &[]), None);
        let restart = obs(&s, &with_sn("/dev/ttyUSB0", "1-2"), &[], &[]);
        assert_eq!(
            restart.id.as_deref(),
            Some(ida.as_str()),
            "found by its socket"
        );
        assert_eq!(restart.strength.as_deref(), Some("GOOD"));
    }

    #[test]
    fn the_same_serial_on_two_chip_ids_is_not_trusted() {
        let s = Store::open(&tmp()).unwrap();
        let board = |chip: &str, path: &str| Fingerprint {
            chip_id: Some(chip.into()),
            serial: Some("12345678ABCD".into()),
            ..ch340("/dev/ttyACM0", path)
        };
        let a = obs(&s, &board("7cdfa1000001", "1-2"), &[], &[]).id.unwrap();
        let b = obs(&s, &board("7cdfa1000002", "1-2"), &[], &[]).id.unwrap();
        assert_ne!(a, b);
        assert!(!s.hw_device(&a).unwrap().serial_trusted);
        assert_eq!(
            s.hw_device(&a).unwrap().strength,
            "EXCELLENT",
            "still its chip id"
        );
    }

    #[test]
    fn a_chip_id_joins_only_the_identity_its_own_attachment_created() {
        let s = Store::open(&tmp()).unwrap();
        let usb = Fingerprint {
            vid: Some(0x303a),
            pid: Some(0x1001),
            usb_path: Some("1-2".into()),
            port: Some("/dev/ttyACM0".into()),
            ..Default::default()
        };
        let hello = |chip: &str| Fingerprint {
            chip_id: Some(chip.into()),
            legacy_id: Some(format!("HD-{}", chip[6..].to_ascii_uppercase())),
            ..usb.clone()
        };
        // First attachment: created by the socket, the hello completes it.
        let r = obs(&s, &usb, &[], &[]);
        assert!(r.new);
        let id = r.id.unwrap();
        let o = s
            .observe("IDENTIFIED", &hello("7cdfa1000001"), &[], &[], Some(&id))
            .unwrap();
        assert_eq!(o.id.as_deref(), Some(id.as_str()));
        assert_eq!(
            s.hw_device(&id).unwrap().chip_id.as_deref(),
            Some("7cdfa1000001")
        );
        // Another board in the same socket, later: the socket matches, the
        // chip does not. Never folded in.
        let o = s
            .observe("IDENTIFIED", &hello("7cdfa1000002"), &[], &[], None)
            .unwrap();
        assert_ne!(o.id.as_deref(), Some(id.as_str()));
        // A record known only by its socket, from an earlier attachment:
        // a new identity with a hint, not a merge.
        let s2 = Store::open(&tmp()).unwrap();
        let old = obs(&s2, &usb, &[], &[]).id.unwrap();
        let o = s2
            .observe("IDENTIFIED", &hello("7cdfa1000003"), &[], &[], None)
            .unwrap();
        assert_ne!(o.id.as_deref(), Some(old.as_str()));
        assert_eq!(o.hint.as_deref(), Some(old.as_str()));
        assert_eq!(s2.hw_device(&old).unwrap().chip_id, None);
    }

    #[test]
    fn an_index_error_is_returned_never_claimed_stored() {
        let s = Store::open(&tmp()).unwrap();
        s.db.lock()
            .unwrap()
            .execute_batch("DROP TABLE hw_events")
            .unwrap();
        let e = s
            .observe("ATTACHED", &ch340("/dev/ttyUSB0", "1-2"), &[], &[], None)
            .unwrap_err();
        assert!(e.starts_with("index:"), "{e}");
        assert!(s.detached("/dev/ttyUSB0", None).is_err());
    }
}
