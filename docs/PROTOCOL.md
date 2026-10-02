# HARDWARE DOG / WIRE PROTOCOL

```text
VERSION        1
TRANSPORT      USB CDC serial (115200 8N1), or any byte stream (TCP),
               directly or through dogd (docs/DOGD.md), always unchanged
ENCODING       UTF-8, newline-delimited JSON (one object per line)
MAX LINE       64 KiB, longer lines are dropped and reported
CLOCK          "t" = device uptime in milliseconds
SCHEMA         protocol/hdp_v1.json (JSON Schema, the contract)
REFERENCE      web/src/core/protocol.ts (decoder + tests)
CONTRACT TEST  web/test/protocol-contract.test.ts
```

The firmware and the interface speak one protocol. The simulator in the web
interface speaks it too, as text, through the same decoder.

> **ONE EVENT MODEL.** Every HDP producer, the firmware and the simulator
> alike, must emit frames that validate against `protocol/hdp_v1.json`. The
> contract test checks every simulator frame of every fault scenario on
> each commit. The firmware will run the same check.

## RULES

```text
[ 1 ] Every device frame is a JSON object with "type" and "t".
[ 2 ] "t" is milliseconds since device boot. It never goes backwards.
[ 3 ] Producers emit enums in the canonical case of the schema.
      Decoders accept any case (be strict in what you send, liberal in
      what you accept).
[ 4 ] Optional strings may be null or omitted. Numbers must be finite.
[ 5 ] A frame that does not validate is rejected, counted and logged.
      The interface never guesses what a broken frame meant.
[ 6 ] The device must not claim an identity it has not verified
      (see i2c.scan: "ident" only with a "method").
```

---

## DEVICE -> HOST

### hello

Sent on boot and in reply to a host `hello`. Anchors the device clock to the
host clock.

```json
{"type":"hello","t":0,"proto":1,"device":"HD-3A1F2C","rev":"DEVKIT-S3","fw":"0.1.0","caps":["power","uart","i2c","net"]}
```

`caps` (optional) is what the device can observe: `power`, `usb`, `uart`,
`i2c`, `net`, `probe`. A hello without `caps` (devices made before it)
means every capability. **Silence about a capability the device does not
have is never an observation**: without `usb`, no USB frame is not "no USB
device", and the engine makes no USB diagnosis from it. Decoders ignore
capability names they do not know.

### power

One sample of the target supply rail. Volts and amps.

```json
{"type":"power","t":1200,"v":5.041,"i":0.312}
```

### power.meter

What the power numbers are worth (LVL 65). Sent once the sensor identity
is verified, in reply to `hello`, and after every calibration change.

```json
{"type":"power.meter","t":12,"sensor":"INA226","shunt_ohm":0.1,"v_max":36,"i_max":0.8,"v_res":0.00125,"i_res":0.0000244,"rate_hz":50,"v_err":{"pct":0.1,"abs":0.00875},"i_err":{"pct":1.1,"abs":0.0001244},"basis":"DATASHEET","cal":null}
```

```text
sensor          identity as verified by the device (rule 6), never assumed
v_max / i_max   measured within specification up to these values
v_res / i_res   one LSB: resolution, not accuracy
rate_hz         power frames per second: shorter events can be missed
v_err / i_err   expected maximum error: |error| <= pct % of reading + abs
basis           DATASHEET    worst case from the datasheets (INA226: gain
                             0.1 %, bus offset 7.5 mV, shunt offset 10 uV,
                             one LSB, plus the shunt resistor tolerance)
                CALIBRATION  largest residual measured against the named
                             reference, plus one LSB. The reference's own
                             accuracy adds to it: a calibration is worth
                             the instrument it was made with.
cal             null, or the stored calibration: date, reference, gains,
                current offset
```

Every number on screen and in reports is a **diagnostic measurement, not
certified metrology**. A device that sends no `power.meter` (made before
LVL 65) has an unknown accuracy, and the interface says so. Interfaces
made before LVL 65 reject this frame type as unknown: one counted frame
error, nothing else changes.

### usb.attach / usb.detach

```json
{"type":"usb.attach","t":1214,"speed":"FULL","vid":12346,"pid":4097,"cls":"CDC","power":"BUS","manufacturer":"Espressif","product":"USB JTAG/Serial","serial":"48:27:E2:5C:1A:90"}
{"type":"usb.detach","t":2088}
```

```text
speed     LOW | FULL | HIGH | SUPER
          the speed at which the device enumerated ON HARDWARE DOG, not its
          maximum capability. The ESP32-S3 host port is full-speed: a
          high-speed device enumerates there at FULL (USB 2.0 fallback).
power     BUS | SELF
```

### uart.config / uart.rx / uart.error

```json
{"type":"uart.config","t":0,"port":"UART0","baud":115200,"bits":8,"parity":"NONE","stop":1}
{"type":"uart.rx","t":1320,"data":"bootloader 0.9"}
{"type":"uart.error","t":1330,"kind":"framing"}
```

One `uart.rx` per received line, without the line terminator.

### i2c.scan

```json
{"type":"i2c.scan","t":5000,"speed":400000,"devices":[
  {"addr":60,"ident":null,"method":null},
  {"addr":64,"ident":"INA226","method":"manufacturer ID register 0xFE = 0x5449"}
]}
```

`addr` is the 7-bit address (0x00 to 0x7F). `ident` is set only when the
firmware confirmed it, and `method` says how.

`every_ms` (optional) says the scan belongs to a periodic watch (`i2c.watch`,
or a watch configured at boot). Absent: a one-off scan.

### i2c.error

The target bus failed (LVL 80). The scan that hit the fault is **not** sent:
an empty list would read as every device gone.

```json
{"type":"i2c.error","t":6000,"kind":"SDA_LOW","detail":"SDA low while the bus is idle","every_ms":3000}
```

```text
kind   SDA_LOW / SCL_LOW   the line sits low while idle: missing pull-up,
                           a device holding it, a short
       TIMEOUT             a transfer did not complete
       ARB_LOST            the master lost arbitration
```

### net.status

```json
{"type":"net.status","t":2000,
 "link":{"up":true,"mbps":1000,"duplex":"FULL"},
 "address":"192.168.1.84","dhcp":"PASS",
 "gateway":{"address":"192.168.1.1","status":"PASS"},
 "dns":{"address":"1.1.1.1","status":"PASS"},
 "internet":"PASS","latency":12,"loss":0}
```

Check status: `PASS | WARN | FAIL | PENDING | UNKNOWN`. UNKNOWN means not
measured, never "probably fine".

### probe.result / probe.done

```json
{"type":"probe.result","t":9000,"id":"p1","test":"PING","status":"PASS","detail":"4/4 replies, avg 4 ms"}
{"type":"probe.done","t":9400,"id":"p1"}
```

### log

```json
{"type":"log","t":3000,"level":"warn","message":"INA226 calibration missing, using defaults"}
```

`level`: `info | warn | error`.

---

## HOST -> DEVICE

```json
{"cmd":"hello","proto":1}
{"cmd":"usb.enumerate"}
{"cmd":"uart.config","baud":115200}
{"cmd":"uart.tx","data":"AT+RST"}
{"cmd":"i2c.scan"}
{"cmd":"net.refresh"}
{"cmd":"i2c.watch","every_ms":5000}
{"cmd":"net.watch","every_ms":10000,"dns":"example.com","upstream":"example.org"}
{"cmd":"probe","id":"p1","target":"192.168.1.1","tests":["PING","DNS","TCP"]}
{"cmd":"meter.cal","date":"2026-10-02","ref":"Fluke 87V","v_gain":1.0012,"i_gain":0.991,"i_offset":0.0003,"v_err":0.002,"i_err":0.0004}
{"cmd":"meter.clear"}
```

`meter.cal` stores a calibration on the device (NVS on the ESP32-S3):
`v = raw x v_gain`, `i = raw x i_gain + i_offset`. Out of range (gains
0.9-1.1, offset 50 mA, date YYYY-MM-DD) it is rejected and nothing changes.
The device answers with `power.meter`. `meter.clear` returns to datasheet
accuracy.

`i2c.watch` scans the target bus every `every_ms` (0 stops; devices refuse
less than 1000). `net.watch` (0 stops; at least 2000) pings the gateway,
resolves `dns` and opens TCP 443 to `upstream`, and reports the results in
`net.status` (gateway, dns, internet, latency, loss). Without `dns` or
`upstream`, those stay UNKNOWN: nothing is checked that was not asked.

`i2c.scan`, `i2c.watch`, `net.watch`, `usb.enumerate`, `uart.tx`, `probe`,
`meter.cal` and `meter.clear` are ACTIVE operations:
the interface always states what they will do before sending them.

---

## SESSION FILES (.hdlog)

```text
VERSION        2 (v1 files are still read, marked UNVERIFIED)
FORMAT         newline-delimited JSON, UTF-8, LF line endings
LINE 1         header: provenance, never rewritten
THEN           entries in arrival order, sealed in blocks by seal lines
LAST           footer: counts + SHA-256 of everything before it
CLOCK          "at" = host wall-clock time in ms, never goes backwards
REFERENCE      web/src/core/session.ts (writer, reader, verifier, replay)
CASES          cases/*.hdlog + cases/*.case.json
```

A session file is what Hardware Dog received, kept as received. Frames are
stored as decoded HDP objects; a replay re-serializes them and feeds them
through the **same line decoder** as a live device. A recording is reality,
played again: the trace engine cannot tell the difference.

> **DON'T SEND A SCREENSHOT. SEND THE .HDLOG.**
> Same frames, same rejects, same thresholds, same trace, same facts, same
> diagnosis, on any machine, without the device.

### header

```json
{"hdlog":2,"proto":1,"recording":"f5db768b4dfb92c6a433abbdb061a370",
 "id":"HD-20260930-1421","startedAt":1790778060000,"origin":"SIMULATED",
 "source":"SIMULATOR","endpoint":"SIMULATED DEVICE / HD-T001 USB UNDERVOLTAGE",
 "scenario":"HD-T001","app":"0.1.0","ruleset":1,
 "thresholds":{"undervoltageThreshold":4.75,"overcurrentThreshold":0.9,"correlationWindowMs":100}}
```

(one line in the file)

```text
hdlog        file format version (2)
proto        HDP version of the frames
recording    unique id of this recording, 128 random bits, hex
id           human session id, HD-YYYYMMDD-HHMM
origin       PHYSICAL | SIMULATED          where the evidence comes from
source       WEB SERIAL | SIMULATOR | DOGD the transport it came through
scenario     simulator fault scenario, or null
app          interface build that recorded it
ruleset      diagnostic ruleset version in force while recording
thresholds   diagnostic thresholds in force when recording started
```

`origin` must agree with `source` (a reader refuses a file where it does
not) and is never rewritten: SIMULATOR is SIMULATED, WEB SERIAL is
PHYSICAL, and through DOGD it is what dogd reports for its link (a serial
port is PHYSICAL; a TCP source is what the operator declared). **A replay is not an origin**: it is what the
operator is looking at. Exporting a replay gives back the same file, byte
for byte, so a file never becomes "a replay of a replay"; the interface
and the report say `REPLAY OF PHYSICAL` or `REPLAY OF SIMULATED`.

The device identity (id, hardware revision, firmware) is known only when
the device says hello: it is in the `hello` frame and repeated in the
footer.

### entries

```json
{"at":1790778061002,"frame":{"type":"power","t":1002,"v":4.62,"i":0.704}}
{"at":1790778061010,"reject":"frame rejected: not valid JSON","raw":"{\"type\":\"power\","}
{"at":1790778061100,"cmd":{"cmd":"i2c.scan"}}
{"at":1790778061200,"mark":"device reboot"}
{"at":1790778061250,"thresholds":{"undervoltageThreshold":4.6,"overcurrentThreshold":0.9,"correlationWindowMs":100}}
{"at":1790778061300,"lost":"serial stream ended"}
```

```text
frame        an HDP device frame, as received
reject       a line the decoder refused, with its raw bytes when known;
             a replay gives the decoder the same bytes, and it must
             refuse them again
cmd          a command the interface sent. Documentation only: a replay
             never executes or answers a command
mark         an operator note on the timeline
thresholds   the operator changed a threshold at this moment
lost         the link went away
```

Each entry has `at` and exactly one of these keys.

### seals

```json
{"seal":{"n":1,"lines":98,"sha256":"ec0e57ea..."}}
```

The recorder writes a seal every time it stores a block (every 2 s while
recording). Seals form a hash chain:

```text
chain(0)  = sha256(header line + LF)
chain(n)  = sha256(hex(chain(n-1)) + the block's lines, each + LF)
```

A seal covers every byte since the previous seal (or the header) and,
through the chain, everything before. A file whose recording never
finished still proves that every sealed line is intact.

### footer

```json
{"end":{"closed":"NORMAL","startedAt":1790778060000,"endedAt":1790778089900,
 "entries":1557,"frames":1557,"rejects":0,"commands":0,"marks":0,
 "thresholds":0,"lost":0,"seals":1,
 "device":{"id":"HD-001","rev":"A","fw":"0.1.0"},"sha256":"0d2e8483..."}}
```

```text
closed       NORMAL     closed by the recorder at the end of the session
             RECOVERED  closed later, after an unclean stop (tab closed,
                        crash): only sealed lines are kept
             SNAPSHOT   exported while the session was still recording
sha256       sha256 of every byte of the file before the footer line
```

### integrity

A reader checks every seal, the footer hash and every count, and gives the
file one status. Problems do not hide the data: a modified file is still
shown, with the warning and the line numbers.

```text
VERIFIED     finalized, every hash and count matches
RECOVERED    finalized after an unclean stop, every hash matches
INCOMPLETE   never finalized; every sealed line is intact
MODIFIED     bytes changed after they were sealed: NOT EVIDENCE
UNVERIFIED   hdlog v1, no integrity data
```

The report names the recording, its origin, its integrity, the ruleset and
the SHA-256 of the whole file (what `sha256sum` prints).

**Integrity, not DRM, not a signature.** A hash proves that the bytes did
not change since they were sealed. It does not prove who wrote them: anyone
can write a new file and hash it. Signing recordings with a key held by the
device is planned with the firmware.

### compatibility

```text
[ 1 ] Every hdlog version is read forever. v1 files open as UNVERIFIED.
[ 2 ] Files are never migrated or rewritten: the bytes that were sealed
      are the evidence. A newer reader understands an older file as is.
[ 3 ] A file from a newer Hardware Dog is refused with a plain message:
      "hdlog v3 was written by a newer Hardware Dog".
[ 4 ] Readers ignore keys they do not know: a newer writer may add
      fields without breaking older readers.
[ 5 ] Proof: web/test/fixtures/hdlog-v1.hdlog (written by an earlier
      build) and cases/*.hdlog must open and replay on every commit.
```

### limits

Files come from anyone. A reader refuses, with a reason and a line number,
anything that could exhaust the browser or reach the engine malformed:

```text
FILE         256 MiB at most (about 15 h of a live session)
LINE         128 KiB at most (an HDP frame is at most 64 KiB)
TEXT         header fields 256 characters, marks 1000 characters
THRESHOLDS   the ranges SETUP accepts (UV 3-5.5 V, OC 0.05-5 A,
             window 10-2000 ms)
ENTRIES      frame / cmd are objects, reject / mark / lost are text;
             frame content is validated by the HDP decoder at replay
```

### replay rules

```text
[ 1 ] A replay is read-only. Recorded commands are never executed;
      active commands answer "recorded session, read-only".
[ 2 ] A replay runs on the thresholds it was recorded with, including
      changes made during the session. The operator's own settings are
      not overwritten.
[ 3 ] A replayed SIMULATED recording stays labeled SIMULATED, in the
      interface and in every exported report.
[ 4 ] Replaying a recording must reproduce the same timeline, the same
      measurements, the same facts and the same diagnoses
      (web/test/session.test.ts).
[ 5 ] A replay on a different ruleset says so: "recorded v1, diagnosed v2".
```

---

## CASES

A case is a recorded incident turned into a regression test:

```text
cases/HD-C002.hdlog        the recording, untouched
cases/HD-C002.case.json    what replaying it must produce
```

```json
{
  "case": 1,
  "id": "HD-C002",
  "title": "USB UNDERVOLTAGE (simulator HD-T001)",
  "recording": {"file": "HD-C002.hdlog", "sha256": "0925e861...",
                "recording": "f5db768b...", "origin": "SIMULATED"},
  "ruleset": 1,
  "expect": {
    "facts": {"undervoltage": 3, "overcurrent": 0, "usbAttaches": 4,
              "usbDisconnects": 3, "disconnectsAfterDrop": 3,
              "targetResets": 4, "framingErrors": 0, "rejectedLines": 0},
    "diagnoses": [{"id": "POWER_INSTABILITY", "confidence": "HIGH"}]
  }
}
```

The case names its recording by SHA-256. A case passes when the file is that
exact file, intact (VERIFIED or RECOVERED), and replays to the stated facts
and diagnosis (`web/test/cases.test.ts`).

In the interface: replay a recording, then **REPORT → SAVE AS CASE**. It
saves `HD-C-xxxxxxxx.case.json` and the untouched `.hdlog`. Rename both to
the next `HD-C` number when adding them to `cases/`.

Every interesting real fault can become a case without one line of special
code: the engine either still explains it the same way, or the test says
exactly what changed.
