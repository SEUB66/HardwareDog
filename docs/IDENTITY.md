# HARDWARE DOG / DEVICE IDENTITY

```text
DISCOVER WHAT IS PLUGGED IN -> BUILD A HARDWARE IDENTITY ->
RECOGNISE THE SAME DEVICE NEXT TIME
```

No encyclopedia of serial numbers, no cloud registry. A serial is one
signal among several: plenty of cheap devices have none, share a fake one,
or show a different one depending on the USB bridge. Identification is
local and deterministic: the same inputs always give the same answer, with
the network cable unplugged.

Code: `dogd/src/identity/` (the resolver, pure), `dogd/src/discovery.rs`
(hot-plug), `dogd/src/storage/` (SQLite, index v2).

---

## FINGERPRINT

Everything read from one attachment:

```text
transport        USB / SERIAL / ETH / WIFI / I2C
vid / pid
manufacturer
product
serial_number    nullable, and only kept when usable (below)
usb_path         USB topology, e.g. 1-2.3: the physical socket chain
interface        e.g. "1.0 class 02"
mac_address
chip_id          the HDP device id (from the ESP32 eFuse MAC), etc.
port             where it was seen (COM3, /dev/ttyACM0): DISPLAY ONLY
first_seen / last_seen   on the stored identity
```

On Linux the USB path and interface come from sysfs
(`/sys/class/tty/<tty>/device`). On macOS and Windows the serial-port
listing does not give them: identification there rests on chip id,
serial and descriptors.

---

## THE RESOLVER

A fixed ladder, strongest first. The first key that answers wins.

```text
1  chip id / MAC address           EXCELLENT   unique by construction
2  usable serial + VID:PID         EXCELLENT
3  VID:PID + USB path              GOOD        "already seen on this port"
4  descriptors + interface         MEDIUM      only if exactly one candidate
-  a port name alone (COM3)        NEVER an identity
```

```text
USABLE SERIAL   present, at least 4 characters, not one repeated character,
                not a counting placeholder (123456789), and not reported by
                another device of the same VID:PID plugged in right now
CONFLICT        different chip ids, MACs, or usable serials on the same
                VID:PID: never the same device, whatever else matches
PRESENT         a device attached on another port right now cannot match a
                weaker key: nothing is plugged in twice
UPGRADE         a device first known by its USB path that later answers an
                HDP hello keeps its identity and gains its chip id
AMBIGUOUS       two or more look-alikes without serial, none on this
                socket: no guess. A provisional identity is created that
                names its look-alikes; `dogd alias HW-ID NAME` settles it
                once, and the alias stays with the identity
```

Identity ids are `HW-` + 10 hex of SHA-256 over the strongest key
(`chip:hd-3a1f2c`, `usb:1A86:7523:sn:a50285bi`, `usb:1A86:7523:path:1-2`):
the same device gets the same id on any machine, without a registry.

**What a USB path cannot tell.** Two identical dongles without a serial,
swapped between their two sockets, swap identities: nothing they report
differs. Hardware Dog says "already seen on this port", which is the truth
it has. Give them aliases, or use devices that have a serial.

---

## HOT-PLUG

`dogd serve` lists the serial ports once a second (listing never writes to
a port) and compares with the previous scan:

```text
ATTACHED  /dev/ttyUSB0          HW-3F2A91C04B 'bench probe A' KNOWN GOOD (1A86:7523 already seen on USB port 1-2)
DETACHED  /dev/ttyUSB0          HW-3F2A91C04B 'bench probe A' ...
IDENTIFIED tcp:127.0.0.1:3333   HW-BBF56BE8C6 KNOWN EXCELLENT (chip id hd-3a1f2c)
ATTACHED  /dev/ttyS0            NO IDENTITY (no chip id, MAC or USB descriptor: a port name is not an identity)
```

The same scan twice gives no event. Another device appearing under the
same port name is a DETACHED then an ATTACHED, never "the same".

```text
dogd devices             what is plugged in and who it is (read only)
dogd devices --known     every identity dogd remembers
dogd alias HW-ID NAME    name a device once (--clear removes the name)

GET  /v1/devices                  attached (resolved), known, ports
GET  /v1/devices/events?since=N   ATTACHED / DETACHED / IDENTIFIED, in order
PUT  /v1/devices/{id}/alias       text body; empty clears
```

---

## STORAGE (index v2)

```text
hw_devices   id, alias, transport, vid, pid, manufacturer, product, serial,
             usb_path, interface, mac, chip_id, strength, basis,
             ambiguous_with, first_seen, last_seen, last_port
hw_events    seq, t, kind, device_id, port, strength, basis
```

Additive migration: the v1 tables (`sessions`, `devices`) are kept as they
are and stay readable; the Hardware Dogs a v1 index knew become identities
by their HDP device id. A newer index opened by an older dogd is read, not
changed.

---

## INVARIANTS, AND THE TEST THAT HOLDS EACH

```text
unplug / replug the same device: no new device
    identity: replugging_the_same_device_is_the_same_device
    storage:  unplug_replug_and_restart_keep_one_identity_and_its_alias
    end to end: the firmware host build through dogd, twice: one identity
another USB port keeps the identity when a stable id exists
    a_stable_id_survives_a_change_of_usb_port
two identical devices are told apart
    two_identical_devices_without_serial_are_told_apart
    identical_dongles_get_two_identities_and_a_bare_port_gets_none
    a_dongle_moved_while_its_twin_is_away_is_ambiguous_until_named
no serial never breaks the resolver
    a_missing_serial_never_breaks_the_resolver
    a_shared_or_fake_serial_is_not_trusted
COM port is not an identity
    a_port_name_is_never_an_identity
strong ids are never merged
    different_strong_ids_are_never_merged
hot-plug produces clean events
    hot_plug_events_are_clean
no discovery needs the Internet
    laws::dogd_has_no_network_client_dependency
an old index stays readable after migration
    an_index_from_dogd_0_1_stays_readable_after_migration
topology from sysfs
    usb_topology_is_read_from_sysfs
```

---

## NOT YET

```text
[ -- ] the interface shows the identity (SETUP, header VIA) from dogd's
       /v1/devices; today it shows the port and the Hardware Dog id
[ -- ] devices seen BY a Hardware Dog (the target on its USB / I2C bus)
       get identities too: same resolver, fed by HDP frames
[ -- ] USB path on macOS (IOKit location id) and Windows (location path)
[ -- ] hello carries the full 48-bit chip id; the HDP device id today
       is the last 24 bits of the MAC (HD-3A1F2C)
```
