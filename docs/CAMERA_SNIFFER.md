# HARDWARE DOG / CAMERA SNIFFER

> Spot the clues. Inspect the devices.
> Repérer les indices. Inspecter les appareils.

A section of Hardware Dog for looking for clues of cameras and inspecting
objects, step by step: the local network, Bluetooth, USB, an offline
catalog of object families, a guided physical inspection, and a local
report. It helps to investigate. **It never certifies that a room has no
camera**: a camera that records to a memory card, off the network or
switched off can escape every scan. The interface says it once at the top,
and the report says it again.

```text
SECTION     CAMERA (menu), web/src/ui/camera/
CORE        web/src/core/camera/  (catalog, model, net, demo, clues, inspection, report)
ENGINE      dogd/src/lan/         (network discovery), dogd/src/hostnet/usb.rs (USB interfaces)
TESTS       web/test/camera.test.ts, dogd: cargo test lan, cargo test usb
```

---

## LOCAL, AND BOUNDED

- No account, no cloud. Photos and notes stay in this browser (IndexedDB
  `hwdog-lab`, stores `camera` and `photos`); nothing is sent anywhere.
- The catalog ships with the interface and works offline. A catalog update
  is a new version of the file (`web/src/core/camera/data/catalog.json`).
- A scan targets one interface the person picked, on a private network
  (RFC 1918 or link-local) this computer is on, never wider than a /16.
- No password is tried, no authentication bypassed, nothing exploited. No
  video stream is described (no RTSP DESCRIBE) nor opened, nor recorded.
- No full port scan, no subnet sweep: hosts are asked only after they
  showed themselves.

---

## THE FIVE VIEWS

```text
OVERVIEW       tools really available, the selected network, what is left to
               examine, steps done, coverage limits; START AN INSPECTION,
               SCAN THE NETWORK, EXAMINE AN OBJECT, SEE THE REPORT
NETWORK        source (dogd or the demo), interface, methods, scan / stop,
               the devices seen, and for each: state, reasons, raw answers,
               "known device", a documented verification, manual links to
               Bluetooth devices
BLE · USB      Bluetooth Lab's observations read for this inspection;
               USB interfaces declared by plugged devices
OBJECTS        rooms, objects, status, what was seen, next check, local
               photos with numbered marks; the catalog with its filters and
               reference sheets
REPORT         facts / interpretations / declarations / to verify / limits,
               previewed exactly as exported, with masking
```

No radar, no camera counter built from the number of unknown devices.
A phone gets one column, cards instead of tables, large targets and the
camera at hand; a computer gets the denser tables.

---

## NETWORK DISCOVERY (dogd)

A browser cannot list a network. dogd does it, on this computer, when the
interface asks (`PUT /v1/lan/scan`). Without dogd, the section says how to
start it (`dogd serve`, Linux); the catalog and the inspection keep
working. In order:

```text
STEP        WHAT                                            SENDS
neighbors   the kernel's IPv4 neighbor table (/proc/net/arp)  nothing
mdns        one DNS-SD question (_services._dns-sd._udp.local), then a PTR
            question for each type heard (at most 24); legacy unicast from
            an ephemeral port, so responders answer us directly
            (RFC 6762 6.7, RFC 6763); parsed with simple-dns   2+ datagrams
ssdp        one M-SEARCH ssdp:all (UPnP Device Architecture 2.0 1.3), then
            the device descriptions the LOCATION headers point at, only on
            the answering host, 4 at a time, 64 KB at most, parsed with
            roxmltree                                       2 datagrams + GETs
wsd         ONVIF WS-Discovery Probe for dn:NetworkVideoTransmitter and
            tds:Device (ONVIF Core 7.3); ProbeMatch Types, Scopes, XAddrs
                                                            2 datagrams
services    on hosts seen above only (256 at most): TCP connect to 554 and
            8554 (RTSP), 80, 8080, 8000, 443 (web interfaces, where ONVIF
            device services live); where RTSP answers, one OPTIONS request
            (RFC 2326 10.1): status, Server, Public. 16 connections at
            once, 700 ms to connect, 1.5 s to read      connections + OPTIONS
```

Multicast leaves through the chosen interface (IP_MULTICAST_IF via
socket2); answers from outside its network are dropped. Every step has a
deadline; a stop aborts the scan at once and what was observed stays
readable. Interfaces come from `ip -j -4 addr`, or, without iproute2, from
the connected routes of /proc/net/route and the address the kernel would
use (a connected UDP socket, nothing sent).

The manufacturer of a MAC is read from the system's IEEE registry file
when one is installed (`/usr/share/ieee-data/oui.txt`, arp-scan's or
nmap's copy; `HWDOG_OUI` names another). Hardware Dog does not bundle a
registry. A locally administered (random) MAC has no manufacturer.

For each device: address, MAC and presumed manufacturer when available,
names announced, services observed, each record with its method and the
raw answer (clipped to 2 KB), first and last seen, interface. This is
service discovery, not traffic capture: nothing here observes what devices
send.

---

## CLASSIFICATION, EXPLAINED

Never a percentage. A state, and the reasons, each pointing at the answer
it rests on (and at its lab event `#seq` when a session records).

```text
DEVICE DISCOVERED                 seen; nothing it announced points to media
MEDIA SERVICE OBSERVED            RTSP answered OPTIONS; _rtsp._tcp announced;
                                  UPnP MediaServer / MediaRenderer; casting
CLUES COMPATIBLE WITH VIDEO       ONVIF NetworkVideoTransmitter; a UPnP camera
  EQUIPMENT                       device type
MODEL IDENTIFIED                  the above, and the device reports its model
                                  (ONVIF hardware scope, UPnP description)
CAMERA CONFIRMED BY A DOCUMENTED  only when a person writes what they saw,
  VERIFICATION                    where and how
UNDETERMINED                      seen only through answers that could not be read
```

Hints, which decide nothing: a manufacturer (an origin, not an
identification), a name ("cam" in a name identifies nothing), an open
port (a port is not a service), a camera word in an SSDP server string.
RTSP can belong to a media server; an ONVIF answer can come from a
recorder; no answer excludes nothing; a guest network can isolate devices.
Marking a device "known" keeps every observation; a manual link to a
Bluetooth device is shown as the person's, never as observed.

---

## BLUETOOTH

Bluetooth Lab's scanner (Web Bluetooth, dogd on Linux, or its demo): names
advertised and system names apart, services, manufacturer data, RSSI (a
level, never a distance), last seen, source. An unknown Bluetooth device is
not a camera, and a tracker is not a camera. The only signatures
(`ble-signatures 1`) name trackers, each with its source:

```text
DULT             service 0xFCB2 "Location Enabled Advertisement Service" (Bluetooth SIG)
APPLE FIND MY    company 0x004C, payload type 0x12 (Heinrich et al., PETS 2021)
TILE             services 0xFEED / 0xFEEC (Bluetooth SIG member UUIDs, Tile, Inc.)
SAMSUNG SMARTTAG service 0xFD5A (Bluetooth SIG member UUID, Samsung)
```

Everything else stays "BLE device not identified". Wi-Fi and Bluetooth
observations are never merged on their own.

## USB

dogd lists every interface of a plugged device by class, from sysfs
(`interfaces` in `GET /v1/usb`): video / image (UVC, PTP, A/V), storage,
serial, audio, input, other, with the raw identifiers. A video interface
is a technical clue: it proves neither recording nor concealment (webcams
declare it). A camera charger declares no data interface at all: an empty
USB result excludes nothing. The guide never asks to plug in an electrical
object that looks suspicious or damaged.

---

## THE CATALOG

Sixteen families, alphabetical, never ranked by frequency (there are no
reliable statistics on what is found in rentals): air freshener, alarm
clock, clock radio, coat hook, eyeglasses, key fob / remote, miniature
camera module, pen, telephone wall jack, picture frame, power bank, power
strip, smoke detector, tissue box, USB charger, wall outlet / plug adapter.

Filters: room, power, local storage documented, communication documented,
inspection method, text. Each sheet: observable particularities, ordinary
look-alikes, possible checks, scanner limits, documented models.

**Illustrations are generic drawings, labeled as such, never a photo of a
product.** No photo is shown unless its reuse is allowed and credited; none
is in this version.

Documented models (version 2026-10-17.1): two LawMate charger references
were found by web search on 2026-10-17 (KJB/LawMate PV-CS10iA on a retailer
page; LawMate PV-CHG30i on retailer listings). **The pages could not be
read from the build environment**, so they are marked NOT VERIFIED, with
their claims as retailer claims and the lens position "not verified".
Searches did not return product pages from SpyCentre, BrickHouse Security
or SpyAssociates: those vendors are listed for review, nothing is cited
from them yet. Vendor claims are claims, not independently verified
performance.

## THE GUIDED INSPECTION

Choose a room, add the objects (from the catalog or not), read the sheet,
take photos and mark them (kept in this browser), note what was seen, set
the next check. Attention goes to concrete things: a visible optical
opening, the placement and orientation, the product reference, a
difference with the ordinary product. A hole, a reflection or a dark part
is never a verdict on its own.

The camera view offers live video, zoom and the torch only when the
camera says it has them; photos can also come from a file (where live
video is refused). The phone is not an infrared detector; no ToF/LiDAR
detection is claimed. No "finger on the mirror" test. The guide never asks
to open mains devices, fixed equipment or safety detectors.

The visit order is an aid to organise it, from what the person said (a
private room, an object facing a private space, a concrete observation to
check), never a probability of a camera. Belonging to the catalog flags
nothing.

---

## SESSIONS AND REPORT

Everything goes on the lab timeline (`.hdlab`, source CAMERA; what a person
states is source USER, marked `declared`): scans with their observations,
object statuses, photos taken, known devices, confirmations, manual links.

The report separates FACTS (observed by the tools, with `#seq`),
INTERPRETATIONS (how the classification reads them), DECLARATIONS (what the
person stated), TO VERIFY, and LIMITS. Its strongest conclusion is:

> No clue identified with the methods used.
> Aucun indice identifié avec les méthodes utilisées.

and never "no camera" nor "room secured". Export is previewed exactly; it
can replace addresses, MACs and announced names with stable aliases, and
hide the place, labels and notes. Photos are never in the file.

## COMPANION TV

The same TV and event contract. The scenes are the owner's drawings
(no new drawing was invented for this section):

```text
NETWORK SCAN            SCAN (the scanner, the spectrum)
OBJECT EXAMINED         ANALYZE (lamp and magnifier)
SHEET COMPARED          REPORT (the printout held up)
INSPECTION FINISHED,    REPORT
  REPORT EXPORTED
```

Messages (FR/EN), neutral, also shown at the top of the section:
"Recherche sur le réseau sélectionné.", "Service vidéo à examiner.",
"Cet appareil n'est pas encore identifié.", "Cette vérification nécessite
une inspection visuelle.", "Inspection terminée. Certains appareils peuvent
rester invisibles aux scans." No "spy found" on a weak match; a success
means an operation finished, not that a place is safe.

---

## REFERENCES

- Sneaky Spy Devices and Defective Detectors (USENIX Security 2023): covert
  devices and detectors that miss them; why a scan is never a guarantee.
- Lumos (USENIX Security 2022): finding hidden IoT devices by their
  traffic. Hardware Dog does not capture traffic.
- Usability Determines Safety for At-Risk Users (SOUPS 2026): listed for
  this module, not yet reviewed here.
- LAPD (github.com/frizensami/lapd): hidden camera detection with specific
  phones' ToF sensors. Research on compatible hardware only: **not
  integrated**, and a browser cannot use it.

---

## VERIFICATION STATUS (said, not hidden)

```text
WHAT                                  HOW IT WAS TESTED
parsers (interfaces, routes, ARP,     unit tests on real-format samples, malformed,
  OUI, mDNS, SSDP, UPnP, WS-Discovery,  truncated and hostile input (cargo test lan)
  RTSP, chunked bodies)
RTSP OPTIONS check, timeouts          against a local fake server (127.0.0.1)
dogd API: refusals, origin guard      router tests (cargo test api)
interface listing                     REAL: dogd on the build machine listed its
                                      interface via /proc/net/route and REFUSED
                                      it (192.0.2.0/24 is not a private network)
a full scan over a real Linux network REAL SOCKETS, SIMULATED DEVICE: a private
  stack (veth, network namespace)       network (veth pair into a network
                                      namespace) with a pretend camera answering
                                      mDNS, SSDP + UPnP description, ONVIF
                                      WS-Discovery, RTSP OPTIONS and HTTP, plus 30
                                      silent hosts. dogd found it by all five
                                      methods (186 checks, 13 s), the interface
                                      showed it MODEL IDENTIFIED with its reasons,
                                      the masked export leaked none of its
                                      identifiers, a stop aborted every
                                      connection in flight, and two starts at
                                      once ran one scan
a real camera, NVR or ONVIF device    NOT TESTED: no hardware. The pretend camera
                                      follows the protocols; a real one may answer
                                      differently
USB interface listing                 unit tests on a sysfs tree
web: classification, service, demo,   vitest (web/test/camera.test.ts), and the
  report, masking, inspection, clues  interface driven in Chromium (desktop and
                                      iPhone viewports) on the DEMO network and
                                      on dogd with the pretend camera
camera / torch / zoom                 NOT TESTED on a phone: the code offers them
                                      only when the browser reports them
```

The demo network is SIMULATED everywhere it appears (an ONVIF recorder, a
TV and a NAS exposing media services, a phone with a random MAC, an
unreadable description, a silent RTSP port). No simulated test is a
validation on a real camera.
