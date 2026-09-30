# HARDWARE DOG / ENGINEERING PLAN

```text
DOCUMENT      ENGINEERING PLAN
VERSION       0.2 / IMPLEMENTATION-ALIGNED
STATUS        ACTIVE IMPLEMENTATION
COMPANION TO  DESIGN_SPEC.md       interface and industrial design (locked)
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

The central engineering principle is:

> **ONE EVENT MODEL.**
> **ONE CLOCK.**
> **ONE TIMELINE.**

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
[ NEXT ] session recording                  persistent sessions, replay
[ NEXT ] dogd integration                   Rust daemon, third transport
[ NEXT ] physical ESP32-S3 reference device firmware on a dev board
```

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
transport          OK        web/src/core/transport.ts (Web Serial, simulator)
HDP decoder        OK        web/src/core/protocol.ts
trace engine       OK        web/src/core/trace.ts
system state       OK        web/src/core/system.ts (single source of truth)
diagnostic rules   OK        web/src/core/diagnostics.ts
session store      PARTIAL   in-memory session facts + JSON export; persistence NEXT
UI / reports       OK        web/src/ui, web/src/core/report.ts
dogd               PLANNED   Rust daemon, section 10
firmware           PLANNED   ESP32-S3, section 11
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
NOW    in-memory session facts (web/src/core/diagnostics.ts), trace ring
       buffer, JSON export of report + full timeline
NEXT   persistent sessions in the browser (IndexedDB): record, reopen,
       replay a session through the same decoder
LATER  SQLite in dogd, same data model
```

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
becomes a regression test.

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

## 10 — DOGD, LOCAL DAEMON (PLANNED)

Rust, local only. It discovers Hardware Dog devices, keeps sessions, stores
them in SQLite and serves the UI.

```text
Rust, Tokio, Axum, Serde, SQLite
```

```text
dogd/
├── src/
│   ├── main.rs
│   ├── api/
│   ├── device/
│   ├── sessions/
│   ├── diagnostics/
│   ├── storage/
│   ├── websocket/
│   └── rules/
```

API:

```text
GET  /api/v1/device
GET  /api/v1/status
GET  /api/v1/sessions
GET  /api/v1/sessions/:id
POST /api/v1/probes/{ping,dns,http}
POST /api/v1/reports
WS   /api/v1/live            the HDP event stream, unchanged
```

Integration rule: dogd is **a third transport**. `WS /api/v1/live` carries
HDP v1 frames exactly as the device emits them, so the UI plugs dogd in
next to Web Serial and the simulator without changing the trace engine.
The diagnostic rules move to Rust only with a shared test corpus: the same
scenarios must produce the same diagnoses in both implementations.

---

## 11 — FIRMWARE (PLANNED)

ESP32-S3. Each subsystem emits HDP v1 frames; nothing else leaves the
device.

```text
firmware/
├── src/
│   ├── main
│   ├── power       INA226 sampling -> power
│   ├── usb         host port enumeration -> usb.attach / usb.detach
│   ├── uart        target UART -> uart.config / uart.rx / uart.error
│   ├── i2c         bus scan + verified identities -> i2c.scan
│   ├── net         Wi-Fi / Ethernet layer checks -> net.status, probes
│   ├── display
│   ├── events      clock, queue, back-pressure
│   └── protocol    HDP v1 encoder + contract self-test
```

Examples are the real frames (full list in `PROTOCOL.md`):

```json
{"type":"power","t":1200,"v":5.041,"i":0.312}
{"type":"usb.attach","t":1214,"speed":"FULL","vid":12346,"pid":4097,"cls":"CDC","power":"BUS","manufacturer":"Espressif","product":"USB JTAG/Serial","serial":"48:27:E2:5C:1A:90"}
{"type":"uart.rx","t":1320,"data":"bootloader 0.9"}
```

Acceptance: the firmware's output, captured on real hardware, validates
against `protocol/hdp_v1.json` and runs through the same reliability tests
as the simulator (physical scenarios HD-P0xx, section 14).

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
.github/         CI                   examples/    recorded sessions
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

## 17 — ROADMAP

```text
0.1  SOFTWARE REFERENCE IMPLEMENTATION     in progress (section 1)
0.2  sessions + dogd                        IndexedDB sessions, replay, dogd with
                                            WebSocket transport and SQLite
0.3  physical reference device              ESP32-S3 dev board + INA226 + UART,
                                            firmware passing the HDP contract,
                                            physical scenarios HD-P001..005
0.4  Ethernet + I2C scanner on hardware     W5500, verified I2C identities
0.5  Rev A PCB + display + enclosure        KiCad, 3D printed case
1.0  coherent product                       all of the above, documented
```

### Not now

```text
advanced Bluetooth diagnostics     CAN bus           JTAG / SWD debugger
full USB-PD analyzer               oscilloscope      16-channel logic analyzer
USB packet analyzer                advanced packet analyzer     AI everywhere
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
0.2   aligned with the implementation: source-available wording, single
      licensing section, simulator as a core component, precise USB
      capabilities, HDP schema contract, design and brand by reference,
      new milestone and roadmap
0.1   original plan (git history)
```
