# HARDWARE DOG / ENGINEERING PLAN

```text
DOCUMENT      ENGINEERING PLAN
VERSION       0.7 / IMPLEMENTATION-ALIGNED
STATUS        ACTIVE IMPLEMENTATION
COMPANION TO  LAWS.md              the laws of the project
              DESIGN_SPEC.md       interface and industrial design (locked)
              BRAND.md             official mascot and assets (locked)
              VISION.md            product vision
              PROTOCOL.md          HDP v1, human-readable
              DIAGNOSTICS.md       rules, confidence, fault scenarios
              protocol/hdp_v1.json HDP v1, machine-readable contract
```

Hardware Dog is a **source-available** hardware diagnostic platform.

The repository is public so that individuals can study it, modify it, build
their own unit and use it for permitted non-commercial purposes. Commercial
manufacturing, distribution, integration and commercial service use require
a separate Hardware Dog commercial license (see [LICENSING](#licensing)).

The laws of the project ([`LAWS.md`](LAWS.md)) are architecture
boundaries, not preferences:

```text
ONE EVENT MODEL.
ONE CLOCK.
ONE TIMELINE.

EVERY REAL FAILURE SHOULD BE ABLE
TO BECOME A REPRODUCIBLE TEST.

LOCAL IS THE SOURCE OF TRUTH.
THE CLOUD IS NEVER REQUIRED.
```

A real Hardware Dog device and the simulator must produce the same HDP
event stream. The trace engine and the UI must not need to know which one
produced it.

```text
LAW OF THE PROJECT

The trace engine must not care whether reality or simulation
produced the event.
```

This law is enforced, not just stated: `web/test/protocol-contract.test.ts`
validates every simulator frame against `protocol/hdp_v1.json`, and the
firmware will pass the same contract before it ships.

---

## 1 — WHERE THE PROJECT IS

The first version of this plan (0.1, in git history) described a first work
session: create a skeleton and make a dashboard appear. That is done.

```text
[ OK ] repository skeleton
[ OK ] HDP v1 wire protocol + JSON Schema contract
[ OK ] transport abstraction
[ OK ] Web Serial link (real device side, awaiting firmware)
[ OK ] deterministic simulator
[ OK ] trace engine, one timeline
[ OK ] responsive diagnostic UI, desktop + mobile
[ OK ] power telemetry simulation
[ OK ] brand asset pipeline
[ OK ] design system (tokens, instrument panels)
[ OK ] automated tests + CI
```

### MILESTONE — SOFTWARE REFERENCE IMPLEMENTATION

```text
[ OK ]   HDP v1                             docs/PROTOCOL.md, protocol/hdp_v1.json
[ OK ]   simulator transport                web/src/core/simulator.ts
[ OK ]   Web Serial transport               web/src/core/webserial.ts
[ OK ]   trace engine                       web/src/core/trace.ts
[ OK ]   responsive UI                      web/src/ui
[ OK ]   fault scenarios                    11 scenarios, HD-T000 to HD-T010
[ OK ]   deterministic diagnostic rules     13 rules, reliability matrix
[ OK ]   report generation                  TXT + JSON, diagnosis-driven
[ OK ]   session recording                  .hdlog, browser archive, exact replay
[ OK ]   dogd integration                   Rust daemon, fourth transport
[ NEXT ] physical ESP32-S3 reference device firmware on a dev board
```

### MILESTONE — EVIDENCE INTEGRITY + CASES

A recorded fault must travel from one workshop to another and stay what
it was. Hardware Dog no longer only captures and diagnoses:

```text
CAPTURE -> PRESERVE -> SHARE -> REPLAY -> VERIFY -> LEARN
```

```text
[ OK ]   stable .hdlog header (v2)          recording id, origin, ruleset, app
[ OK ]   format / protocol / ruleset versions in every file
[ OK ]   sealed blocks + finalized hash     SHA-256 chain, footer with counts
[ OK ]   provenance preserved forever       PHYSICAL | SIMULATED, never rewritten
[ OK ]   replay cannot execute commands     recorded commands are documentation
[ OK ]   unclean stops recovered            closed: RECOVERED, sealed lines only
[ OK ]   live export is verifiable          closed: SNAPSHOT
[ OK ]   recording -> regression case       REPORT -> SAVE AS CASE, cases/
[ OK ]   cases run in the test suite        web/test/cases.test.ts
[ OK ]   report references the recording    id, origin, integrity, file SHA-256
[ LATER ] recordings signed by the device   key in the firmware
```

> **DON'T SEND A SCREENSHOT. SEND THE .HDLOG.**

**Not the PCB yet.** The order is deliberate: first a system that can
receive, record, correlate and explain the data perfectly; then the box
that produces it. Hardware built before the contract is stable has nothing
to be tested against.

---

## 2 — PRODUCT

> **Hardware Dog — a pocket diagnostic companion for hardware, USB, serial
> and network troubleshooting.**
> You plug it in. It sniffs. It tells you what is really going on.

Local-first. No account, no SaaS, no mandatory cloud. Useful without
Internet.

It observes several layers of a system:

```text
PHYSICAL -> ELECTRICAL -> PROTOCOL -> NETWORK -> SOFTWARE
```

It does not replace an oscilloscope or a Fluke multimeter. It answers:

> **"Why doesn't this thing work?"**

Diagnostics of hardware you control. No security exploitation, no bypass.

### The four modes

```text
SNIFF    passive observation: power, USB presence, UART, I2C, network, device state
PROBE    simple, safe active tests, always announced before running
TRACE    every event from every source on one clock
REPORT   exportable diagnosis: TXT + JSON (HTML / PDF later)
```

---

## 3 — ARCHITECTURE

```text
                     ┌──────────────────┐
                     │   REAL DEVICE    │
                     │ ESP32-S3 / HDP   │
                     └────────┬─────────┘
                              │
                              │ HDP EVENTS
                              │
                     ┌────────▼─────────┐
                     │ TRANSPORT LAYER  │
                     └────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
     ┌────────▼────────┐             ┌────────▼────────┐
     │ REAL TRANSPORT  │             │   SIMULATOR     │
     │ Web Serial      │             │ deterministic   │
     │ (dogd: planned) │             │ scenarios       │
     └────────┬────────┘             └────────┬────────┘
              └───────────────┬───────────────┘
                              │
                     ┌────────▼─────────┐
                     │   TRACE ENGINE   │
                     │ ONE TIMELINE     │
                     └────────┬─────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
       ┌────────▼────────┐         ┌────────▼────────┐
       │ DIAGNOSTIC RULES│         │ SESSION STORE   │
       └────────┬────────┘         └────────┬────────┘
                │                           │
                └─────────────┬─────────────┘
                              │
                       ┌──────▼───────┐
                       │ UI / REPORTS │
                       └──────────────┘
```

```text
LAYER              STATUS    WHERE
transport          OK        web/src/core/transport.ts (Web Serial, simulator, replay, dogd)
HDP decoder        OK        web/src/core/protocol.ts
trace engine       OK        web/src/core/trace.ts
system state       OK        web/src/core/system.ts (single source of truth)
diagnostic rules   OK        web/src/core/diagnostics.ts
session store      OK        web/src/core/session.ts, archive.ts (.hdlog, IndexedDB)
UI / reports       OK        web/src/ui, web/src/core/report.ts
dogd               OK        dogd/, section 10, DOGD.md
firmware           PARTIAL   firmware/, section 11, FIRMWARE.md (board bring-up pending)
```

Invariants of the codebase (details in `ARCHITECTURE.md`):

```text
ONE SOURCE OF TRUTH   GUI and command layer both call System; no copies of state
FRAMES ONLY           device state changes only when a validated HDP frame arrives
SAME PATH             simulator frames are serialized and go through the real decoder
NO FAKE CERTAINTY     OBSERVED / CORRELATION / POSSIBLE CAUSE / NEXT CHECK kept apart
LOCAL FIRST           no network requests, no CDN, no account
```

---

## 4 — HDP, HARDWARE DOG PROTOCOL

```text
VERSION     1
FORMAT      NDJSON, UTF-8, one object per line
CLOCK       "t" = device uptime in ms, anchored to host time by "hello"
TRANSPORTS  USB CDC serial (now), WebSocket via dogd (planned), local TCP (planned)
CONTRACT    protocol/hdp_v1.json, enforced by tests
LATER       CBOR / protobuf only if bandwidth requires it; same event model
```

Device frames: `hello`, `power`, `usb.attach`, `usb.detach`,
`uart.config`, `uart.rx`, `uart.error`, `i2c.scan`, `net.status`,
`probe.result`, `probe.done`, `log`. Host commands: `hello`,
`usb.enumerate`, `uart.config`, `uart.tx`, `i2c.scan`, `net.refresh`,
`probe`. Full reference: `PROTOCOL.md`.

A breaking change means HDP v2, a new schema file, and a `proto` bump in
`hello`. Decoders reject what they do not understand; they never guess.

---

## 5 — SIMULATOR

The simulator is a fundamental component, not a demo feature. It is:

```text
THE DEMO          anyone can run Hardware Dog without owning one (npm run demo)
THE TEST RIG      every diagnostic rule is proven against it on each commit
THE SPEC PARTNER  it defines, in code, what the firmware must emit
```

Design:

```text
DETERMINISTIC     seeded PRNG: same seed, same session, bit for bit
MANUAL TIME       tests drive time with advance(ms); no timers, no flakiness
PHYSICAL MODEL    supply voltage, cable resistance, load bursts, brownout,
                  target boot log, UART baud, USB data link, network layers
HDP ONLY          it serializes frames to text and feeds the real decoder;
                  it never touches System state directly
BLIND ENGINE      the diagnostic engine never sees the scenario
```

Fault scenarios (`web/src/core/scenarios.ts`, details in `DIAGNOSTICS.md`):

```text
HD-T000 HEALTHY BASELINE           HD-T006 TARGET RESET LOOP
HD-T001 USB UNDERVOLTAGE           HD-T007 UNSTABLE NETWORK
HD-T002 DHCP FAILURE               HD-T008 UPSTREAM DOWN
HD-T003 DNS FAILURE                HD-T009 OVERCURRENT
HD-T004 SERIAL FRAMING MISMATCH    HD-T010 USB NOT ENUMERATED
HD-T005 INTERMITTENT USB DISCONNECT
```

Each scenario has an answer key. The reliability matrix requires the
engine to produce exactly that key, with no false positive on HD-T000.

Every new fault class starts here: scenario first, rule second, hardware
last.

---

## 6 — TRACE ENGINE

Probably the killer feature: **ONE TIMELINE.**

Diagnosing today means juggling a multimeter, a serial terminal,
Wireshark, system logs, ping, Device Manager and a browser console. Hardware
Dog puts all of it on one clock:

```text
12:02:01.011  POWER  WARN  voltage drop           4.61 V < 4.75 V
12:02:01.079  USB    WARN  device disconnected
12:02:01.079  RULE   WARN  disconnect 68 ms after voltage drop
12:02:02.310  UART   INFO  rst:0x1 (POWERON),boot:0x8
```

And suddenly: **cause -> consequence.**

Recording never stops; pausing freezes the view only. Events stay sorted by
device time even when frames arrive out of order. Capacity: 10 000 events
in memory, full timeline in the JSON export.

---

## 7 — DIAGNOSTIC ENGINE

Deterministic. **No mandatory AI.** 13 written rules, each with a
confidence level that has a written definition, all documented in
`DIAGNOSTICS.md` and proven by `web/test/scenarios.test.ts`:

```text
11 scenarios x 5 seeds      exact expected diagnoses, 0 false positive
HD-T000                     silent for 10 minutes
every fault                 HIGH confidence within 90 s, detected within 30 s
```

### Optional AI, later

AI may only **explain** diagnoses already produced by the rules, in plain
language. Detection never depends on it. This is essential for the product's
credibility.

---

## 8 — SESSION STORE

```text
DONE   every live session recorded as it happens (.hdlog, PROTOCOL.md):
       frames, rejected lines, commands, marks, threshold changes
DONE   browser archive (IndexedDB, memory fallback): sessions streamed in
       ordered chunks; the first failed write stops recording, no silent
       gap; simulator sessions pruned (latest 5), hardware sessions with
       data never deleted automatically
DONE   replay through the same decoder: same timeline, same facts, same
       diagnoses, on the recorded thresholds; read-only; a replayed
       simulator session stays labeled SIMULATED
DONE   save / open .hdlog files: a fault recorded by one person can be
       replayed by anyone, without the device
DONE   evidence integrity (.hdlog v2): sealed SHA-256 chain, footer,
       provenance, VERIFIED / RECOVERED / INCOMPLETE / MODIFIED
DONE   cases: a recording + the facts and diagnosis it must replay to
LATER  SQLite in dogd, same data model
LATER  recordings signed with a key held by the device
```

Everything is local. A session file leaves the machine only when the
operator saves it and gives it to someone.

Data model (dogd / SQLite, mirrored in IndexedDB):

```text
devices    id, serial_number, hardware_revision, firmware_version, first_seen, last_seen
sessions   id, device_id, source (DEVICE | SIMULATOR + scenario), started_at, ended_at, name, notes
events     id, session_id, timestamp, category, type, severity, payload_json
metrics    id, session_id, timestamp, metric, value, unit
reports    id, session_id, created_at, summary, diagnosis_json
```

A recorded session stores raw HDP frames. Replaying it through the decoder
must reproduce the same timeline and the same diagnoses: the recording
becomes a regression test. `cases/` holds such tests: each recording is
named by its SHA-256 and must replay to the facts and diagnosis its case
states (`web/test/cases.test.ts`, format in PROTOCOL.md).

---

## 9 — REPORTS

```text
FORMAT     TXT (readable with no software) + JSON (report + full timeline)
CONTENT    measurements per section, then one DIAGNOSIS block per finding:
           CONFIDENCE + basis, OBSERVED, CORRELATION, POSSIBLE CAUSE, NEXT CHECK
LABELING   simulated sessions say so in every export
LATER      HTML / PDF
```

---

## 10 — DOGD, LOCAL DAEMON

Rust, local only: `dogd/`, documented in [`DOGD.md`](DOGD.md).

```text
Rust, Tokio, Axum, Serde, SQLite

dogd/src/
├── main.rs        serve, status, devices, sessions
├── config.rs      local by default, --listen-lan explicit
├── api/           the local API, host + origin guard, HDP socket
├── transport/     the device link: bridge, reconnect
├── device/        port listing, HDP hello identification
├── sessions/      .hdlog integrity check (same algorithm as the reader)
├── storage/       SQLite index + files
└── protocol/      HDP constants, hello watcher
```

```text
DISCOVER  CONNECT  BRIDGE  STORE  SERVE
never: interpret differently, invent events, rewrite HDP, become SaaS
```

dogd is **the fourth transport**. `WS /v1/hdp` carries the device bytes
exactly as they arrive; the interface decodes them with the same decoder as
Web Serial. dogd owns no diagnostic rule: `dogd = transport + storage`,
`web = trace + diagnosis`. Headless diagnosis, if ever, will come from one
shared rule representation, not from a manual port to Rust.

---

## 11 — FIRMWARE

ESP32-S3, ESP-IDF, C11: `firmware/`, documented in [`FIRMWARE.md`](FIRMWARE.md).

```text
firmware/components/hdp   THE CORE: portable C, no ESP-IDF. HDP writer,
                          command parser, INA226 driver. Built and tested
                          on a PC too (firmware/host).
firmware/main             ESP-IDF glue: I2C, UART, native USB, Wi-Fi
```

Each subsystem emits HDP v1 frames; nothing else leaves the device (logs
go to UART0). The device declares what it observes in `hello.caps`.

Acceptance: the firmware's output validates against `protocol/hdp_v1.json`
and runs through the same engine as the simulator: on a PC and in CI today
(`web/test/firmware.test.ts`), captured on the board at bring-up
(FIRMWARE.md), then through the physical scenarios HD-P0xx (section 14).

---

## 12 — HARDWARE, REV A

### MCU

**ESP32-S3**: Wi-Fi, Bluetooth, USB OTG, plenty of GPIO, ADC, I2C, SPI,
UART, huge ecosystem, cheap, easy to prototype. An STM32 / RP2040 variant can
come later.

### USB: what Rev A does, precisely

```text
[X] measures VBUS voltage and current on the passthrough (INA226)
[X] detects attach / detach and correlates it with power on one clock
[X] enumerates a device plugged into its own HOST port and reads
    descriptors (VID, PID, class, strings)
[X] reports the speed the device enumerated at on that port
[ ] NOT a USB protocol analyzer: no packet capture, no traffic decoding
[ ] NOT 480 Mbps: the ESP32-S3 USB OTG controller is full-speed (12 Mbps);
    a high-speed device enumerates on the host port at full speed
[ ] the passthrough does not touch D+ / D-; it observes power only
```

```text
USB IN ──── INA226 current sense on VBUS ──── USB OUT     (data lines pass through)

USB HOST port (ESP32-S3 OTG, full speed): enumeration + descriptors
```

### Display

Small IPS display, 2.4–2.8". Field information only; the full interface
stays on the phone / laptop. Layout rules: `DESIGN_SPEC.md` sections 26–27.

### Connectors

```text
USB-C HOST      enumeration port
USB-C / USB-A   power passthrough (measured)
USB-C           Hardware Dog power + link to the host computer
RJ45            Ethernet (0.2)
UART header     GND TX RX 3V3
I2C header
GPIO
```

Rev A does not need everything to be bidirectional.

### Ethernet

**W5500 over SPI.** Not sexy, extremely well documented and stable. An
integrated PHY can come with Rev B.

### UART

3.3 V TTL only, with proper protection (series resistors, clamping). No
RS-232 on the MCU pins.

---

## 13 — PCB (AFTER THE REFERENCE DEVICE)

KiCad, public:

```text
hardware/
  rev-a/
    schematic/
    pcb/
    gerbers/
    bom/
    assembly/
```

Silkscreen and color rules: `DESIGN_SPEC.md` sections 28–29.

---

## 14 — TESTS

```text
UNIT         protocol decoder, trace, rules, commands, report, chart layout
CONTRACT     every simulator frame validates against protocol/hdp_v1.json
REPLAY       recording then replaying any scenario gives the same timeline,
             facts and diagnoses; tampered files are reported MODIFIED
CASES        every cases/*.hdlog is the file its case names and replays to
             the facts and diagnosis the case states
SIMULATION   reliability matrix: HD-T000 .. HD-T010 (DIAGNOSTICS.md)
PHYSICAL     HD-P001 real undervoltage (resistive cable, loaded target)
  (planned)  HD-P002 real DHCP failure (isolated switch, no server)
             HD-P003 real DNS failure (blackholed resolver)
             HD-P004 real framing mismatch (target at 9600)
             HD-P005 real intermittent USB (worn connector jig)
```

A physical scenario passes when the same engine produces the same
diagnosis as its simulated twin.

---

## 15 — REPOSITORY

```text
NOW                                   PLANNED
README.md                             CONTRIBUTING.md
LICENSE, COMMERCIAL.md                SECURITY.md
assets/brand/    brand pipeline       dogd/        Rust daemon
docs/            specs and plans      firmware/    ESP32-S3
protocol/        HDP v1 schema        hardware/    KiCad Rev A
web/             UI, core, simulator  enclosure/   3D printable case
cases/           recorded incidents
.github/         CI
```

The simulator lives in `web/src/core` today because the UI and the tests
use it directly. It moves to a shared package only when dogd needs it.

---

## 16 — CI

```text
NOW       typecheck, unit + contract + simulation tests, production build
NEXT      lint + format check, Rust build + tests (dogd), firmware build,
          contract test on captured firmware output, release artifacts
```

Badges appear in the README only when the job exists and passes.

---

## 17 — ROADMAP, BY LEVEL

```text
DESTINATION   Hardware Dog = the local-first incident recorder and
              diagnostic layer for physical hardware.

              Specialized tools measure one layer deeply.
              Hardware Dog preserves what happened across the system.
```

The project climbs one level at a time. A level is done when its **gate**
passes, not when its code exists. MAX LVL does not mean forty protocols: it
means a technician can trust Hardware Dog with a fault, share the proof,
reproduce it, and make a decision on it.

```text
LVL   NAME                                  STATUS
40    .hdlog becomes technical evidence      DONE
45    diagnostic engine v1                   PARTIAL   13 rules, each with a scenario and a case; I2C rules at 80
50    .hdlog becomes a CASE                  DONE      context in cases, hwdog test cases/ in CI
55    dogd, the local backbone               DONE      gate passed, real ESP32 at 60
60    first physical Hardware Dog            PARTIAL   core PASS on PC + CI, board bring-up pending
65    calibration + truthfulness             PARTIAL   software PASS, reference comparison on boards pending
70    real fault lab                         PARTIAL   procedures + pipeline PASS, bench recordings pending
75    professional reports                   DONE      TXT, JSON, HTML, PDF from the same lines
80    network + I2C on hardware              PLANNED
85    PCB Rev A                              PLANNED
90    probe architecture                     PLANNED
95    community incident library             PLANNED
100   Hardware Dog 1.0                       PLANNED
MAX   incidents make Hardware Dog better     PLANNED
```

### LVL 40 — .hdlog BECOMES TECHNICAL EVIDENCE        DONE

```text
[ OK ] versions in every file: hdlog, HDP, ruleset, app (firmware from the
       hello frame, in the footer)
[ OK ] immutable provenance: origin PHYSICAL | SIMULATED, never rewritten;
       a replay is shown as REPLAY OF PHYSICAL | REPLAY OF SIMULATED
[ OK ] SHA-256 seal chain + footer hash of the final content
[ OK ] final counts: frames, rejects, commands, marks, thresholds, lost
[ OK ] unfinished files explicitly INCOMPLETE; RECOVERED after a crash
[ OK ] size and line limits, field validation, hostile-file tests
[ OK ] compatibility: every version is read forever, files are never
       rewritten; a newer file says it needs a newer Hardware Dog
[ OK ] report.json references the recording id, origin, integrity, hash
```

GATE: a file recorded today opens in two years without ambiguity.
`web/test/fixtures/hdlog-v1.hdlog` (written by an earlier build) and
`cases/*.hdlog` (v2) must parse and replay to the same diagnosis on every
commit.

Why there is no REPLAYED_* origin in the file: replaying does not change
where the evidence came from. Exporting a replay gives back the same bytes,
so a file can never become "a replay of a replay". The replay state is
shown by the interface and the report, never written into the evidence.

### LVL 45 — DIAGNOSTIC ENGINE V1

Not 150 rules. Ten diagnostics that are extremely solid.

```text
WANTED                       TODAY (id kept: ids live in case files)
POWER_INSTABILITY            [ OK ] POWER_INSTABILITY
USB_RECONNECT_LOOP           [ OK ] USB_INTERMITTENT
USB_ENUMERATION_FAILURE      [ OK ] USB_NOT_ENUMERATED
PERIODIC_DEVICE_REBOOT       [ OK ] TARGET_RESET_LOOP
UART_CONFIGURATION_MISMATCH  [ OK ] SERIAL_CONFIGURATION_MISMATCH
DHCP_FAILURE                 [ OK ] DHCP_FAILURE
DNS_FAILURE                  [ OK ] DNS_FAILURE
UNSTABLE_NETWORK             [ OK ] NETWORK_UNSTABLE
I2C_DEVICE_DISAPPEARED       [ -- ] needs repeated I2C scans
I2C_BUS_INSTABILITY          [ -- ] needs I2C error frames in HDP
```

Every diagnosis returns OBSERVED, CORRELATED, POSSIBLE CAUSE, CONFIDENCE,
RECOMMENDED CHECK and EVIDENCE REFERENCES (`[ OK ]`: the HDP frames it
rests on, by sequence number). Never "the problem is definitely X".

GATE: every diagnosis has a scenario, an .hdlog, an expected answer and a
regression test. **PASS for the 13 rules** (HD-T000 to HD-T013, HD-C001
to HD-C014, `cases.test.ts` fails if one is missing). The two I2C rules
come with LVL 80.

### LVL 50 — .hdlog BECOMES A CASE        DONE

```text
incident.hdlog -> CREATE CASE -> HD-Cxxx -> hwdog test cases/
```

```text
[ OK ] case = recording + SHA-256 + expected facts + diagnosis + confidence
[ OK ] SAVE AS CASE in the interface; every case runs on each commit
[ OK ] description, hardware context, notes in the case file
[ OK ] hwdog test cases/: a command line runner outside the test suite
       (web/src/cli/hwdog.ts, run in CI), and hwdog report <file.hdlog>
```

### LVL 55 — dogd, THE LOCAL BACKBONE        DONE

dogd is not a second brain, and not an Internet backend (LAWS.md).
Everything about it: [`DOGD.md`](DOGD.md), with the gate checklist.

```text
DEVICE DISCOVERY   SESSION STORAGE   HDP TRANSPORT
LOCAL API          WEBSOCKET         REPORT GENERATION

WebSerial ─┐
Simulator ─┼─> HDP v1        no special Rust event, same contract everywhere
dogd ──────┘
```

GATE: the interface connected over Web Serial or through dogd receives the
same frames and reaches the same results. Proven in CI against the real
binary (`web/test/dogd.test.ts`): simulator direct == simulator through
dogd, same facts, same diagnosis, same evidence references.

Locked before dogd: **evidence references**. Every HDP frame has a sequence
number in its session; every diagnosis cites the frames it rests on. The
numbers are the same live, replayed and through dogd, so dogd can index
sessions without a migration later.

### LVL 60 — FIRST PHYSICAL HARDWARE DOG     PARTIAL

```text
SIMULATOR                 PASS
FIRMWARE CORE (PC + CI)   PASS   every frame validates hdp_v1.json; the engine
                                 reads it like the simulator; through dogd ==
                                 direct (web/test/firmware.test.ts)
FIRMWARE BUILD esp32s3    CI     ESP-IDF v5.4
FIRMWARE ON SILICON       PENDING  bring-up checklist, FIRMWARE.md
REPLAY                    PASS
```

Found on the way, fixed for good: a device that does not watch USB was
diagnosed USB NOT ENUMERATED from silence. Devices now declare what they
observe (`hello.caps`), and the USB rules only run when USB is watched
(ruleset v2).

No custom PCB. ESP32-S3 dev board, INA226, UART, Wi-Fi.
`REAL HARDWARE -> HDP v1 -> existing software`, the frontend barely
changes.

```text
GATE   SIMULATOR   PASS
       FIRMWARE    PASS     same contract test
       REPLAY      PASS
```

### LVL 65 — CALIBRATION + TRUTHFULNESS     PARTIAL

Every measurement exposes its range, sample rate, expected accuracy,
resolution, calibration date, sensor identity, firmware and limitations,
and says: `DIAGNOSTIC MEASUREMENT, NOT CERTIFIED METROLOGY`. Several
INA226 boards are tested against a reference instrument: the goal is to
know exactly how far the numbers can be trusted.

```text
[ OK ] power.meter (PROTOCOL.md): sensor, shunt, range, resolution, rate,
       expected error and its basis (DATASHEET | CALIBRATION), calibration
       date and reference instrument
[ OK ] firmware: datasheet worst case from the INA226 figures and the
       shunt tolerance; meter.cal / meter.clear, stored in NVS, applied to
       every sample, refused out of range (C tests, firmware.test.ts)
[ OK ] interface: POWER -> MEASUREMENT, +- next to every live reading,
       "accuracy unknown" when a device declares nothing
[ OK ] calibration from the palette: meter point / meter cal, least-squares
       fit, largest residual declared (calibration.test.ts)
[ OK ] reports: MEASUREMENT section and the metrology line in every format
[ -- ] GATE: several INA226 boards against a reference instrument,
       declared error vs measured error. Needs the boards (FIRMWARE.md,
       bring-up step 4).
```

### LVL 70 — REAL FAULT LAB     PARTIAL

Faults created on purpose: cheap USB cable, undervoltage, brownout, loose
connector, wrong baud, missing I2C pull-up, intermittent I2C, DHCP loss,
DNS loss, network latency, boot loop, USB reconnect loop.

```text
PHYSICAL FAILURE -> HDLOG -> CASE -> REGRESSION TEST
```

The simulator gradually stops being made of imagined scenarios and starts
reproducing traces of real failures.

```text
[ OK ] FAULT_LAB.md: twelve faults, how to make each one safely, what to
       expect, what the reference firmware can see today
[ OK ] the pipeline: record -> SAVE AS CASE -> context -> hwdog test
[ -- ] GATE: the faults recorded on the bench as PHYSICAL cases, and the
       simulator re-tuned from them. Needs the board.
```

### LVL 75 — PROFESSIONAL REPORTS     DONE

A document a technician attaches to a ticket: device, session, provenance,
recording hash, observations, correlations, diagnoses, confidence,
recommended checks, timeline excerpt, measurement limitations.
Exports TXT, JSON, HTML, PDF. JSON stays the machine-readable truth.

```text
[ OK ] one source: reportLines() (core/report.ts). TXT, HTML and PDF are
       set from the same styled lines: no format says what another does not
[ OK ] timeline excerpt: the events the diagnoses cite (>) with two
       events of context each side, and how many were left out
[ OK ] measurement limitations (LVL 65) and the metrology line
[ OK ] HTML: one file, no script, no remote resource (CSP), everything
       from the device escaped, prints on A4
[ OK ] PDF: written by Hardware Dog (core/pdf.ts), no library, no server;
       standard Courier fonts, A4, the SIMULATED / MODIFIED warning on
       every page, page numbers, same report = same bytes
[ OK ] GATE: a real PDF reader (pdf.js, test only) opens it and finds
       every line of the TXT report (web/test/reports.test.ts)
```

### LVL 80 — NETWORK + I2C ON HARDWARE

W5500 Ethernet, I2C scanner, network probes, correlated with everything
else. Not "ping works", but the chain:

```text
12:01:22  POWER     sag
12:01:22  SYSTEM    reboot
12:01:23  LINK      down
12:01:26  LINK      up
12:01:27  DHCP      acquired
12:01:28  DNS       ready
```

### LVL 85 — PCB REV A

KiCad: USB power path, current sensing, ESP32-S3, Ethernet, UART
protection, I2C, display, ESD and power protection, test points,
programming / debug. Delivered with schematic, PCB, BOM, Gerbers, assembly
notes and a test procedure.

**No PCB before the physical prototype has many real hours of diagnosis
behind it.** Otherwise the mistakes get etched into copper.

### LVL 90 — PROBE ARCHITECTURE

Hardware Dog stops being a box and becomes a platform, without growing a
Frankenstein core: CAN DOG, USB DOG, POWER DOG, ENVIRONMENT, RS-485, GPIO
are probes, and every probe simply produces HDP.

### LVL 95 — COMMUNITY INCIDENT LIBRARY

Not a social network. A repository of anonymized, reproducible cases
(`cases/power`, `usb`, `uart`, `network`, `i2c`). Submissions are a pull
request: .hdlog, description, hardware, expected behavior; tests run
automatically, then review. A real library of hardware failures is worth
more than code.

### LVL 100 — HARDWARE DOG 1.0

```text
[ ] stable HDP v1                  [ ] USB
[ ] stable HDLOG                   [ ] power
[ ] deterministic replay           [ ] UART
[ ] evidence integrity             [ ] I2C
[ ] diagnostic engine              [ ] network
[ ] physical reference hardware    [ ] custom PCB
[ ] documented measurement limits  [ ] enclosure
[ ] real fault regression library  [ ] reproducible build
[ ] dogd                           [ ] firmware update procedure
[ ] session archive                [ ] recovery / failed update path
[ ] professional reports           [ ] complete documentation
[ ] security review                [ ] license + trademark docs
```

Then, without exaggeration:

> Hardware Dog 1.0 is a source-available, local-first hardware diagnostic
> system that records electrical, protocol and network evidence on one
> synchronized timeline and turns real incidents into reproducible
> diagnostic cases.

### MAX LVL — AFTER 1.0

```text
LIVE INCIDENT -> .HDLOG -> ANONYMIZE -> CASE LIBRARY -> REGRESSION
              -> BETTER RULES -> BETTER HARDWARE DOG
```

No mandatory cloud: users choose to contribute an incident. Hardware Dog
learns in the engineering sense, more reproducible cases, more tests,
better diagnoses. AI, if ever, comes last and only explains:

```text
FACTS + CORRELATIONS + RULE RESULTS -> OPTIONAL LOCAL AI -> HUMAN EXPLANATION
```

Never `raw signals -> AI guess -> trust me bro`.

### Not now

```text
advanced Bluetooth diagnostics     CAN bus (until LVL 90 probes)
JTAG / SWD debugger                full USB-PD analyzer
oscilloscope                       16-channel logic analyzer
USB packet analyzer                AI everywhere
```

Otherwise Hardware Dog becomes a Frankenstein before it has an identity.

---

## 18 — DESIGN AND BRAND

Not duplicated here. Both are locked in their own documents:

```text
DESIGN_SPEC.md   interface, screens, colors, typography, industrial design
BRAND.md         official mascot, asset roles, favicon / icon / header rules
```

---

## LICENSING

Hardware Dog uses a dual-license model.

```text
PERSONAL / NON-COMMERCIAL    PolyForm Noncommercial 1.0.0
COMMERCIAL                   separate paid Hardware Dog commercial license
```

See [`LICENSE`](../LICENSE) and [`COMMERCIAL.md`](../COMMERCIAL.md).

The repository is **source-available**. It is not open source in the OSI
sense.

The Hardware Dog name, logo and official mascot are separate brand assets
and are not granted for unrestricted third-party branding or resale.

---

## CHANGELOG

```text
0.7   LVL 60 partial: firmware core verified on a PC and in CI, ESP32-S3
      build, bring-up checklist; hello.caps and ruleset v2
0.6   LVL 55 done: dogd (DOGD.md), evidence references locked before it
0.5   laws of the project (LAWS.md); roadmap by level, LVL 40 to MAX LVL;
      LVL 40 closed: hostile-file limits, compatibility rule, v1 fixture
0.4   milestone EVIDENCE INTEGRITY + CASES (section 1): .hdlog v2 with
      provenance, sealed hash chain and footer; recovery and snapshots;
      cases as regression tests
0.3   session recording implemented (section 8): .hdlog format, browser
      archive, replay, example sessions as regression tests
0.2   aligned with the implementation: source-available wording, single
      licensing section, simulator as a core component, precise USB
      capabilities, HDP schema contract, design and brand by reference,
      new milestone and roadmap
0.1   original plan (git history)
```
