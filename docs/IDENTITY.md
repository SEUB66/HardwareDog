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
serial_number    nullable; a key only while trusted (below)
usb_path         USB topology: the physical socket chain
interface        e.g. "1.0 class 02" (Linux), "if 0" (Windows, macOS)
mac_address
chip_id          48-bit factory id: HDP hello `chip` (the ESP32 eFuse MAC)
legacy_id        HDP hello `device` (HD-3A1F2C): 24 bits of the MAC
port             where it was seen (COM3, /dev/ttyACM0): DISPLAY ONLY
first_seen / last_seen   on the stored identity
```

Where the USB path comes from:

```text
Linux     sysfs, /sys/class/tty/<tty>/device -> "1-2.3"
Windows   the device's location path (SetupAPI, through the serialport
          crate) -> "PCIROOT(0)#PCI(1400)#USBROOT(0)-2.3"
macOS     the IOKit location id -> bus and port chain
```

The Linux reader is tested against a fake sysfs; the Windows and macOS
paths are built and unit-tested on those systems in CI, and have not yet
been checked against real dongles on a real desk. When the OS gives no
path, a device without a trusted serial is known by its descriptors only
(MEDIUM), and two identical ones are AMBIGUOUS: said, not guessed.

---

## THE RESOLVER

A fixed ladder, strongest first. The first key that answers wins.

```text
1  chip id / MAC address           EXCELLENT   48 bits, unique by construction
2  trusted serial + VID:PID        EXCELLENT
3  legacy HDP id (24 bits)         GOOD        only if exactly one candidate
4  VID:PID + USB path              GOOD        "already seen on this port"
5  descriptors + interface         MEDIUM      only if exactly one candidate
-  a port name alone (COM3)        NEVER an identity
```

```text
TRUSTED SERIAL  present, at least 4 characters, not one repeated character,
                not a counting placeholder (123456789), not reported by
                another device of the same VID:PID plugged in right now, and
                never proven shared before
SHARED SERIAL   proof that a serial is not unique: two devices report it at
                the same time, or it arrives with two different chip ids.
                Remembered for good (hw_shared_serials). Every identity that
                relied on it is downgraded (SERIAL_DOWNGRADED event): the
                value stays for display, it is no longer a key
CONFLICT        different chip ids, MACs, legacy ids, or trusted serials on
                the same VID:PID: never the same device, whatever else matches
PRESENT         a device attached on another port right now cannot match a
                weaker key: nothing is plugged in twice
NO SILENT MERGE a key a device declares about itself (chip id, MAC, serial,
                legacy id) is never folded into a record that was only
                matched by a weaker key: that record's past may be another
                unit's. The answer is a new identity with a hint naming the
                record. One exception: the record this same attachment
                created seconds earlier (its whole past is this attachment)
                takes the chip id from the hello that follows
AMBIGUOUS       two or more look-alikes, none on this socket: no guess. A
                provisional identity is created that names its look-alikes
BIND            `dogd bind PORT HW-ID`: the user says what is attached on
                PORT is HW-ID. It settles an ambiguity or confirms a hint:
                the identity takes this attachment's keys, the provisional
                one is kept, marked superseded, and no longer answers.
                Refused when the two cannot be the same device (conflict
                above) or when HW-ID is attached elsewhere right now
ALIAS           a label for people. It tells no look-alikes apart and
                settles nothing
```

Identity ids are `HW-` + 24 hex (96 bits) of SHA-256 over the strongest
key. Only keys that belong to the device are the same on any machine:
`chip:7cdfa13a1f2c`, `mac:...`, `usb:1A86:7523:sn:a50285bi` (trusted
serial). Ids from a USB path or descriptors (`usb:1A86:7523:path:1-2`)
describe this desk: the same dongle on another computer gets another id.

**What a USB path cannot tell.** Two identical dongles without a serial,
swapped between their two sockets, swap identities: nothing they report
differs. Hardware Dog says "already seen on this port", which is the truth
it has. Bind them when you swap them, or use devices that have a serial or
a chip id.

---

## HOT-PLUG

`dogd serve` lists the serial ports once a second (listing never writes to
a port) and compares with the previous scan:

```text
ATTACHED  /dev/ttyUSB0          HW-3F2A91C04B... 'bench probe A' KNOWN GOOD (1A86:7523 already seen on USB port 1-2)
DETACHED  /dev/ttyUSB0          HW-3F2A91C04B... 'bench probe A' ...
IDENTIFIED tcp:127.0.0.1:3333   HW-BBF56BE8C6... KNOWN EXCELLENT (chip id 7cdfa13a1f2c)
ATTACHED  /dev/ttyS0            NO IDENTITY (no chip id, MAC or USB descriptor: a port name is not an identity)
ATTACHED  /dev/ttyUSB1          NO IDENTITY (IDENTITY NOT STORED: index: ...)
```

The same scan twice gives no event. Another device appearing under the
same port name is a DETACHED then an ATTACHED, never "the same". When the
index cannot be written, the line says so and nothing is claimed
remembered; the API answers 500 with the reason.

```text
dogd devices             what is plugged in and who it is (read only)
dogd devices --known     every identity dogd remembers
dogd alias HW-ID NAME    a label (--clear removes it)
dogd bind PORT HW-ID     through the running dogd, else on the index

GET  /v1/devices                  attached (resolved), known, ports
GET  /v1/devices/events?since=N   ATTACHED / DETACHED / IDENTIFIED /
                                  BOUND / SERIAL_DOWNGRADED, in order
PUT  /v1/devices/{id}/alias       text body; empty clears
PUT  /v1/devices/{id}/bind        text body: the port
```

---

## STORAGE (index v2)

```text
hw_devices         id, alias, transport, vid, pid, manufacturer, product,
                   serial, serial_trusted, usb_path, interface, mac,
                   chip_id, legacy_id, strength, basis, ambiguous_with,
                   hint, superseded_by, first_seen, last_seen, last_port
hw_events          seq, t, kind, device_id, port, strength, basis
hw_shared_serials  vid, pid, serial, t, reason
```

Additive migration: the v1 tables (`sessions`, `devices`) are kept as they
are and stay readable. The Hardware Dogs a v1 index knew become identities
by their legacy 24-bit HDP id, at GOOD: a hint, never a chip id. When such
a board later says its 48-bit chip id, it gets a new EXCELLENT identity
with a hint to the legacy one; `dogd bind` joins them. A newer index opened
by an older dogd is read, not changed.

---

## INVARIANTS, AND THE TEST THAT HOLDS EACH

```text
unplug / replug the same device: no new device
    identity: replugging_the_same_device_is_the_same_device
    storage:  unplug_replug_and_restart_keep_one_identity_and_its_alias
    end to end (web/test/firmware.test.ts): the firmware host build with a
      chip id, through dogd, twice, two dogd processes: one identity
another USB port keeps the identity when a stable id exists
    a_stable_id_survives_a_change_of_usb_port
two identical devices are told apart
    two_identical_devices_without_serial_are_told_apart
    identical_dongles_get_two_identities_and_a_bare_port_gets_none
    the_os_location_path_tells_identical_dongles_apart (Windows paths)
no serial never breaks the resolver
    a_missing_serial_never_breaks_the_resolver
a fake or shared serial is not trusted, and stops being trusted
    a_shared_or_fake_serial_is_not_trusted
    a_serial_proven_shared_is_downgraded_for_good
    the_same_serial_on_two_chip_ids_is_not_trusted
the chip id is 48 bits; the 24-bit id is only a hint
    reads_the_48_bit_chip_id_only_when_well_formed (dogd)
    test_hello_chip_id (firmware core)
    a_legacy_24_bit_id_is_only_a_hint
no silent merge of a weak past into a strong identity
    a_strong_key_is_never_folded_into_a_weaker_record
    a_chip_id_joins_only_the_identity_its_own_attachment_created
an alias is a label; bind settles, and refuses the impossible
    an_alias_is_a_label_and_only_bind_settles_an_ambiguity
    bind_refuses_what_cannot_be_the_same_device
COM port is not an identity
    a_port_name_is_never_an_identity
strong ids are never merged
    different_strong_ids_are_never_merged
hot-plug produces clean events
    hot_plug_events_are_clean
an index error is said, never hidden
    an_index_error_is_returned_never_claimed_stored
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
[ -- ] checked on real hardware: two identical CH340 without serial on
       Linux, Windows and macOS; an ESP32-S3 sending its eFuse chip id
[ -- ] the interface shows the identity (SETUP, header VIA) from dogd's
       /v1/devices; today it shows the port and the Hardware Dog id
[ -- ] devices seen BY a Hardware Dog (the target on its USB / I2C bus)
       get identities too: same resolver, fed by HDP frames
[ -- ] unbind: undo a bind (today the superseded record is kept, so
       nothing is lost, but there is no command to restore it)
```
