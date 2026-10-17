# HARDWARE DOG / FLIPPER LAB

```text
WHAT      a permanent section for the Flipper Zero, and the companion TV
WHERE     web/src/core/flipper, web/src/core/lab, web/src/ui/lab
NEEDS     nothing: Hardware Dog works without a Flipper. A real one needs a
          Chromium-based browser (Web Serial) on a computer, over USB
STATUS    see VERIFICATION below: nothing here has met a real Flipper yet
```

The Flipper Zero is an optional instrument. Flipper Lab reads what it
reports, browses its storage, copies captures to this computer on request,
reads them (IR, Sub-GHz, NFC, RFID, iButton), compares them, reads its GPIO
pins, and puts every operation on the same lab timeline as the Bluetooth
Lab and your markers ([`BLUETOOTH_LAB.md`](BLUETOOTH_LAB.md)).

---

## THE LINK

```text
USB CDC (VID 0483, PID 5740) ── text CLI ">: "
        │  "start_rpc_session\r"
        ▼
PB.Main messages, length-delimited (varint), both ways
```

`web/src/core/flipper/serial.ts` opens the port the operator picked in the
browser chooser, waits for the CLI prompt, switches it to RPC and skips the
echoed line. `client.ts` sends one command at a time with its own id,
collects streamed answers (`has_next`), times out on silence, can be
cancelled, and drains late answers to a command it gave up on so they are
never taken for the next one. `proto.ts` is a minimal protobuf codec: every
read is bounded, a malformed frame ends the session and says why.

Only one session exists for the whole interface (`FlipperService`): a
second CONNECT while connected starts nothing, the floating TV and a
detached window read the same object, nothing opens a second link.

### What is driven, and what is not

```text
DRIVEN       system device info, protobuf version, storage info
             storage list, stat, read            (read-only, always)
             storage write, mkdir, rename, delete  WRITE MODE only:
                                                   an existing file is never
                                                   replaced unless the operator
                                                   confirmed it; a delete is
                                                   confirmed, a recursive
                                                   delete confirmed twice;
                                                   storage roots refused
             GPIO pin mode and level             read only, never set
VIA AN APP   UART: the Flipper's USB-UART Bridge app makes it a serial
             adapter; Hardware Dog reads it in SERIAL, no RPC involved
NOT DRIVEN   IR / Sub-GHz transmit, NFC / RFID emulation, app control,
             screen streaming: captures are inspected, never replayed
NEVER        firmware update, reboot, factory reset: Hardware Dog never
             changes a device's firmware (those messages are not even
             encoded)
```

A function on the Flipper's own screen is not necessarily reachable from a
computer. What the RPC exposes differs between firmwares (official and
forks): an unknown answer is kept as `unknown` and never acted on; an
unimplemented command comes back with the device's own
`ERROR_NOT_IMPLEMENTED`.

Paths are checked before anything is sent (`checkFlipperPath`): under
`/ext`, `/int` or `/any`, no `.` or `..` segment, no control character, no
backslash, 255 characters at most. Local downloads get a sanitized name.

### Errors keep their names

The device's `PB.CommandStatus` names are shown unchanged
(`ERROR_STORAGE_NOT_EXIST`, `ERROR_BUSY`...). Codes Hardware Dog produces
itself are `HD_*` (`HD_COLLISION`, `HD_BAD_PATH`, `HD_TOO_LARGE`),
`TIMEOUT`, `ABORTED`, `LINK_LOST`; browser errors keep their DOMException
name (`NotFoundError`, `SecurityError`, `NetworkError`).

---

## CAPTURES

`formats.ts` reads the Flipper File Format (`Key: value` lines) of `.ir`,
`.sub`, `.nfc`, `.rfid`, `.ibtn`. What a file says is kept apart from what
it is:

```text
DECODED    the Flipper decoded a protocol and saved its parameters (an IR
           "parsed" signal, a Sub-GHz key file, NFC pages): there is no
           waveform in the file, and none is drawn
MEASURED   raw timings the Flipper's receiver recorded (IR "raw", Sub-GHz
           RAW): drawn to scale as recorded, nothing interpolated
```

Parsers are bounded (2 MiB, 100 000 lines, 500 000 timings) and refuse a
malformed line with its number. A file that is not a known format is shown
as bytes.

The LIBRARY keeps copies made on explicit request, in this browser
(IndexedDB `hwdog-lab/library`): source path, device name, real or demo,
time, SHA-256, notes, tags. The same bytes from the same path are kept
once. Search is stable (`tag:x`, `kind:x`, words). COMPARE shows field by
field what differs between two captures of the same kind, and refuses two
kinds.

---

## THE COMPANION TV

A small Japanese-style portable TV, seen from the front. The box is a
realistic picture; the pixel art lives inside the screen.

```text
1  SCREEN CONTENT   a 136 x 100 canvas, scaled without smoothing, or text
                    (TOOL and EVENT views, messages)
2  CRT EFFECTS      scanlines, glow, vignette, inside the opening only
3  FRAME            the TV picture: opaque body, transparent opening and
                    outside
4  CONTROLS         real buttons over POWER and the dial, a drag zone on
                    the handle
```

### The asset and its profile

`assets/brand/source/hd-tv-orange-frame.png` is the untouched original.
`web/scripts/build-brand-assets.mjs` (`npm run assets`) snaps its alpha
(noise out, body fully opaque), zeroes the color of transparent pixels (the
red fringe cannot come back through resampling), traces the screen opening
from a point inside it (72 rays, pushed 6 source pixels under the bezel so
no seam shows), and writes:

```text
assets/brand/web/hd-tv-orange-560.webp       1x
assets/brand/web/hd-tv-orange-1120.webp      2x
assets/brand/web/hd-tv-orange.profile.json   the mapping profile
```

No color is keyed out: the black bezel and the black controls stay as
drawn. The profile holds the reference size and ratio, the opening (box +
polygon), POWER, the dial and its knob, the handle, the speaker and the
logo, all normalized to 0..1 of the picture, so alignment holds at every
size (`web/test/tv-profile.test.ts` checks the zones, the transparency of
the derivatives, and the mapping at five sizes). ZONES (or `?tvdev`) shows
the mapped zones over the TV.

A new TV picture is a new source, new numbers in `TV_REGIONS`, `npm run
assets`: no component change. A Hardware Dog TV with the dog is a new skin
(`tvSkin.ts`) and a new `SpriteSet` (`sprites.ts`); the engine stays.

### Power

POWER plays about two seconds inside the screen: a dot, a horizontal line,
the picture opening vertically, analog snow, the FLIPPER LAB splash, the
companion's room coming in, a hop and a wave, then its life goes on. Off: the picture squeezes
to a line, then a dot, then dark. The box never moves.

POWER switches the TV only: it never touches the Flipper, never stops a
capture. A click during a transition never makes the CRT jump: the
sequence finishes, then the last click decides. Reduced motion (the system
setting or the interface's) replaces the sequence with a short fade. Sound
is optional and off by default. Drawing is a function of the companion's
state and the monotonic clock, so moving the TV between sections or into a
window resumes it, never restarts it. The canvas loop runs only while the
TV is on (or switching) and visible.

### Three states, kept apart

```text
TV          OFF, BOOTING, ON, SHUTTING_DOWN
HARDWARE    UNKNOWN, ABSENT, CONNECTING, CONNECTED, DISCONNECTED
OPERATION   IDLE, SEARCH, READ, TRANSFER, SUCCESS, WARNING, ERROR
```

`web/src/core/lab/companion.ts` derives them from the lab bus
(`web/src/core/lab/events.ts`): every tool event carries its source and
tool, an operation id, type, time (wall and monotonic), severity, message,
parameters, a progress (a total only when the device gave one: no
percentage is ever invented), the exact error code, and the actions it
offers. The companion observes; it never runs a tool. Animations follow
the events: an operation that fails stops its working animation at once, a
link that drops ends every operation of that link on screen.

The companion is a little cartoon dolphin seen from the chest up at its
desk, in a cozy lab, in full color; its gestures tell what the tool is
doing (`sprites.ts`, after the owner's sketch sheet):

```text
IDLE        link up, nothing running: headphones on, it codes, nodding
WAIT        nothing connected: asleep on the desk under the lamp (Z z)
GREET       after power-on: it turns to us and waves
SEARCH      analysing: a hand on the radio scanner's knob, the spectrum moving
CONNECT     pushes the cable into the Flipper's port (the screen lights up)
READ        leans over a board with a magnifier up to its eye
TRANSFER    at the keyboard, blocks travel from one computer to the other
SUCCESS     both arms up, eyes shut with joy, a check on the screen
WARNING     the screen blinks "!", it scratches its head, worried
ERROR       arms crossed, cross brows, the rain outside
DISCONNECT  a cable end in each flipper, it looks from one to the other
```

One profile (a wide melon sloping into a thick beak, a big eye, a cream
throat, flippers it uses as hands) built from shapes plus an outline
pass, so every pose stays in one style. Scenes are pure functions of
time; replacing them is replacing a SpriteSet. Reduced motion holds each
scene still on a representative moment.

### Messages

Local rules (`rules.ts`, English and French, from the browser language)
turn exact codes and states into one short suggestion, e.g. *Connexion
interrompue. Vérifie le câble USB.* with RETRY and DETAILS. The code is
shown when there is one, never made up. Errors beat warnings beat
successes beat tips; the same message within 10 s is counted, not
repeated; a message stays readable at least 2.5 s; errors stay until read
or until the fact no longer holds (a link that came back). Every error is
also in the tool and in the operation log. Actions run through the command
registry (`registry.ts`): a command already running is not started again.

### The dial and where the TV lives

The dial changes the view: COMPANION, TOOL STATE, LAST EVENT. It never
starts anything on a device. Click, arrow keys or the mouse wheel turn it;
the knob turns with the view.

```text
DOCKED     its place in Flipper Lab
FLOATING   drag it by the handle: it follows every section; minimize, dock
           back, size; its place is remembered in this browser and kept
           inside the window. POWER and the dial never start a drag
DETACHED   its own always-on-top window, where the browser offers Document
           Picture-in-Picture (Chromium 116+ desktop). Same page, same
           companion, same Flipper session: never a second connection.
           Elsewhere the button says it is not offered, and FLOATING is the
           way
```

---

## LAB SESSIONS (.hdlab)

One timeline for every lab tool, recorded whether or not any lab screen or
the TV is showing (`web/src/core/lab/session.ts`, `manager.ts`):

```text
header   {"format":"hdlab","version":1, id, name, startedAt, startMono, app, clock}
events   one lab event per line, in the order this computer received them
footer   {"end":true, endedAt, endMono, events, lost, sha256}
```

The seal is the SHA-256 of every line before the footer. Reopened, a file
is VERIFIED, MODIFIED (bytes changed) or UNSEALED (never stopped). A
session keeps 50 000 events; what comes after is counted as lost and said
in the footer and the report. Durations come from the monotonic clock;
events of two devices are ordered by reception on this computer: their own
clocks are not synchronized, and nothing claims they are.

Markers and notes (button pressed, cable plugged...) go on the lab
timeline, and on the live hardware timeline too when a Hardware Dog
session is running. A reopened session is read-only: filters, before /
after a marker, two sessions side by side, proximity in time (±2 s) listed
as proximity, never as a cause; the report points to the events it rests
on (`#seq`). Replay is a visualization: nothing in it is ever sent to a
device again.

---

## SOURCES AND LICENSES

```text
Flipper Zero RPC   flipperdevices/flipperzero-protobuf, branch dev,
                   commit 1c84fa48919cbb71d1cc65236fc0ee36740e24c6
                   (flipper.proto, system.proto, storage.proto, gpio.proto,
                   property.proto). The repository carries no license file:
                   no code or file was copied. Only the message field
                   numbers and CommandStatus values, which are the device's
                   public interface, are written in web/src/core/flipper/rpc.ts.
File formats       flipperdevices/flipperzero-firmware, branch dev,
                   commit 3fb1d51727733d2007abc5ec636a89328857803e,
                   documentation/file_formats (InfraredFileFormats,
                   SubGhzFileFormats, NfcFileFormats, LfRfidFileFormat,
                   iButtonFileFormat). Parsers written from the
                   documentation; no firmware code (GPL-3.0) was copied.
CLI switch         "start_rpc_session" and the ">: " prompt: the firmware's
                   public CLI behavior.
Demo files         written by Hardware Dog for DEMO MODE, labeled as such
                   inside each file; not captures.
```

No Flipper service or app is needed to use Flipper Lab, and none is called.

---

## VERIFICATION

```text
VERIFIED ON REAL HARDWARE     nothing yet: no Flipper was available
TESTED IN SIMULATION          the RPC client against the demo device, byte
(web/test/flipper.test.ts,    for byte: info, list (streamed), read (multi-
 companion.test.ts,           frame), write (multi-part), collisions, device
 tv-profile.test.ts)          error codes, timeout and late-answer drain,
                              cable pulled mid-transfer, one connection when
                              asked twice; parsers and comparisons; library;
                              the companion's states, power sequence, clicks
                              during transitions, messages; the TV profile
IMPLEMENTED, NOT VERIFIED     Web Serial switch to RPC on a real Flipper
ON HARDWARE                   (prompt, echo, timing), firmware differences,
                              GPIO reads on a real board, Document
                              Picture-in-Picture window on a real desktop
BLOCKED BY A MISSING          a Flipper Zero (and its firmware version) on
CAPABILITY                    this bench
```
