# HARDWARE TEST CAMPAIGN · BLUETOOTH LAB, CAMERA SNIFFER

A short campaign on real hardware, run before any new feature. What has
been tested so far is listed in [`CAMERA_SNIFFER.md`](CAMERA_SNIFFER.md)
(VERIFICATION STATUS): unit tests, and an integration test with real
sockets, a real dogd and **simulated** devices, the interface driven in
Chromium (and Chromium **emulating** an iPhone, which is not Safari).

```text
WHAT A PASS MEANS   the devices, systems and browsers written in the results
                    work as expected. Not every model, not every network.
WHAT IT NEVER MEANS a room without a camera. A model reported on the network
                    is not a confirmed hidden camera, and no scan says a place
                    is safe.
```

---

## SETUP

```text
COMPUTER     Linux with BlueZ (bluetoothd running), dogd built from the branch
             under test: cargo build --release; ./target/release/dogd serve
BROWSERS     Chrome or Edge on the computer; Safari on a PHYSICAL iPhone;
             Chrome on a physical Android phone if available
NETWORK      the home network (private, /24 or smaller); its router's list of
             DHCP clients, as the inventory to compare with
DEVICES      one Bluetooth LE device you own (tracker, watch, sensor); a USB
             Bluetooth dongle if possible (it can be unplugged); an IP camera
             you own, if any (write its model and firmware)
RECORD       REC LAB SESSION on for every case: the .hdlab is the evidence
```

**Fictitious personal data for the export cases (C).** Use only these,
never real ones:

```text
place              Appartement 4B, 12 rue Fictive, Testville
room label         Chambre de Camille Testeur
device label       caméra de Camille 192.168.77.77 / 02:00:5e:10:20:30
verification note  objectif vu derrière la grille, 192.168.77.78, Camille
object seen        ouverture à gauche, notée par Camille Testeur
next check         demander à Dominique Exemple
```

---

## A · NETWORK DISCOVERY (dogd)

```text
A1  networks listed       NETWORK, DOGD (THIS COMPUTER). Expected: the home
                          network allowed; loopback, a public network, anything
                          wider than a /16 refused, each with its reason.
A2  full scan             All five methods. Expected: DONE; compare the rows
                          with the router's DHCP list. Write down every device
                          seen and every device MISSING (a missing one is a
                          limit, not a failure, unless it answers mDNS/SSDP).
A3  a real camera         (if owned) Expected: VIDEO COMPATIBLE or MODEL
                          REPORTED BY THE DEVICE, with reasons pointing at
                          their answers; "Not established" shown; never
                          CONFIRMED until a verification is written.
A4  STOP while starting   SCAN, then STOP within one second. Expected:
                          CANCELLED; the timeline count stays the same for
                          10 s; on the computer `ss -tn` shows no connection
                          left to the hosts.
A5  STOP during services  Stop when the progress shows checks. Expected: the
                          same as A4; the progress no longer moves.
A6  double click          Double-click SCAN. Expected: one scan, no error,
                          not cancelled. Double-click STOP: no new scan.
A7  dogd restarted        Stop dogd during a scan. Expected: DOGD_LOST after a
                          few seconds, observations kept. Start dogd, scan
                          again: the new observations appear (none dropped
                          as repeats).
```

## B · BLUETOOTH

```text
B1  dogd scan             SCAN WITH DOGD near your BLE device. Expected: its
                          rows, RSSI moving; STOP SCAN stops the rows.
B2  STOP while starting   SCAN WITH DOGD then STOP SCAN at once. Expected:
                          STOPPED, no new rows for 10 s, `bluetoothctl show`
                          says Discovering: no.
B3  adapter gone          During a scan: unplug the dongle, or
                          `bluetoothctl power off`. Expected within about 2 s:
                          an error that says the adapter was powered off or
                          disappeared; never SCANNING with no rows.
B4  adapter back          Plug it back / power on, SCAN WITH DOGD. Expected:
                          scanning again, without restarting dogd.
B5  GATT (Chrome)         PICK A DEVICE, connect, read one characteristic.
                          Switch the device off. Expected: "the device
                          disconnected" in the history; nothing resent. Reconnect by
                          a click. PICK A DEVICE then cancel: the device in use
                          stays.
B6  Safari, iPhone        Expected: browser scan and GATT shown unavailable,
                          with the reason; DEMO SCAN works.
```

## C · MASKED EXPORT

```text
C1  enter the data        The fictitious data above: place, a room with its
                          label, an object with what was seen and the next
                          check, a scanned device marked known with the label,
                          a documented verification.
C2  masked + hidden       REPORT, both boxes ticked, EXPORT .MD. Search the
                          file for every fictitious string, every IP and MAC
                          of A2 (the timeline lists them), every announced
                          name. Expected: none found.
C3  masked only           Only "Mask network identifiers". Expected: no IP,
                          MAC or announced name; the typed IPs and MAC masked
                          inside the notes too; the notes otherwise readable.
C4  control               Both boxes off. Expected: the values are there (the
                          search of C2 would have found them).
```

## D · PHONES (physical)

```text
D1  layout                Safari iPhone, Chrome Android: every view of Camera
                          Sniffer and Bluetooth Lab, no side-scroll.
D2  posters               Arrows, swipe, full screen on tap, ZOOM, close.
D3  photo                 OBJECTS: PHOTO, allow the camera; TORCH and ZOOM
                          only if offered; take a photo, mark it, reload the
                          page: the photo and its marks are still there.
```

---

## RESULTS

One row per case and per device or browser. Keep the .hdlab and the
exported reports with the results.

```text
CASE  DATE        SYSTEM / BROWSER / DEVICE (model, firmware)   RESULT  NOTE
A1
A2
...
```

A failure is filed with its case, its .hdlab and what was expected. A
case not run is written NOT RUN, with why.
