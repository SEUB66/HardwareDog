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
                 from the site only; connections to the site and to dogd on
                 127.0.0.1 only; no frames, no forms, no plugins
                 (netlify.toml; checked in Chromium: no violation)
DOGD: LOCAL      listens on 127.0.0.1 only; refuses another address unless
                 --listen-lan is given (dogd/src/config.rs)
DOGD: REBINDING  every request must name a loopback host: a page that
                 resolves its name to 127.0.0.1 is refused
DOGD: PAGES      a browser request is served only for localhost pages and
                 the origins given with --allow-origin; a site on the
                 Internet cannot read sessions or drive the device
DOGD: NETWORK    with --listen-lan, a request from another machine must show
                 the token dogd prints at start (128 random bits;
                 Authorization: Bearer, or ?token= for a WebSocket),
                 compared in constant time; this machine needs none
                 (dogd/src/api: tests on host, origin, rebinding, LAN, token)
DOGD: HOST       --source host reads the network state without sending
                 anything; pings, lookups and connections run only when the
                 interface asks (net.watch, probe), to host names only
                 (letters, digits, dots, dashes: never a shell); the ping
                 is the system's, run without a shell (dogd/src/hostnet)
DOGD: STORAGE    a stored file is named by its recording id (32 hex), never
                 by anything a client chooses; size limited; a finalized
                 recording is never overwritten
FILES            a .hdlog from anyone is refused, with a reason and a line,
                 before it can exhaust the browser or reach the engine
                 malformed: 256 MiB, 128 KiB lines, bounded text, every
                 frame through the HDP decoder (PROTOCOL.md, limits)
EVIDENCE         every recording is sealed with a SHA-256 chain; a changed
                 byte reads MODIFIED, a report says so, a case refuses it
REPORTS          every string from a device or a file is escaped in the HTML
                 report (core/reportFormats.ts); the interface never builds
                 HTML from text
SHARING          a recording is anonymized before it leaves the bench for
                 the library: chip id, addresses, MACs, e-mails, secrets
                 typed on a console... (LIBRARY.md, core/anonymize.ts)
DEVICE           the firmware core rejects malformed commands and commands
                 for what the board does not observe; an action is never
                 taken without the operator asking (ACTIVE is said first)
BUILDS           the interface, the command line, dogd and the firmware image
                 are reproducible: built twice in CI, compared byte for byte
```

## WHAT IS NOT DONE (said, not hidden)

```text
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
