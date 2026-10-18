# HARDWARE DOG / THE COMPANION

```text
WHAT      one companion TV for the whole interface: Hardware Dog's robot dog
          in a turquoise TV, Flipper Lab's companion in the orange one
WHERE     web/src/core/lab (companion.ts, device.ts, rules.ts, registry.ts),
          web/src/ui/lab (RetroTv.tsx, TvHost.tsx, dogSprites.ts, sprites.ts)
NEEDS     nothing: it watches what the tools say, it runs none of them
STATUS    see VERIFICATION below: emulation only, no real board yet
```

A small CRT TV lives in the corner of the interface. The box is a real
picture; inside, a pixel scene: the robot dog of the owner's sheet in its
workshop, doing what the tools are really doing. It explains an error in
one short line, offers the next useful step, and never pretends.

---

## TWO PROFILES, ONE COMPANION

```text
PROFILE    TV                             WHO                        WHERE
hwdog      hd-tv-turquoise (turquoise,    the robot dog: cream       every section but
           off-white, grey)               panels, dark joints, cyan  Flipper Lab
                                          eyes, USB tag on its collar
flipper    hd-tv-orange                   Flipper Lab's companion    Flipper Lab
```

There is one `Companion` (`web/src/core/lab/companion.ts`) and one TV on
screen. Opening a section sets its **focus**: the section (its decor),
the source that comes first, the profile. Nothing else changes: no link
reconnects, no operation is lost, the CRT does not boot again. The TV
picture and the scenes follow the profile (`skinFor`, `DOG` /
`COMPANION`).

The companion **observes**: it never owns a connection, never sends a
command. The Flipper session, the BLE scanner, Camera Sniffer and the
Hardware Dog session are the tools'; the TV only reads the lab bus.

---

## WHAT IT KEEPS APART

```text
TV          OFF  BOOTING  ON  SHUTTING_DOWN            the TV itself (POWER)
FOCUS       section, source, profile, unavailable      what the person looks at
HARDWARE    UNKNOWN ABSENT CONNECTING CONNECTED        the focused source's link
            DISCONNECTED
OPERATION   IDLE SEARCH READ TRANSFER SUCCESS          what the tools do
            WARNING ERROR CANCELLED UNAVAILABLE
SCENE       what the screen plays and says             derived, never set
```

POWER switches the TV only: never a connection, a scan, a recording. A
click during a transition never makes the CRT jump: the sequence ends,
then the last click decides.

---

## EVENTS (the lab bus, web/src/core/lab/events.ts)

Every tool says what happens; the companion derives the rest.

```text
link.state    params.state = UNKNOWN ABSENT CONNECTING CONNECTED DISCONNECTED;
              params.reason = lost (pulled out) or closed (asked)
op.start      op id, source, tool, params.kind = connect search read transfer
              write; params.wait = user while it waits for the person
op.progress   done / total (null total: indeterminate, never a percentage);
              params.wait = user | null
op.end        severity PASS WARN FAIL; code exactly as given; params.outcome =
              cancelled (the person cancelled: not an error) or stopped
              (stopped on request: not a success)
observe       bursts (BLE advertisements): sampled, at most 4 a second
```

Sources: `FLIPPER`, `BLE`, `CAMERA`, `USER`, `LAB`, and `DEVICE`, the
Hardware Dog session itself (`web/src/core/lab/device.ts`): the app says
its link (no device, connecting, connected, lost) once per change, the
port chooser as an operation that waits for the person, dogd reached or
not (`DOGD_UNREACHABLE`), and what runs until stopped (the network
checks, the I2C watch, a replay) as one operation from on to off. No
progress is invented: none is said.

### Priorities

```text
THE TOOL LOOKED AT   its operations first, its results on screen (success,
                     warning, error, cancel)
ELSEWHERE            a failure in another tool: a message with OPEN THE TOOL,
                     the screen stays on what is looked at
SCENES               a scene stays at least 0.9 s: a burst of events never
                     makes the screen flicker
LATE ANSWERS         the end of an operation a newer one of the same tool
                     replaced, an end said twice: nothing on screen, the log
                     keeps it
TIME                 no success from a delay: an operation is done when its
                     tool says so
```

### Scenes

A section opened is a **decor**: the workshop monitor shows its sign
(trident for USB, a prompt for SERIAL, the Bluetooth rune, a globe for
NET...). An operation really started is an **activity**. Opening
Bluetooth is not a scan.

```text
STATE                         DOG SCENE (sheet)       WHAT MOVES
rest (no link / link idle)    the workshop (hero)     breath, blink, ear; the
                                                      section's sign on the monitor
rest, calm                    + a value on the        NO COOKIES. NO LEASH. LOCAL
                              monitor, the nap (01)   ONLY... only when nothing runs
                                                      and nothing serious is said
connect: USB port             USB (02)                the ! marks, a spark at the plug
connect / read: serial        SERIAL (03)             the terminal typed
search: BLE                   BLUETOOTH (04)          waves leave the antenna
search: network, dogd         NETWORK (05)            router LEDs, packets on the cable
read: Camera Sniffer object   CAMERA SNIFFER (06)     a glint on the magnifier
read: inspection, compare     ANALYZING (07)          the chart's bars (no number)
read: I2C watch               the workshop            a board on the monitor
read: power                   the workshop            a meter's needle (no value)
read: replay                  REPLAY (11)             the play sign, the roll bar
transfer: export, report      EXPORT (12)             the box's arrow
success                       SUCCESS (08)            once, then rest
error                         ERROR (09)              once, then rest; the message stays
link lost                     DISCONNECTED (10)       then rest
waiting for the person        the workshop            a padlock on the monitor
cancelled                     the workshop            the tool put down, then rest
not offered here              the workshop            N/A on the monitor, nothing moves
power off                     the nap (01)
```

Scenes are a SpriteSet, replaceable without touching the engine:
`web/src/ui/lab/dogSprites.ts` (the dog), `sprites.ts` (Flipper Lab).
Reduced motion holds each scene on one frame, no value, no nap.

---

## MESSAGES AND ACTIONS

Local rules (`web/src/core/lab/rules.ts`), English and French from the
browser's language, from explicit states and exact codes. No remote AI,
no account, no telemetry. Examples: *Appareil connecté.* *Scan en
cours…* *Adaptateur Bluetooth déconnecté.* *Permission nécessaire pour
continuer.* *Export terminé.* The code is shown as given (`BLE_NO_ADAPTER`,
`ERROR_STORAGE_NOT_EXIST`, `NotFoundError`), never made up.

Actions run through the command registry (`registry.ts`) by id:

```text
lab.log         DETAILS: the log of the tool the message is about
lab.open        OPEN THE TOOL: the section of a source
device.connect  RETRY: the USB port chooser (Web Serial present, checked at the click)
device.dogd     RETRY: reach dogd again
flipper.connect RETRY: the Flipper
ble.start       the Bluetooth Lab scan screen
```

A command already running is not started twice (double click, two
windows). Its precondition is checked again at the click, not when the
message was written. Nothing retries on its own. The confirmations a
tool asks for stay the tool's. RETRY is offered only where retrying the
same thing makes sense (a timeout, a busy port, dogd not reached), never
for a file that cannot be read.

DEMO and REPLAY are on the screen when the focused tool shows simulated or
recorded data. A replayed event offers no action that would reach a
device: DETAILS only.

In Camera Sniffer the companion says what was observed, never more: a
model announced or a device discovered is never "a hidden camera
confirmed", and a scan with no clue does not prove there is no camera.

---

## WHERE THE TV LIVES (web/src/ui/lab/TvHost.tsx)

```text
DOCKED     its place in a page that has one: the home, Flipper Lab, Camera
           Sniffer. Elsewhere a small TV tab (a tap brings it floating). "–"
           reduces it to a one-line bar in its place
FLOATING   it follows every section; dragged by its body or its handle
           (mouse, pen, finger), sized, kept inside the window and above the
           bottom menu after a rotation or a resize; on a phone a small TV
           that snaps to a side, hidden while the MORE menu is open
DETACHED   its own window where the browser offers Document Picture-in-
           Picture (Chromium desktop): same page, same companion, same
           sessions, no second connection. Elsewhere the button says it is
           not offered; closing the window brings it back
```

Place, size, POWER and SOUND are kept in this browser (`hwdog.tv`).
Sound is off by default. One TV is visible at a time: while What's New
shows it, the page's place stays empty.

---

## ASSETS

```text
assets/brand/source/hd-tv-turquoise-frame.png   the turquoise TV, alpha cut-out, untouched
assets/brand/source/hd-companion-dog-sheet.png  the owner's sheet: the dog, 12 scenes
assets/brand/web/hd-tv-turquoise-560|1120.webp  the frame, alpha snapped, color of the
                                                transparent pixels zeroed (npm run assets)
assets/brand/web/hd-tv-turquoise.profile.json   screen opening (traced, 72 rays), POWER,
                                                dial and knob, handle, speaker, logo
assets/brand/web/hd-dog-scenes.webp|json        13 scenes x 4 frames, 136 x 100
                                                (npm run companion)
```

No color is keyed out of the TV: the opening and the outside are the
picture's own alpha, snapped; the turquoise shell and the black details
stay (`web/test/tv-profile.test.ts` checks both TVs, five sizes, and the
shell's color). ZONES (or `?tvdev`) draws the mapped zones over the TV.

The sheet is a reference, not a spritesheet: each scene is cut through
one window of the same size (the dog keeps its size from scene to
scene), fitted to the screen's width; the room continues above (its own
wall, darker toward the ceiling) and the floor below (its own mat, its
grid continued). From each drawing the script makes the breath (head and
back one pixel lower: the dog is found by its cream panels, its joints
and its visor), the blink (the cyan eyes shut to a line, where they are
open) and the ear twitch (the pink inside of the ear one pixel up).

---

## VERIFICATION

```text
TESTED (web/test/companion-global.test.ts, companion.test.ts,
        dog-scenes.test.ts, tv-profile.test.ts, tv-placement.test.ts)
            section changes during an operation, dog/Flipper switch without
            reconnection, POWER during a scan, concurrent operations and
            late answers, permission, cancel, unavailable, repeated RETRY,
            preconditions at the click, demo and replay without an action
            reaching a device, the turquoise profile at six sizes
SEEN IN CHROMIUM (emulation, not a phone)
            1440 px and 390 px (Chromium's iPhone 13 emulation): the home with
            the TV, floating TV across BLE (demo scan), Flipper Lab (orange
            TV, no new boot), Camera Sniffer; TOOL and EVENT views; POWER off
            and on during the scan, the scan kept; no side scroll; the MORE
            menu never under the TV
NOT VERIFIED
            Safari and physical phones; Document Picture-in-Picture on a real
            desktop; a real board, a real Flipper, a real adapter pulled out
            mid-scan; the tail does not move yet (the drawings give no clean
            tail to animate)
```
