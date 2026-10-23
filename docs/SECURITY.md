# HARDWARE DOG / SECURITY

```text
LOCAL FIRST. NO ACCOUNT. NO CLOUD. NO TELEMETRY.
```

What Hardware Dog protects, against whom, and what it does not protect.
Each line names the code that does it and the test that proves it.

---

## WHAT IS AT STAKE

```text
EVIDENCE      recordings (.hdlog): what happened on a bench, sealed
THE BENCH     a Hardware Dog can write to the target (uart.tx), scan its
              bus, run network probes: whoever drives it acts on real hardware
PRIVACY       a recording can hold addresses, host names, console lines,
              serial numbers: about a person, a network, a device
THE MACHINE   the browser and dogd run on the operator's computer
```

## WHO

```text
TRUSTED       the person at the computer, and what runs as them
NOT TRUSTED   any web page from elsewhere, any machine on the network,
              any .hdlog file from anyone, any frame from a device
```

A program running as the operator can read the files and talk to dogd on
127.0.0.1: like any local tool, dogd does not defend against its own user.

---

## WHAT IS DONE

```text
NO CALL HOME     the interface makes no request off this machine: no
                 fetch, no beacon, no remote asset (web/test/laws.test.ts);
                 the only other address is dogd at 127.0.0.1
HOSTED SITE      Content-Security-Policy: scripts, styles, fonts and images
                 from the site only (images also blob:, the inspection
                 photos taken here; camera for this site only); connections to the site and to dogd on
                 127.0.0.1 only; no frames, no forms, no plugins
                 (netlify.toml; checked in Chromium: no violation)
DOGD: LOCAL      listens on 127.0.0.1 only; refuses another address unless
                 --listen-lan is given (dogd/src/config.rs)
DOGD: REBINDING  every request must name a loopback host (with
                 --listen-lan, an IP address): a page that resolves its
                 name to 127.0.0.1 is refused, in LAN mode too
DOGD: PAGES      a browser request is served only for localhost pages,
                 https://hardwaredog.org (the interface dogd is installed
                 from; --no-site-origin refuses it) and the origins given
                 with --allow-origin; any other site on the Internet cannot
                 read sessions or drive the device
DOGD: NETWORK    with --listen-lan, a request from another machine must show
                 the token dogd prints at start (128 random bits;
                 Authorization: Bearer, or ?token= for a WebSocket),
                 compared in constant time; this machine needs none
                 (dogd/src/api: tests on host, origin, rebinding, LAN, token)
DOGD: HOST       --source host reads the network state without sending
                 anything; pings, lookups and connections run only when the
                 interface asks (net.watch, probe), to host names only
DOGD: LAN SCAN   Camera Sniffer's discovery runs only when the interface
                 asks, on one interface the person picked, private (RFC
                 1918 / link-local) and at most a /16; no subnet sweep, no
                 port scan, no password, no stream (RTSP OPTIONS only);
                 deadlines, 16 connections at most, a stop aborts; answers
                 from outside the network are dropped; every parser is
                 bounded and tested on malformed input (dogd/src/lan)
CAMERA SNIFFER   photos and notes stay in the browser; the report export is
                 previewed and can mask addresses, MACs and names
                 (letters, digits, dots, dashes: never a shell); the ping
                 is the system's, run without a shell (dogd/src/hostnet).
                 Its USB list is read from sysfs: no device is opened,
                 claimed or written to
DOGD: STORAGE    a stored file is named by its recording id (32 hex), never
                 by anything a client chooses; size limited; a finalized
                 recording is never overwritten
FILES            a .hdlog from anyone is refused, with a reason and a line,
                 before it can exhaust the browser or reach the engine
                 malformed: 256 MiB, 512 KiB lines, bounded text, every
                 frame through the HDP decoder (PROTOCOL.md, limits)
EVIDENCE         every recording is sealed with a SHA-256 chain; a changed
                 byte reads MODIFIED, a report says so, a case refuses it
REPORTS          every string from a device or a file is escaped in the HTML
                 report (core/reportFormats.ts); the interface never builds
                 HTML from text; in the Camera Sniffer report, text from a
                 device stays on one line, with no HTML and no link
                 (core/camera/report.ts)
SHARING          a recording is anonymized before it leaves the bench for
                 the library: chip id, addresses, MACs, e-mails, secrets
                 typed on a console... (LIBRARY.md, core/anonymize.ts)
DEVICE           the firmware core rejects malformed commands and commands
                 for what the board does not observe; an action is never
                 taken without the operator asking (ACTIVE is said first)
FLIPPER LAB      one RPC session for the whole interface; device paths
                 checked before anything is sent (/ext, /int, /any; no ..,
                 no control characters); reads always, writes only in WRITE
                 MODE, never over an existing file without a confirmation;
                 firmware update, reboot and reset are not even encoded;
                 every frame and file parsed with limits (FLIPPER_LAB.md)
BLUETOOTH LAB    dogd's BLE endpoints sit behind the same host, origin and
                 token guard; discovery listens and connects to nothing;
                 GATT writes are previewed, confirmed, sent once, never
                 replayed after a reconnect (BLUETOOTH_LAB.md)
BUILDS           the interface, the command line, dogd and the firmware image
                 are reproducible: built twice in CI, compared byte for byte
```

## WHAT IS NOT DONE (said, not hidden)

```text
CLOSING LINE     the footer of a recording (how it closed, when it ended)
                 is not covered by a seal yet: editing it is not detected.
                 The sealed lines are. (audit 2026-10, to be fixed)
LINE BREAKS      a device string with a line break (a USB product name, a
                 console line) still starts a new line in the TXT and HTML
                 reports: read a report from a device you do not trust with
                 that in mind. (audit 2026-10, to be fixed)
SIGNATURES       a seal proves the bytes did not change since they were
                 sealed, not who wrote them: anyone can write a new file and
                 seal it. Signing with a key held by the device is planned
                 with the hardware (PROTOCOL.md, integrity)
LAN IN CLEAR     --listen-lan is plain HTTP: someone who can read the
                 network traffic can read the token and the sessions. Use it
                 on a network you trust, or through an SSH tunnel
FIRMWARE         no secure boot, no flash encryption: someone with the board
                 in hand can read it or flash another image. A Hardware Dog
                 holds no secret but its Wi-Fi password, if one is set
WEB SERIAL       the browser asks the operator which port to open; the page
                 cannot open one by itself, but the operator can choose wrong
LAB SESSIONS     an .hdlab seal proves the bytes, not who wrote them (same
                 as .hdlog); lab sessions are not anonymized yet: BLE
                 addresses and device names stay in the file
FREE TEXT        anonymize cannot recognize a secret written in plain words
                 ("the code is 4471"): the console lines it changed are listed
                 for a person to read
```

---

## REPORT A VULNERABILITY

Privately, please, not in a public issue: use **Report a vulnerability**
in the GitHub repository's **Security** tab (private vulnerability
reporting). Say what is affected, how to reproduce it, and what it lets
someone do. It is read by the author; a fix comes with a test that fails
without it, and the report is credited if you wish.
