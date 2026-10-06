# HARDWARE DOG / DOGD

```text
WHAT          the local Hardware Dog daemon
WHERE         dogd/ (Rust: Tokio, Axum, Serde, SQLite)
LISTENS       127.0.0.1:4782, this machine only, by default
STATUS        LVL 55: transport + storage, no diagnosis
```

dogd is **not** a cloud backend, not an account, not an Internet API, and
not a second diagnostic engine. It is a local daemon:

```text
DISCOVER    serial ports, Hardware Dogs by their HDP hello
CONNECT     one device link (serial port, or any HDP byte stream over TCP)
BRIDGE      device bytes to the interface, unchanged; commands back, unchanged
STORE       finished .hdlog files, byte for byte, indexed in SQLite
SERVE       a small local API
```

and never:

```text
INTERPRET DIFFERENTLY    INVENT EVENTS    REWRITE HDP    BECOME SAAS
```

---

## ONE ENGINE, FOUR TRANSPORTS

```text
                    ┌──────────────────────────┐
                    │        INTERFACE         │
                    └────────────┬─────────────┘
                           Transport API
       ┌──────────────┬──────────┴───┬──────────────┐
       ▼              ▼              ▼              ▼
   SIMULATOR      WEB SERIAL       REPLAY          DOGD
       └──────────────┴──────┬───────┴──────────────┘
                          HDP v1
                             ▼
                  SAME DECODER, SAME TRACE
                     SAME DIAGNOSTICS
```

dogd never short-circuits this. On the HDP socket it sends the device's
bytes exactly as they arrived (binary WebSocket messages, any chunking),
and the interface feeds them to the same line decoder as Web Serial. A
malformed line is rejected by that decoder, not by dogd. There is no Rust
event type, no conversion, no extra field.

The diagnostic rules live in one place, the interface
(`web/src/core/diagnostics.ts`). dogd has none. If headless diagnosis is
wanted later, it will come from one shared rule representation, never from
a manual TypeScript to Rust port.

**Proof** (`web/test/dogd.test.ts`, against the real binary, in CI):

```text
SIMULATOR ── direct ─────────────────────────────────> diagnosis
SIMULATOR ── TCP ──> dogd ── WebSocket ──> interface ──> diagnosis

same frames, same facts, same timeline, same diagnosis,
same confidence, SAME EVIDENCE REFERENCES (HDP frame #371 #375 ...)
```

---

## RUN

```sh
cd dogd
cargo build --release
./target/release/dogd                                   # no device yet
./target/release/dogd --source serial:/dev/ttyACM0      # Linux / macOS
./target/release/dogd --source serial:COM4              # Windows
./target/release/dogd --source tcp:192.168.1.50:3333    # a device on Wi-Fi
./target/release/dogd --source host                     # this computer's network, no probe
```

Several sources are a **pack** ([`PACK.md`](PACK.md)): one Dog per
source, D1, D2... in the order given, up to 8. `--source-origin` applies
to the `--source` just before it.

```sh
./target/release/dogd --source serial:/dev/ttyACM0 \
                      --source serial:/dev/ttyACM1     # D1 on the supply, D2 on the network
```

dogd bridges each Dog's bytes on its own stream, unchanged: it never
merges two Dogs, never aligns their clocks, never decides which one is
right. The one timeline and the one clock are the engine's, the same in
the interface, in a replay and in a case. CONNECT DOGD opens one device
when dogd has one source, the pack when it has several; a pack starts
with every Dog online (a Dog missing from the start would be a hole
nobody sees).

```text
HW DOG / DOGD
VERSION        0.1.0
MODE           LOCAL
LISTEN         127.0.0.1:4782
HDP            v1
DEVICE         serial:/dev/ttyACM0
ORIGIN         PHYSICAL
DATA           /home/me/.local/share/hwdog
SESSIONS       12
STATE          READY
```

Then in the interface: **SETUP → CONNECT DOGD**.

```text
dogd status              ask a running dogd how it is
dogd devices             what is plugged in, and who it is (never writes to a port)
dogd devices --identify  send one HDP hello per port: HARDWARE DOG or UNKNOWN DEVICE
dogd devices --known     every device identity dogd remembers
dogd alias HW-ID NAME    a label for people; tells no look-alikes apart
dogd bind PORT HW-ID     the device on PORT is HW-ID (settles an ambiguity,
                         confirms a hint; refused if chip id, MAC or
                         serial differ)
dogd sessions            list stored sessions (works with dogd stopped)
```

`--identify` writes exactly one HDP `hello` and reads the answer. dogd
never writes anything else to a port it was not told to use, and never
flashes anything. Note: opening a serial port can reset some boards (DTR).

---

## NO PROBE: THIS COMPUTER'S NETWORK

```sh
./target/release/dogd --source host
```

Then in the interface: **START HERE → THIS COMPUTER'S NETWORK**.

`host` is a device that lives in dogd and speaks HDP v1 like a probe,
with the capabilities it really has: `net`, `probe`, and `usb` where the
system's USB list is read (Linux). Its hello says `device HOST, rev
HOST`. Power, serial and I2C are not observed, and STATUS says NOT
MONITORED. The timeline, the network rules
(NO_LINK, DHCP_FAILURE, GATEWAY_UNREACHABLE, DNS_FAILURE,
UPSTREAM_FAILURE, NETWORK_UNSTABLE), the recording, the replay and the
report are the same as with a probe.

```text
PASSIVE (always)     reads what the system knows, sends nothing, every 5 s:
                     link    Linux: operstate, carrier, speed, duplex of the
                             interface of the default route
                             macOS: ifconfig status of that interface
                             Windows: not said: UNKNOWN
                     address the address the system would use to go out (a
                             connected UDP socket, never written to)
                     DHCP    PASS: an address that is not 169.254.x.x
                             FAIL: link up and no address, or 169.254.x.x
                             (dogd cannot tell DHCP from a static address)
                     routes  the default gateway (/proc/net/route, route -n
                             get default, route print); the name server from
                             /etc/resolv.conf (Windows: not said)
ACTIVE (when asked)  the interface asks with net.watch: THIS COMPUTER'S
                     NETWORK starts it (every 10 s), NET -> WATCH changes it
                     gateway four pings (the system's ping); none answered:
                             FAIL; ping missing or not allowed: UNKNOWN
                     DNS     the name given resolves
                     Internet a TCP connection to the host given, port 443
                             (a name that does not resolve: UNKNOWN, it is DNS)
                     latency, loss: of the four pings
PROBE                PING, DNS, TCP (port 80), HTTP (GET /, the status line):
                     what the PROBE screen asks, from this computer
USB (Linux)          the devices plugged into this computer, read every 1 s
                     from /sys/bus/usb/devices: nothing is opened, claimed
                     or written. Every device plugged in or out is a line
                     on the timeline (id, name, class, speed, port). USB ->
                     FOLLOW makes one the target (usb.follow): its
                     usb.attach / usb.detach go to the USB rules, which say
                     the supply was not observed. GET /v1/usb is the list.
                     macOS and Windows: not read yet, no `usb` declared.
```

Nothing ACTIVE runs before the interface asks, and the timeline says
when it did. A computer is not a probe: it sees its own network and its
own USB ports, not the board's; it measures no power. A probe adds that.

HWDOG_USB_SYSFS points the USB reading at another tree that looks like
/sys/bus/usb/devices: for tests and demos (web/test/dogd.test.ts).

---

## PROVENANCE

A serial port is real hardware: `PHYSICAL`. dogd cannot tell a simulator on
a TCP port from a device on Wi-Fi, so the operator says it:

```sh
dogd --source tcp:127.0.0.1:5055 --source-origin simulated
```

The interface records sessions through dogd with `source: "DOGD"` and the
origin dogd reports (`GET /v1/link`), fixed before the first frame. A
simulated source stays labeled SIMULATED everywhere.

---

## LOCAL API

```text
GET  /v1/health                {"status":"ok","dogd":"0.1.0","hdp":1}
GET  /v1/link                  state, source, origin, label, device, epoch (D1)
GET  /v1/links                 {"links":[...]}: every Dog, D1 first, with its id
GET  /v1/devices               attached devices and who they are, known identities
GET  /v1/devices/events        ATTACHED / DETACHED / IDENTIFIED (?since=N)
PUT  /v1/devices/{id}/alias    a label for people (text body)
PUT  /v1/devices/{id}/bind     the device on the port in the body is {id}
GET  /v1/sessions              the session index
GET  /v1/sessions/{id}         one session
GET  /v1/sessions/{id}/hdlog   the file, byte for byte
PUT  /v1/sessions/{id}/hdlog   store a file the interface wrote
WS   /v1/hdp                   raw HDP: device bytes out, command lines in (D1)
WS   /v1/hdp/{dog}             the same for one Dog of a pack: /v1/hdp/D2
```

HDP commands (probe, i2c scan, baud...) are **not** repeated as REST
endpoints: they go through `/v1/hdp`, like on every transport. One
protocol, not two.

WebSocket close codes the interface shows as the reason:

```text
4404   no device connected
4001   device link lost (the session ends: no session spans two links)
4008   client too slow: bytes would be lost, so the session ends instead
```

---

## STORAGE

```text
<data>/index.sqlite                 the index
<data>/sessions/<recording>.hdlog   the evidence, byte for byte
```

**The file is the evidence. The database is the index.** Events are not
copied into tables: the .hdlog is already the canonical artifact.

```text
sessions   id, recording_id, session_label, origin, source, device_id,
           started_at, ended_at, integrity, closure, sha256, bytes,
           hdlog_path, stored_at
devices    device_id, hardware_revision, firmware_version, hdp_version,
           port, first_seen, last_seen
hw_devices / hw_events / hw_shared_serials   identities, plug events,
           serials proven shared (index v2):
           IDENTITY.md
```

Device identity (what is plugged in, is it the same as last time) has its
own page: [`IDENTITY.md`](IDENTITY.md). A port name is never an identity.

- dogd stores hdlog v2 files, under their own recording id only.
- It checks each file with the same integrity algorithm as the interface
  (seals, footer hash, counts) and records the status. Cross-checked by
  tests on both sides with the same files.
- Files are written to a temporary name, flushed to disk, then renamed: a
  crash never leaves half a recording under the real name.
- The same bytes again: accepted, nothing changes. Other bytes for a
  finalized recording: refused (409). Evidence is never overwritten.
- The interface hands a session to dogd when it ends, if it was recorded
  through dogd. The browser keeps its own copy too.

---

## TRUST BOUNDARY: THIS MACHINE

```text
DEFAULT BIND      127.0.0.1                  never 0.0.0.0 by default
NO LOGIN          the boundary is the machine, not an account
NO CLOUD          no HTTP client in dogd; the only outbound connection
                  is to the device you name (--source tcp:...)
NO TELEMETRY
```

"No login" is not "no security":

- **DNS rebinding**: every request must name a loopback host
  (`127.0.0.1`, `localhost`, `[::1]`). A page that resolves its own name to
  127.0.0.1 is refused.
- **Other web pages**: a browser request carrying an `Origin` is served
  only for `http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*`
  and the origins given with `--allow-origin`. A site on the Internet
  cannot read sessions or drive the device on your desk.
- **Private Network Access**: an allowed site served over HTTPS (for
  example a hosted copy of the interface, `--allow-origin
  https://your.site`) gets the preflight answer browsers require to reach
  127.0.0.1.
- **LAN** is an explicit decision: `dogd --listen-lan`. dogd then prints a
  `TOKEN` (128 random bits, new at every start): a request from another
  machine must show it (`Authorization: Bearer <token>`, or `?token=` for a
  WebSocket), or it is refused; this machine needs none. Browser origins
  are still checked. It is plain HTTP: use it on a network you trust
  ([`SECURITY.md`](SECURITY.md)).

```text
TESTS   dogd/src/api (host, origin, preflight, rebinding, LAN, token)
```

---

## LVL 55 GATE

```text
[ OK ] dogd starts completely offline           no outbound code at all
[ OK ] binds localhost only by default          refuses a non-loopback --listen
[ OK ] DogdTransport implements the transport contract
[ OK ] raw HDP v1 goes through the existing decoder
[ OK ] simulator direct == simulator through dogd
[ OK ] replay results unchanged                 a dogd recording replays the same
[ OK ] diagnostics unchanged, evidence references unchanged
[ OK ] commands round-trip through dogd         i2c scan, in CI
[ OK ] disconnect / reconnect clean             LINK LOST, then a new epoch
[ OK ] malformed HDP rejected by the SAME decoder
[ OK ] session persisted locally, byte-exact
[ OK ] restart dogd -> the session index survives
[ OK ] no cloud / network dependency, no account
[ OK ] serial source                            checked on a Linux pty device
[ OK ] several sources, one stream per Dog      two firmware processes through
                                                one dogd are one pack: same
                                                diagnosis as one board (LVL 90.3)
[ -- ] real ESP32-S3 on a serial port           LVL 60
```
