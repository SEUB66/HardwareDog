# HARDWARE DOG / BLUETOOTH LAB

```text
WHAT      Hardware Dog's own BLE scanner, inspector and GATT explorer
WHERE     web/src/core/ble, web/src/ui/lab/BluetoothLab.tsx, dogd/src/ble
NEEDS     no nRF Connect, no Flipper, no account, no network
STATUS    see VERIFICATION below
```

A web page alone cannot scan everything around it. Bluetooth Lab uses what
this computer really offers, checks it live, and says which of four things
stops it:

```text
UNSUPPORTED          the API does not exist here (browser, OS, flag)
PERMISSION_MISSING   it exists; access was refused or not granted yet
NO_ADAPTER           it exists; no adapter (absent, off, blocked by the OS)
TEMPORARY_ERROR      it should work; it failed now: retry
```

## SOURCES

```text
DOGD             BlueZ discovery through the local daemon (Linux): every
                 advertiser, with its address and address type. The default
                 scanner where it runs. (dogd/src/ble, docs/DOGD.md)
WEB BLUETOOTH    requestLEScan where the browser has it (experimental, behind
                 chrome://flags "Experimental Web Platform features"); GATT
                 on one device picked in the chooser
DEMO             simulated advertisers, labeled DEMO everywhere (company
                 0xFFFF is the Bluetooth SIG id reserved for tests)
REPLAY           a reopened lab session (read-only)
```

Documented support, shown under the live check (the live check is what
counts on a given machine):

```text
SYSTEM            WEB BLUETOOTH GATT       WEB BLUETOOTH SCAN   DOGD SCAN
Linux             behind a flag, partial   behind a flag        yes (BlueZ)
Windows 10/11     Chromium browsers        behind a flag        not yet
macOS             Chromium browsers        behind a flag        not yet
Android           Chrome                   behind a flag        no dogd
ChromeOS          Chrome                   behind a flag        no dogd
iOS / iPadOS      no                       no                   no dogd
Firefox, Safari   no                       no                   any browser
```

## WHAT IS SHOWN, AND WHAT IT IS NOT

```text
NAMES        advertised name and system name, apart. A name proves no model
ID           as observed, with its kind: a Web Bluetooth id (random, per
             site and browser, not the radio address), a BlueZ address, a
             demo id. Two ids are never merged: a changing random address
             is a new row, on purpose
ADDRESS      only when the API gives it, with its type (public, random)
RSSI         dBm as reported: a radio level, never a distance
PRESENCE     estimated from the last time seen (10 s, 60 s), labeled so
CONNECTABLE  only when the API says; else "not reported"
SERVICES     what the device advertises: not a GATT exploration
PAYLOADS     manufacturer and service data, bytes as reported, next to the
             decoded fields with the decoder's id and version
```

These are what the operating system's Bluetooth API reports about
advertisements, not a radio capture: no channel, no packet timing, no raw
PDU.

SCAN: start / stop, PAUSE VIEW (the screen holds still, capture
continues), filters (text, minimum RSSI, named, connectable), stable sort,
up to six devices on the RSSI chart, counters (ids, observations, rate,
reports lost by the source, rows refused when the table is full). INSPECT:
one id, every field with its provenance, hex / ASCII / byte index, the
bytes that changed since the payload before marked ▲ (and named in each
byte's title, never by color alone).

### Decoders

```text
apple.ibeacon v1        company 0x004C, type 0x02, length 0x15
google.eddystone v1     service data 0xFEAA: UID, URL (shown as text, never
                        visited), TLM
bt.battery-level v1     service data 0x180F
```

A payload no decoder claims stays raw. Names of companies, services,
characteristics and descriptors come from the bundled dictionary, loaded
from the interface's own files.

## GATT

After an explicit connection to one device picked in the browser chooser:
services, characteristics with their properties, descriptors, reads,
notifications and indications, writes, on a timestamped history.

```text
REACH       only services listed before the chooser opens are reachable (a
            Web Bluetooth rule): every SIG service in the dictionary plus
            the UUIDs the operator adds. The browser hides some services
            (its blocklist). What is shown is what the API allowed
WRITES      the bytes are previewed, in the format chosen; the mode is one
            the characteristic declares (with response, without response);
            the operator confirms. "Accepted" says the API took it (with
            response: the device acknowledged); it does not prove the
            device acted. Sent once
NUMBERS     u8 s8 u16 s16 u32 s32 f32, with the byte order in the name
            (u16le, u16be...), hex, UTF-8; a tail too short is said. A
            value out of range is refused, never sent as Infinity or 0; an
            f32 preview shows the number the device will read
LOST LINK   said; nothing is resent on its own, and no notification handler
            outlives the link. A reconnect is a click, and no earlier write
            is replayed
```

dogd does not connect to devices: GATT is Web Bluetooth only.

## SESSIONS

BLE observations go to the lab session sampled: a device's observation is
written when its payload changed, or at most once a second; the ones in
between are counted (`params.repeats`). The screen sees every one. A
reopened session rebuilds the devices, their payloads (and the payload
before the last change), and their RSSI at that sampling, read-only
(`web/test/ble.test.ts`). A hand-edited file cannot stop a replay halfway:
a payload pair without `=` or with odd hex is left out, a measure that is
not a number is no measure, and an event that cannot be read is counted
(`N UNREADABLE`). The lab session format: [`FLIPPER_LAB.md`](FLIPPER_LAB.md).

## SOURCES AND LICENSES

```text
Bluetooth numbers   NordicSemiconductor/bluetooth-numbers-database,
                    commit d379cc06c9c3681bc1c1cd4d61c246a0b0f80b0e, v1/
                    (company_ids, service_uuids, characteristic_uuids,
                    descriptor_uuids), BSD-3-Clause, Copyright (c) 2019 -
                    2020, Nordic Semiconductor ASA. Bundled as
                    web/src/core/ble/data/numbers.json with its license
                    (web/src/core/ble/data/NORDIC-LICENSE.txt), rebuilt by
                    web/scripts/build-ble-numbers.mjs from a local checkout.
nRF Connect iOS     NordicSemiconductor/IOS-nRF-Connect and IOS-Common-
                    Libraries were studied for the feature set of a BLE
                    scanner; their repository does not hold the full app
                    and no code was taken from them.
zbus (dogd)         D-Bus in pure Rust, MIT: dogd/Cargo.toml.
Decoders            written from the public iBeacon and Eddystone frame
                    descriptions; no code copied.
```

No Nordic service or app is needed for anything here, and none is called.

## VERIFICATION

```text
VERIFIED ON REAL HARDWARE     nothing yet: no Bluetooth adapter on the build
                              machine
TESTED IN SIMULATION          model (ids never merged, limits, stable sort,
(web/test/ble.test.ts,        presence), decoders, byte values both endians,
 dogd ble tests)              sampled session and faithful replay, dogd
                              report mapping; dogd: the report ring and its
                              loss count, BlueZ property updates to reports,
                              BlueZ error names
IMPLEMENTED, NOT VERIFIED     BlueZ discovery on a real adapter, Web
ON HARDWARE                   Bluetooth requestLEScan and GATT on a real
                              device
BLOCKED BY A MISSING          a Bluetooth adapter and BLE devices on this
CAPABILITY                    bench; dogd scanning on macOS / Windows (not
                              written)
```
