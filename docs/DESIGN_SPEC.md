# HARDWARE DOG / DESIGN SPECIFICATION

```text
┌──────────────────────────────────────────────────────┐
│               H A R D W A R E   D O G                │
│                  hardware companion                  │
├──────────────────────────────────────────────────────┤
│ Booting core systems...                              │
│ [ OK ] power monitor                                 │
│ [ OK ] usb interface                                 │
│ [ OK ] serial interface                              │
│ [ OK ] network probe                                 │
│ [ OK ] event pipeline                                │
│ [ OK ] trace engine                                  │
│ [ OK ] diagnostics rules                             │
│                                                      │
│ Device ID      : HD-001                              │
│ Firmware       : 0.1.0                               │
│ Mode           : LOCAL                               │
│ Session        : READY                               │
│                                                      │
│ Type HELP for commands                               │
└──────────────────────────────────────────────────────┘
```

**Design Specification — Public Draft**

Hardware Dog is my hardware companion. I want it to feel like a piece of
diagnostic equipment, not another modern SaaS dashboard wearing a dark theme.

Hardware Dog sits between old-school computer diagnostics, embedded
instrumentation and modern developer tooling.

The product can use modern technology underneath, but the interface should
feel direct, technical, local and trustworthy.

When Hardware Dog starts, I want the impression that a machine is booting.
Not that a website is loading.

---

## 01 — DESIGN PHILOSOPHY

My central design rule is:

> **Hardware Dog must look like a tool before it looks like software.**

I do not want:

- generic startup dashboards
- oversized rounded cards
- gradients everywhere
- glassmorphism
- floating pills
- excessive animation
- AI branding
- decorative charts with no technical value
- a UI that looks like every modern admin panel

I want:

- terminal structure
- instrument panels
- diagnostic states
- live signals
- clear borders
- dense but readable information
- keyboard navigation
- ASCII elements
- boot sequences
- precise timestamps
- engineering terminology
- visible system state

The interface should feel like something I would expect to find connected to
a diagnostic bench.

---

## 02 — PRODUCT PERSONALITY

Hardware Dog is not corporate. It is not playful in the usual startup sense
either. Its personality comes from being:

```text
CURIOUS
TECHNICAL
DIRECT
RELIABLE
A LITTLE WEIRD
```

The dog metaphor gives the product personality without turning it into a toy.

Hardware Dog:

```text
SNIFFS
PROBES
WATCHES
TRACES
REPORTS
```

I want those verbs to become part of the product vocabulary.

---

## 03 — BRAND

```text
NAME                     HARDWARE DOG
SHORT FORM               HW DOG
DESCRIPTOR               hardware companion
PRIMARY TAGLINE          SNIFF THE PROBLEM.
TECHNICAL DESCRIPTOR     LOCAL HARDWARE DIAGNOSTIC SYSTEM
```

---

## 04 — LOGO DIRECTION

The logo should represent a hardware companion rather than a generic
technology company.

The main symbol is a dog. The dog can be partially mechanical, but I do not
want a cliché chrome robot dog.

The preferred direction is:

```text
DOG
+
HARDWARE DETAILS
+
USB CABLE
```

The USB cable replaces the leash. That detail communicates the entire concept
immediately.

The dog should feel confident and useful rather than aggressive.

Visual references:

```text
service manual illustration
industrial equipment logo
1980s computer documentation
electronics workshop graphics
early workstation branding
```

The mark must also survive conversion into:

```text
1-bit monochrome
ASCII
favicon
PCB silkscreen
laser engraving
terminal boot screen
```

If the logo only works as a polished full-color illustration, it is not
finished.

---

## 05 — ASCII IDENTITY

ASCII is part of the real product identity. It is not just a joke for the
README.

```text
██╗  ██╗██╗    ██╗    ██████╗  ██████╗  ██████╗
██║  ██║██║    ██║    ██╔══██╗██╔═══██╗██╔════╝
███████║██║ █╗ ██║    ██║  ██║██║   ██║██║  ███╗
██╔══██║██║███╗██║    ██║  ██║██║   ██║██║   ██║
██║  ██║╚███╔███╔╝    ██████╔╝╚██████╔╝╚██████╔╝
╚═╝  ╚═╝ ╚══╝╚══╝     ╚═════╝  ╚═════╝  ╚═════╝

           / \__
          (    @\___
          /         O================[ USB ]
         /   (_____/
        /_____/   \
```

This identity can appear in:

- startup screens
- CLI
- README
- serial console
- logs
- documentation
- recovery mode
- diagnostic exports

---

## 06 — COLOR SYSTEM

The palette is intentionally small. I want colors to communicate system
meaning, not decoration.

### Base

```text
BACKGROUND      #0B0D0F
PANEL           #111417
PANEL ALT       #16191C
BORDER          #34393D
TEXT            #ECE8DE
TEXT DIM        #8A9195
```

### Signal colors

```text
CYAN            #00E5FF
PINK            #FF4FA3
AMBER           #E4B04A
GREEN           #79D98A
RED             #FF5F56
```

**Cyan** — used for:

```text
LIVE DATA
LINKS
ACTIVE SIGNALS
SELECTION
DEVICE COMMUNICATION
```

**Pink** — pink is part of Hardware Dog's identity. I want a noticeable amount
of pink on the hardware and software, but never enough to make the instrument
look decorative. Used for:

```text
BRAND DETAILS
SECONDARY SIGNAL
HARDWARE ACCENTS
SELECTED MODULES
DOG IDENTITY
```

**Amber** — used for:

```text
WARNING
DEGRADED
ATTENTION REQUIRED
```

**Green** — used strictly for:

```text
OK
PASS
STABLE
CONNECTED
```

**Red** — reserved for actual failure:

```text
FAIL
FAULT
CRITICAL
UNSAFE
```

If everything is green or red, those colors stop meaning anything.

---

## 07 — TYPOGRAPHY

Typography is extremely important because most of the product is
information.

```text
PRIMARY INTERFACE FONT      IBM Plex Mono
SECONDARY / TITLE FONT      IBM Plex Sans Condensed
```

I do not want five font weights and ten display sizes. The interface should
feel like documentation.

Suggested scale:

```text
11px    metadata
12px    logs
13px    normal technical text
14px    values / controls
16px    panel titles
20px    important metrics
28px    major state
```

Text should generally be:

```text
LEFT ALIGNED
MONOSPACED WHERE DATA MATTERS
UPPERCASE FOR SYSTEM STATES
```

---

## 08 — BOOT EXPERIENCE

Hardware Dog should boot. It should not display a spinner. I want an actual
initialization sequence.

```text
HARDWARE DOG DIAGNOSTIC SYSTEM
BUILD 0.1.0

INITIALIZING...

[ OK ] EVENT BUS
[ OK ] LOCAL STORAGE
[ OK ] HARDWARE INTERFACE
[ OK ] POWER MONITOR
[ OK ] USB SERVICE
[ OK ] SERIAL SERVICE
[ OK ] NETWORK SERVICE
[ OK ] TRACE ENGINE
[ OK ] DIAGNOSTIC RULES

DEVICE       HD-001
MODE         LOCAL
SESSION      READY

SYSTEM READY
```

The sequence can take approximately **800 ms – 2.0 s**.

I do not want a fake ten-second movie every time the application launches.
The purpose is atmosphere and immediate system feedback.

---

## 09 — STARTUP SOUND

Optional. Default can be disabled.

If enabled: one short low electronic beep.

No sci-fi orchestra. No fake modem noise. No startup jingle. It should sound
like equipment.

---

## 10 — SCREEN STRUCTURE

The application uses an instrument-panel layout.

```text
┌──────────────────────────────────────────────────────────────┐
│ HW DOG 0.1.0    DEVICE HD-001    SESSION 00:14:22     ONLINE │
├───────────────┬──────────────────────────────────────────────┤
│               │                                              │
│ STATUS        │                                              │
│ TRACE         │             ACTIVE WORKSPACE                 │
│ POWER         │                                              │
│ USB           │                                              │
│ SERIAL        │                                              │
│ BUS           │                                              │
│ NET           │                                              │
│ PROBE         │                                              │
│ REPORT        │                                              │
│ SETUP         │                                              │
│               │                                              │
├───────────────┴──────────────────────────────────────────────┤
│ F1 HELP   F2 TRACE   F3 PROBE   F4 REPORT        CTRL+K CMD  │
└──────────────────────────────────────────────────────────────┘
```

I want the structure to remain visually stable while the content changes.
The user should always know where they are.

---

## 11 — NAVIGATION

Main sections:

```text
STATUS  TRACE  POWER  USB  SERIAL  BUS  NET  PROBE  REPORT  SETUP
```

No hamburger menu on desktop. Hardware tools should expose their controls.

Keyboard navigation is a first-class feature. Possible shortcuts:

```text
F1          HELP
F2          TRACE
F3          PROBE
F4          REPORT

1           STATUS
2           TRACE
3           POWER
4           USB
5           SERIAL
6           BUS
7           NET

CTRL+K      COMMAND
CTRL+E      EXPORT
CTRL+L      CLEAR TRACE
SPACE       PAUSE TRACE
ESC         CLOSE / BACK
```

---

## 12 — STATUS SCREEN

The status screen answers one question: **What is happening right now?**

```text
┌ DEVICE ───────────────────┐
│ HD-001                    │
│ REV           A           │
│ FIRMWARE      0.1.2       │
│ UPTIME        00:42:18    │
│ STATE         ONLINE      │
└───────────────────────────┘

┌ POWER ────────────────────┐
│ VOLTAGE       5.04 V      │
│ CURRENT       312 mA      │
│ PEAK          742 mA      │
│ STATE         STABLE      │
└───────────────────────────┘

┌ USB ──────────────────────┐
│ DEVICE        CONNECTED   │
│ SPEED         480 Mbps    │
│ VID           303A        │
│ PID           1001        │
└───────────────────────────┘

┌ NETWORK ──────────────────┐
│ LINK          UP          │
│ DHCP          OK          │
│ DNS           OK          │
│ LATENCY       12 ms       │
└───────────────────────────┘
```

No giant pie charts. No arbitrary health percentage like
`SYSTEM HEALTH: 83%` unless that percentage has a defensible technical
definition.

---

## 13 — TRACE

Trace is the visual center of Hardware Dog. I want all system events on one
chronological timeline.

```text
12:42:01.002  SYS     session started
12:42:01.214  USB     device connected
12:42:01.228  POWER   5.07 V / 112 mA
12:42:01.781  USB     descriptor received
12:42:01.792  USB     VID 303A / PID 1001
12:42:02.006  POWER   current 691 mA
12:42:02.009  WARN    voltage drop
12:42:02.011  POWER   4.62 V
12:42:02.088  USB     device disconnected
```

This lets me correlate POWER, USB, NETWORK, SERIAL, BUS and FIRMWARE on the
same clock. That correlation is one of Hardware Dog's most important
features.

---

## 14 — TRACE VISUAL LANGUAGE

Each event uses:

```text
TIMESTAMP
SOURCE
SEVERITY
MESSAGE
OPTIONAL VALUE
```

Example categories:

```text
SYS  POWER  USB  UART  I2C  NET  GPIO  RULE  USER
```

Severity:

```text
INFO  PASS  WARN  FAIL
```

The source column should be visually aligned. Logs must remain readable even
when color is removed.

---

## 15 — POWER SCREEN

The power interface should feel like test equipment.

```text
POWER MONITOR

VOLTAGE
5.041 V

CURRENT
0.312 A

POWER
1.573 W

PEAK CURRENT
0.742 A

MIN VOLTAGE
4.618 V
```

Below it:

```text
5.20 ┤
5.10 ┤───────────────
5.00 ┤              ╲
4.90 ┤               ╲
4.80 ┤                ╲
4.70 ┤                 ╲__
4.60 ┤                    ╲_
     └────────────────────────────
```

Graphs should have:

- meaningful units
- timestamps
- clear scale
- no unnecessary smoothing
- no fake visual drama

---

## 16 — USB SCREEN

```text
USB DEVICE

STATE          CONNECTED
SPEED          HIGH SPEED
VID            303A
PID            1001
CLASS          CDC
POWER          BUS
CURRENT        312 mA

DESCRIPTORS

MANUFACTURER   Espressif
PRODUCT        USB JTAG/Serial
SERIAL         48:27:E2:...
```

Possible actions:

```text
[ ENUMERATE ]   [ WATCH ]   [ TRACE EVENTS ]   [ EXPORT DESCRIPTORS ]
```

---

## 17 — SERIAL SCREEN

Serial needs to feel like a real serial monitor.

```text
SERIAL / UART

PORT       UART0
BAUD       115200
DATA       8
PARITY     NONE
STOP       1

RX         182.2 KB
TX         42.8 KB
ERRORS     0
```

Live console:

```text
> bootloader 0.9
> loading config
> sensor init
> network ready
> _
```

Controls remain minimal.

---

## 18 — BUS SCREEN

Initially: **I2C**. Later: SPI, CAN, other bus modules.

```text
I2C BUS

SPEED       400 kHz
STATE       ACTIVE

FOUND DEVICES

0x3C        OLED DISPLAY
0x40        INA226
0x76        ENV SENSOR
```

Unknown devices remain:

```text
0x52        UNKNOWN
```

I do not want Hardware Dog confidently inventing identities.

---

## 19 — NETWORK SCREEN

Network should expose layers.

```text
NETWORK

LINK            1000 Mbps / FULL
ADDRESS         192.168.1.84
DHCP            PASS
GATEWAY         192.168.1.1     PASS
DNS             1.1.1.1         PASS
INTERNET        PASS
LATENCY         12 ms
PACKET LOSS     0.0%
```

This makes troubleshooting logical. Instead of `INTERNET BROKEN`, Hardware
Dog can show exactly how far communication works.

---

## 20 — PROBE

Probe contains active tests. The difference is important:

```text
SNIFF = PASSIVE
PROBE = ACTIVE
```

Before an active operation, the interface should clearly display what
Hardware Dog will do.

```text
PROBE / NETWORK

TARGET
192.168.1.1

TESTS

[X] PING
[X] DNS
[X] TCP CONNECT
[ ] HTTP REQUEST

[ RUN PROBE ]
```

No dangerous operations hidden behind generic buttons.

---

## 21 — REPORT

A report should look like engineering documentation.

```text
HARDWARE DOG
DIAGNOSTIC REPORT

SESSION         HD-20260930-1421
DEVICE          HD-001
DURATION        00:18:42

--------------------------------

POWER

AVG VOLTAGE       5.04 V
MIN VOLTAGE       4.61 V
AVG CURRENT       312 mA
PEAK CURRENT      742 mA

RESULT            WARNING

Voltage instability detected.

--------------------------------

USB

CONNECTIONS       6
DISCONNECTS       5

CORRELATION

4 / 5 disconnects occurred within
100 ms of a voltage drop below 4.75 V.

POSSIBLE CAUSE

POWER INSTABILITY
```

This is much more useful than an arbitrary AI summary.

---

## 22 — COMMAND PALETTE

Even though Hardware Dog has a graphical interface, I want a command layer.

```text
> sniff usb
> watch power
> probe net 192.168.1.1
> serial 115200
> trace pause
> report export
> session mark "device reboot"
```

This makes the application faster for experienced users. The graphical
interface and commands should control the same underlying system.

---

## 23 — GRAPHICS

Charts should borrow from:

```text
OSCILLOSCOPES
LOGIC ANALYZERS
TELEMETRY DISPLAYS
SERVICE SOFTWARE
```

Not financial dashboards.

Use: thin grids, sharp lines, ticks, unit labels, signal markers, event
annotations.

Avoid: giant filled areas, decorative gradients, rounded blobs, random
animated particles.

---

## 24 — ANIMATION

Animation must communicate a real state.

Allowed:

```text
cursor blink
live trace insertion
signal sweep
status pulse while scanning
boot initialization
graph movement
```

Not allowed:

```text
cards floating on hover
background particles
spring animations everywhere
decorative page transitions
```

Hardware Dog can move because the hardware is doing something.

---

## 25 — HARDWARE INDUSTRIAL DESIGN

The physical Hardware Dog should use the same language as the software.

```text
MATTE DARK ENCLOSURE
OFF-WHITE LABELS
CYAN SIGNAL DETAILS
PINK HARDWARE ACCENTS
VISIBLE FASTENERS
REAL PORT LABELS
```

Not a shiny consumer gadget.

Approximate form: **120 mm × 75 mm × 25 mm**.

The enclosure should feel comfortable sitting on a workbench, on a toolbox,
beside a laptop, inside a service bag.

---

## 26 — PHYSICAL FACE

```text
┌────────────────────────────┐
│        HARDWARE DOG        │
│                            │
│      ┌──────────────┐      │
│      │   DISPLAY    │      │
│      └──────────────┘      │
│                            │
│ USB ●    NET ●    BUS ●    │
│                            │
│ [A]       [B]       [OK]   │
└────────────────────────────┘
```

I would rather have three useful physical buttons than a miniature
touchscreen interface trying to reproduce the whole desktop UI.

---

## 27 — DISPLAY

The onboard display is not a tiny copy of the web application. Its purpose
is immediate field information.

```text
HW DOG
──────────────

USB    ONLINE
POWER  STABLE
NET    ONLINE
UART   ACTIVE

5.04V  312mA

TRACE  0142
```

Warnings replace the lower section when required:

```text
! POWER DROP

4.61 V
USB RESET

12:42:02
```

---

## 28 — HARDWARE COLOR PLACEMENT

I specifically want more pink on the physical unit than a typical engineering
product would use. Not because pink is decorative. Because Hardware Dog
should be identifiable from across the bench.

Possible pink elements:

```text
USB port surround
vent detail
button marker
silkscreen reference marks
internal PCB
rubber foot
small enclosure stripe
```

Cyan remains the live signal color. That combination gives Hardware Dog its
own visual identity.

---

## 29 — PCB DESIGN LANGUAGE

If the PCB is visible or photographed, it should also belong to the product.

```text
BOARD             BLACK PCB
SILKSCREEN        OFF-WHITE
ACCENT MARKINGS   PINK / CYAN
```

Labels should be clear:

```text
HD-REV-A
POWER SENSE
UART
I2C
USB HOST
USB DEVICE
```

The board itself becomes part of the portfolio.

---

## 30 — DOCUMENTATION STYLE

Public documentation must continue the same design language.

```text
HARDWARE DOG / POWER MONITOR

STATUS
------

[ OK ] INA226 detected
[ OK ] calibration loaded
[ OK ] sample stream active

DEFAULT RATE
------------

100 Hz
```

Architecture diagrams can deliberately use monospace where appropriate.

I want someone reading the repository to recognize Hardware Dog even without
seeing the logo.

---

## 31 — README OPENING

The public repository should open approximately like this:

```text
██╗  ██╗██╗    ██╗    ██████╗  ██████╗  ██████╗
██║  ██║██║    ██║    ██╔══██╗██╔═══██╗██╔════╝
███████║██║ █╗ ██║    ██║  ██║██║   ██║██║  ███╗
██╔══██║██║███╗██║    ██║  ██║██║   ██║██║   ██║
██║  ██║╚███╔███╔╝    ██████╔╝╚██████╔╝╚██████╔╝
╚═╝  ╚═╝ ╚══╝╚══╝     ╚═════╝  ╚═════╝  ╚═════╝

hardware companion
```

Then:

> Hardware Dog is my open-source hardware diagnostic companion.
> I am building it to observe power, USB, serial, embedded buses and network
> behavior on one synchronized timeline.
> I want one instrument that can help answer a very simple question:
> **What actually happened?**

That sets the tone immediately.

---

## 32 — RESPONSIVE DESIGN

Desktop is the primary interface.

Mobile exists because being able to inspect Hardware Dog from a phone at a
workbench is genuinely useful.

Mobile should prioritize:

```text
STATUS
TRACE
POWER
QUICK PROBES
```

It should not attempt to squeeze the entire desktop instrument panel into
390 pixels.

---

## 33 — ACCESSIBILITY

Old-school aesthetics do not justify bad usability. Therefore:

- color never carries meaning alone
- PASS / WARN / FAIL always include text
- focus states remain obvious
- keyboard navigation works
- contrast remains high
- charts include numerical values
- reduced-motion mode is supported

---

## 34 — DARK MODE

There is no conventional light/dark toggle in the initial design. Hardware
Dog is an instrument interface. The default environment is dark.

A high-contrast light theme may eventually exist for field use in direct
sunlight, but it should be treated as **FIELD MODE** rather than cosmetic
personalization.

---

## 35 — EMPTY STATES

Even empty states should sound like Hardware Dog.

Instead of `No data available.` use:

```text
NO SIGNAL
Waiting for device activity.
```

Instead of `Nothing here yet.` use:

```text
NO EVENTS RECORDED
Start a trace or connect a device.
```

The wording should be technical without pretending something dramatic
happened.

---

## 36 — ERROR LANGUAGE

Errors should tell me:

```text
WHAT FAILED
WHERE
WHEN
WHAT HARDWARE DOG KNOWS
```

Example:

```text
USB DEVICE LOST

Last seen:            12:42:02.088
Previous event:       POWER DROP / 4.61 V
Reconnect attempts:   3
```

Not `Oops! Something went wrong.`

There will never be an Oops screen in Hardware Dog.

---

## 37 — DESIGN PRINCIPLE: NO FAKE CERTAINTY

This is important. Hardware Dog must distinguish:

```text
OBSERVATION
CORRELATION
DIAGNOSIS
HYPOTHESIS
```

Example:

```text
OBSERVED
USB disconnected at 12:42:02.088

OBSERVED
Voltage dropped to 4.61 V at 12:42:02.011

CORRELATION
4 of 5 USB disconnects followed voltage drops.

POSSIBLE CAUSE
Power instability.
```

That is much more trustworthy than `AI FOUND THE PROBLEM!`

---

## 38 — DESIGN PRINCIPLE: LOCAL FIRST

Hardware Dog should visibly reinforce that the tool belongs to the user.

```text
MODE          LOCAL
CLOUD         DISABLED
DEVICE DATA   LOCAL ONLY
```

No login screen should stand between me and my own hardware. No account is
required for the core product.

---

## 39 — DESIGN PRINCIPLE: DENSITY IS NOT THE ENEMY

Modern UI often treats information density like a defect. For diagnostic
software, it can be useful.

I want dense screens when the information belongs together.

The goal is not minimal information. The goal is:

> **maximum relevant information with minimum confusion.**

---

## 40 — FINAL VISUAL TARGET

If Hardware Dog is shown without branding, I want someone to think:

> This looks like a real diagnostic instrument.

If the branding is visible, I want the second thought to be:

> And whoever built this clearly had fun doing it.

That balance is the identity.

```text
OLD-SCHOOL
BUT NOT RETRO FOR THE SAKE OF RETRO

TECHNICAL
BUT NOT HOSTILE

DENSE
BUT NOT CHAOTIC

PLAYFUL
BUT NOT A TOY

MODERN INTERNALLY
INDUSTRIAL EXTERNALLY
```

```text
HARDWARE DOG
hardware companion
SNIFF THE PROBLEM.
```
