# HARDWARE DOG / ENGINEERING PLAN

```text
DOCUMENT      ENGINEERING PLAN
COMPANION TO  DESIGN_SPEC.md (interface and industrial design)
              VISION.md      (product vision)
```

I want to build Hardware Dog as a real open-source product, not a GitHub
project that only exists to look good.

The central concept:

> **Hardware Dog — a pocket diagnostic companion for hardware, USB, serial
> and network troubleshooting.**
>
> You plug it in. It sniffs. It tells you what is really going on.

Above all: **local-first, no account, no SaaS, no mandatory cloud.** That
fits my style much better and makes the project useful even without
Internet.

---

## 1 — PRODUCT VISION

Hardware Dog is a small portable box able to observe several layers of a
system:

```text
PHYSICAL -> ELECTRICAL -> PROTOCOL -> NETWORK -> SOFTWARE
```

The goal is not to replace an oscilloscope or a Fluke multimeter. The
product answers a different question:

> **"Why doesn't this thing work?"**

You plug Hardware Dog between your laptop and your device, or directly onto
a network / serial port, and you get a unified view of what it sees.

Example diagnostics:

- USB plugged in, but the device is not detected.
- 5 V present, but abnormal current draw.
- Serial port active, but wrong baud rate.
- Ethernet device connected, but no DHCP.
- DNS works, but HTTP does not.
- Wi-Fi connected, but unstable latency.
- Device that resets periodically.
- I²C sensor present, but answering badly.
- Device that disappears and comes back on USB.
- Voltage drop when a peripheral starts up.

No security exploitation, no bypass: diagnostics of hardware you control.

---

## 2 — THE 4 MODES OF HARDWARE DOG

Four functions, extremely clear.

### SNIFF

Passive observation. Hardware Dog watches, without modifying anything:

```text
USB connected
voltage
current
UART
I2C
network
Wi-Fi
device state
```

### PROBE

Simple, safe active tests:

```text
ping
DNS lookup
HTTP health check
TCP port test
local I2C scan
serial test
USB enumeration
network test
```

### TRACE

A timeline:

```text
14:03:21 USB connected
14:03:21 5.08 V
14:03:22 Device detected
14:03:22 VID 0x303A
14:03:24 Current spike 740 mA
14:03:24 Voltage drop 4.63 V
14:03:25 USB disconnect
```

This is where Hardware Dog becomes genuinely useful.

### REPORT

One click: **Export diagnostic**.

```text
Hardware Dog Report
Session: HD-20260930-1421

USB
Connected: YES
Voltage avg: 5.04 V
Current avg: 310 mA
Peak: 742 mA

Network
DHCP: OK
Gateway: OK
DNS: OK
Internet: FAIL

Serial
115200 8N1
Data detected: YES
Framing errors: 14

Possible issue:
Voltage instability detected during startup.
```

TXT + JSON, and possibly HTML / PDF.

---

## 3 — GENERAL ARCHITECTURE

Three layers.

```text
┌─────────────────────────────┐
│       HARDWARE DOG UI       │
│ React / TypeScript / PWA    │
└──────────────┬──────────────┘
               │
        WebSocket / HTTP
               │
┌──────────────▼──────────────┐
│            DOGD             │
│ Rust diagnostic daemon      │
│ sessions / rules / storage  │
└──────────────┬──────────────┘
               │
        USB / Serial / Wi-Fi
               │
┌──────────────▼──────────────┐
│    HARDWARE DOG DEVICE      │
│ ESP32-S3 firmware           │
│ sensors / UART / I2C / USB  │
└─────────────────────────────┘
```

This makes a project that crosses hardware -> embedded -> Rust -> API ->
React -> UX.

---

## 4 — HARDWARE, REV A

### MCU

**ESP32-S3.** Why:

```text
Wi-Fi
Bluetooth
USB OTG
plenty of GPIO
ADC
I2C
SPI
UART
huge ecosystem
cheap
easy to prototype
```

An STM32 / RP2040 version can always come later.

### Display

Small IPS display, about 2.4–2.8". No need for a full UI on it. It only
shows:

```text
HARDWARE DOG
USB    ●
NET    ●
UART   ○
I2C    ●
5.07V
284mA
SNIFFING...
```

The real interface stays on the phone / laptop.

### Connectors

```text
USB-C HOST
USB-C DEVICE
USB-A
RJ45
UART header
I2C header
GPIO
Power input USB-C
```

Rev A does not need everything to be bidirectional.

### Electrical measurement

An INA226-type circuit fits the spirit of the project perfectly, to measure:

- voltage;
- current;
- power;
- peaks.

A low-voltage USB passthrough:

```text
USB IN
  │
current sense
  │
USB OUT
```

Hardware Dog observes the electrical behavior.

### Ethernet

At first: **W5500 SPI Ethernet.** Not sexy, but extremely well documented
and stable. Rev B can have a real integrated Ethernet PHY.

### UART

Header:

```text
GND
TX
RX
3V3
```

And above all, proper protection. The first version stays **3.3 V TTL
only**. No RS-232 directly on the MCU.

---

## 5 — PCB

Even if the prototype starts on modules, I create this immediately:

```text
hardware/
  rev-a/
    schematic/
    pcb/
    gerbers/
    bom/
    assembly/
```

KiCad. And it goes public.

Professionally, this is worth gold: someone opens the GitHub and actually
finds the electronic schematic.

### Conceptual layout

```text
 ┌──────────────────────────┐
 │      HARDWARE DOG        │
 │                          │
 │      2.4" DISPLAY        │
 │                          │
 │   ● USB   ● NET          │
 │   ● UART  ● I2C          │
 │                          │
 │ [USB-C]         [RJ45]   │
 │                          │
 │ [UART] [I2C] [GPIO]      │
 └──────────────────────────┘
```

Diagnostic connectors on the bottom. Network / USB ports on the sides.

---

## 6 — INDUSTRIAL DESIGN

Definitely not an RGB gaming thing.

I want an object somewhere between a **lab instrument + old industrial
electronics + a modern cyberdeck**.

Enclosure:

```text
ABS or 3D printed
rounded corners
4 visible screws
light grille
small rear kickstand
optional magnets
```

Approximate dimensions: **120 × 75 × 25 mm**. Big enough to handle, small
enough to fit in a bag.

---

## 7 — BRANDING

```text
NAME        HARDWARE DOG
SUBTITLE    Sniff the problem.
```

Logo: a minimalist dog profile whose snout turns into an electronic trace.
Something like:

```text
    /‾\
 __/ o \
/       >─────╱╲──╱╲────
\__    /
   \__/
```

Not literally that, but that principle.

### Colors

A slight departure from my StreetWizard palette.

```text
BACKGROUND   #101112
SURFACE      #181A1B
TEXT         #F2F0E9
LIVE         turquoise #00E5FF
WARNING      mustard / amber #E4B04A
CRITICAL     red, only when there really is a critical condition
```

IBM Plex Mono / IBM Plex Sans Condensed fit this universe perfectly.

---

## 8 — MAIN INTERFACE

Desktop:

```text
┌─────────────────────────────────────────────┐
│ HARDWARE DOG               DEVICE HD-001    │
├────────────┬────────────────────────────────┤
│            │                                │
│ OVERVIEW   │        LIVE TRACE              │
│ USB        │                                │
│ NETWORK    │  USB CONNECTED                 │
│ SERIAL     │  5.04 V       312 mA           │
│ I2C        │                                │
│ TRACE      │  ▂▂▃▃▄▅▇▅▃▃                    │
│ REPORTS    │                                │
│            │                                │
└────────────┴────────────────────────────────┘
```

---

## 9 — OVERVIEW

The dashboard must be understandable instantly.

```text
DEVICE
Hardware Dog Rev A
Firmware 0.1.2

USB
CONNECTED
5.04 V
312 mA
480 Mbps

NETWORK
LINK 1 Gbps
DHCP OK
192.168.1.84

UART
DATA DETECTED
115200 baud

I²C
3 DEVICES
0x3C
0x40
0x76
```

---

## 10 — LIVE TRACE

Probably the killer feature. Every event goes into one single timeline.

```text
12:31:08.012  USB     connected
12:31:08.080  POWER   5.07 V / 112 mA
12:31:08.322  USB     descriptor received
12:31:08.380  USB     VID 303A PID 1001
12:31:09.001  POWER   691 mA
12:31:09.010  WARN    voltage drop detected
12:31:09.023  POWER   4.61 V
12:31:09.102  USB     disconnected
```

With filters:

```text
ALL  USB  POWER  NETWORK  UART  I2C  SYSTEM
```

---

## 11 — GRAPHS

Voltage:

```text
5.2 ────────────────────
5.0 ───────╲────────────
4.8        ╲
4.6         ╲___
```

Also: current, latency, packet loss, UART activity, device reconnects.

Everything real time over WebSocket.

---

## 12 — FIRMWARE

Structure:

```text
firmware/
├── src/
│   ├── main
│   ├── usb
│   ├── power
│   ├── ethernet
│   ├── wifi
│   ├── uart
│   ├── i2c
│   ├── display
│   ├── events
│   └── protocol
```

Each subsystem emits events. Conceptual examples:

```json
{
  "type": "power.sample",
  "ts": 1780248212123,
  "voltage": 5.04,
  "current": 0.312
}
```

UART:

```json
{
  "type": "uart.activity",
  "port": 1,
  "baud": 115200,
  "bytes": 128
}
```

USB:

```json
{
  "type": "usb.device.connected",
  "vid": "303A",
  "pid": "1001"
}
```

---

## 13 — COMMUNICATION

An official Hardware Dog protocol, defined from day one.

```text
NAME         HDP — Hardware Dog Protocol
TRANSPORTS   USB serial, WebSocket, local TCP
MVP FORMAT   JSON
LATER        CBOR / protobuf if needed
```

---

## 14 — LOCAL BACKEND: DOGD

This is where the Rust shows.

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

```text
Rust
Tokio
Axum
Serde
SQLite
```

dogd discovers Hardware Dog and maintains a diagnostic session.

---

## 15 — API

A very clean API.

```text
GET  /api/v1/device
GET  /api/v1/status
GET  /api/v1/usb
GET  /api/v1/network
GET  /api/v1/serial
GET  /api/v1/i2c
GET  /api/v1/sessions
GET  /api/v1/sessions/:id
POST /api/v1/probes/ping
POST /api/v1/probes/dns
POST /api/v1/probes/http
POST /api/v1/reports
```

Real time:

```text
WS   /api/v1/live
```

---

## 16 — DATA MODEL

SQLite.

```text
devices
  id
  serial_number
  hardware_revision
  firmware_version
  first_seen
  last_seen

sessions
  id
  device_id
  started_at
  ended_at
  name
  notes

events
  id
  session_id
  timestamp
  category
  type
  severity
  payload_json

metrics
  id
  session_id
  timestamp
  metric
  value
  unit

reports
  id
  session_id
  created_at
  summary
  diagnosis
```

---

## 17 — DIAGNOSTIC ENGINE

Very important: **no mandatory AI.** A deterministic engine first.

```text
IF    USB disconnect
AND   voltage < 4.75
      within 100 ms
THEN  POWER_INSTABILITY
      confidence HIGH
```

```text
IF    network.link = true
AND   dhcp = true
AND   gateway = true
AND   dns = false
THEN  DNS_FAILURE
```

```text
IF    UART activity
AND   framing_errors > threshold
THEN  SERIAL_CONFIGURATION_MISMATCH
```

That builds something reliable.

---

## 18 — OPTIONAL AI, LATER

AI could only **explain** the data. Example:

> "The USB device appears to reboot after a voltage drop. Check the power
> supply or the cable before looking for a software problem."

But detection never depends on AI. Very important for the product's
credibility.

---

## 19 — PWA

```text
React
TypeScript
Vite
WebSocket
IndexedDB
```

Installable. Desktop. Mobile. No native app needed.

---

## 20 — WORKING WITHOUT A HARDWARE DOG

Very important for a public GitHub: a **DEMO MODE**.

When someone clones the repo:

```sh
npm run demo
```

they get a fake device that simulates:

```text
USB disconnect
voltage drop
network failure
UART traffic
```

So anyone can try the software without owning the hardware.

---

## 21 — REPOSITORY

A monorepo.

```text
hardware-dog/
│
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
│
├── firmware/
├── hardware/
├── enclosure/
├── dogd/
├── web/
├── protocol/
├── simulator/
├── docs/
├── examples/
└── .github/
```

---

## 22 — README

The first thing visible:

```text
HARDWARE DOG
Sniff the problem.
Open-source hardware diagnostic companion.
USB • Power • Serial • I²C • Network
```

Then a 10-second GIF. Then:

> Hardware Dog observes hardware and network behaviour and turns it into
> one diagnostic timeline.

And a diagram:

```text
DEVICE
  │
Hardware Dog
  │
dogd
  │
Browser
```

---

## 23 — OPEN SOURCE

Actually public:

```text
firmware
daemon
frontend
protocol
PCB
schematics
3D enclosure
docs
```

Something could stay private only if it turns out to be a real technology
that is a major commercial advantage. But Rev A: open.

---

## 24 — LICENSING

> **Decision in effect:** the repository uses a dual license, PolyForm
> Noncommercial 1.0.0 for personal use plus a paid commercial license
> (see [`LICENSE`](../LICENSE) and [`COMMERCIAL.md`](../COMMERCIAL.md)).
> The options below are the ones originally considered.

Simple:

```text
SOFTWARE    Apache-2.0
HARDWARE    CERN-OHL-P
DOCS        CC BY 4.0
```

Or simplify: everything MIT except the PCB.

---

## 25 — GITHUB ACTIONS

From day one:

```text
firmware build
Rust tests
TypeScript build
eslint
format
unit tests
release artifacts
```

README badges:

```text
Firmware ✓
Backend ✓
Frontend ✓
Open Hardware ✓
```

That way public activity is natural, not artificial.

---

## 26 — TESTS

Three levels.

```text
UNIT         protocol parser
             diagnostic rules
             API
             frontend logic

SIMULATION   fake USB
             fake voltage
             fake network
             fake UART

PHYSICAL     real ESP32
             real USB device
             real bad cable
             real network cut
```

The scenarios can even be published:

```text
HD-T001  USB undervoltage
HD-T002  DHCP failure
HD-T003  DNS failure
HD-T004  serial framing mismatch
HD-T005  intermittent USB disconnect
```

---

## 27 — VERSION 0.1

Do NOT build everything at once. The real v0.1:

```text
ESP32-S3
+ INA226
+ UART
+ Wi-Fi
+ dogd (Rust)
+ React dashboard
+ Live Trace
```

That is already a product.

```text
NOT IN 0.1    Ethernet
              custom PCB
              final enclosure
              AI
              BLE
```

---

## 28 — VERSION 0.2

Adds:

```text
Ethernet
I2C scanner
session recording
reports
network diagnostics
```

---

## 29 — VERSION 0.3

```text
Hardware Dog Rev A PCB
display
3D printed enclosure
USB passthrough
```

---

## 30 — VERSION 1.0

A coherent product:

```text
USB diagnostics
Power telemetry
UART
I2C
Ethernet
Wi-Fi
Timeline
Reports
Device simulator
PWA
Rust backend
Custom PCB
3D enclosure
Documentation
```

---

## 31 — WHAT I WOULD NOT ADD

Not now:

```text
advanced Bluetooth diagnostics
CAN bus
JTAG
SWD debugger
full USB-PD analyzer
oscilloscope
16-channel logic analyzer
advanced packet analyzer
AI everywhere
```

Otherwise Hardware Dog becomes a Frankenstein before it has an identity.

---

## 32 — KILLER FEATURE

It is not the hardware. It is:

> **ONE TIMELINE.**

Today, diagnosing a problem means looking at:

```text
multimeter
serial terminal
Wireshark
system logs
ping
Device Manager
browser console
```

Hardware Dog puts all of it into:

```text
12:02 voltage changed
12:02 USB reset
12:02 network lost
12:02 firmware reboot
```

And suddenly: **cause -> consequence.**

That is the product.

---

## 33 — FIRST WORK SESSION

Do not touch the PCB yet.

Create:

```text
hardware-dog/
  README.md
  web/
  dogd/
  firmware/
  hardware/
  protocol/
  simulator/
  docs/
```

First objective: make this appear in a browser.

```text
HARDWARE DOG
● DEVICE ONLINE

USB
5.04 V
312 mA

NETWORK
ONLINE
12 ms

LIVE TRACE
12:42:01 Device connected
12:42:02 Power stable
12:42:03 USB detected
```

The values come from a simulator. No hardware yet.

Once the protocol, the dashboard and the timeline work with a fake Hardware
Dog, each simulated value can be replaced by real hardware, one at a time.

And above all: commit publicly from the very first skeleton.

```text
initial: hardware dog architecture
```

Then each real step:

```text
feat(protocol): define device event schema
feat(simulator): add power telemetry
feat(web): add live trace
feat(dogd): websocket event stream
```

This way the repository shows how the project is thought through and
built, not just the final result.

Following this architecture, Hardware Dog covers electronics + embedded +
Rust + networking + frontend + industrial design in a single project.
