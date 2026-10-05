# HARDWARE DOG / INCIDENT LIBRARY

```text
LIVE INCIDENT -> .HDLOG -> ANONYMIZE -> CASE -> PULL REQUEST -> REGRESSION
```

Not a social network. A repository of anonymized, reproducible hardware
failures: every case is a recording and what replaying it must produce.
A real library of failures is worth more than code: each case keeps the
engine honest on every commit, forever.

No account, no upload, no cloud. You choose what to contribute, and you
contribute it the way code is contributed: a pull request.

---

## THE SHELVES

```text
cases/baseline/   healthy sessions: what normal looks like
cases/power/      supply, cable, current: the rail
cases/usb/        the USB link of the target
cases/uart/       the serial console: baud, resets
cases/network/    link, DHCP, gateway, DNS, upstream
cases/i2c/        the I2C bus and its devices
cases/INDEX.md    the table of contents, generated
```

A case sits on the shelf of its **first diagnosis**: the cause comes
first (a router losing its power is a `power` case, even though the
network drops). A session with no finding is a `baseline`.

Each case is two files:

```text
HD-C042.hdlog       the recording (anonymized if it comes from real hardware)
HD-C042.case.json   its shelf, the incident in words, and what the replay
                    must produce: facts, diagnosis, evidence frames
```

---

## CONTRIBUTE AN INCIDENT

```text
1. RECORD     the incident, with a Hardware Dog (every session is recorded)
2. REPLAY     it: SETUP -> SESSIONS -> REPLAY
3. SHARE      REPORT -> SHARE WITH THE LIBRARY
                 downloads HD-C-xxxxxxxx.hdlog    an anonymized copy
                           HD-C-xxxxxxxx.case.json its case, drafted
4. READ       the console lines the summary says were changed (see below)
5. WRITE      in the case: title, context.description, context.hardware,
              context.expected (every TODO goes)
6. NUMBER     the next free HD-C number (cases/INDEX.md): rename both
              files, and "id" and "recording.file" in the JSON
7. PLACE      both files on the shelf named by "category"
8. INDEX      cd web && npm run cli && node dist-cli/hwdog.mjs index ../cases --write
9. CHECK      npm run test:cases                (the same check CI runs)
10. OPEN      a pull request with the incident template:
              ?template=incident.md, or copy .github/PULL_REQUEST_TEMPLATE/incident.md
```

From a terminal, without the interface:

```sh
node dist-cli/hwdog.mjs anonymize session.hdlog --out HD-C042.hdlog
```

---

## WHAT ANONYMIZE REMOVES

The copy tells the same incident with nobody named. Every replacement is
consistent (one address is always the same stand-in; two never merge),
so the replay gives **the same facts, diagnosis and evidence frames**.
That is checked when the copy is made, and again on every commit for
every case of the library.

```text
REPLACED                                          BY
hello.chip      the board's factory id            removed
hello.device    the 24-bit id derived from it      HD-ANON1, HD-ANON2...
usb serial      the target's serial number        ANON-1...
addresses       device, gateway, DNS, hops,       192.0.2.x / 2001:db8::x
                and any address in text           (documentation ranges)
host names      probe targets, DNS checks          host-1.example...
MAC addresses   anywhere in text                  02:00:00:00:00:01...
e-mails         anywhere in text                  user-1@example.org...
secrets         password=, psk=, token=, ssid=,   <removed>
                key=, user=... in text
long hex        16 hex digits or more (keys,      <hex-1>...
                hashes, serials)
user names      /home/NAME, /Users/NAME,          /home/user...
                C:\Users\NAME in paths
endpoint        the port path or address          "WEB SERIAL (anonymized)"
recording id    the original's                    derived from it (the same
                                                  file gives the same copy)
```

The header of the copy says it: `"anonymized": {"from": <sha256 of the
original file>, "version": 1}`. The original stays on your bench: it is
the evidence; the copy is what you share.

**What it cannot know**: a secret written in plain words on a console
("the code is 4471"), a name in a note. The summary counts the console,
log and note lines it changed; read the console lines of your recording
before you send it. A reviewer reads them too.

Only an intact recording can be anonymized (VERIFIED or RECOVERED): an
anonymized copy of altered evidence would launder it.

---

## WHAT EVERY PULL REQUEST IS CHECKED FOR

`hwdog test cases` (CI, on every pull request that touches `cases/`):

```text
REPLAY        the recording is the exact file its case names (SHA-256),
              intact, and replays to the stated facts, diagnosis and
              evidence frames, through today's decoder and rules
SHELF         the directory is a category, and "category" names it
NAME          HD-C followed by a number; HD-C042.hdlog next to
              HD-C042.case.json; one id, one case
WORDS         title, context.description, context.hardware,
              context.expected written; no template text left
PRIVACY       a recording of real hardware is anonymized (header), and
              no chip id, USB serial, address outside the documentation
              ranges, MAC, e-mail, secret, long hex or user name in a
              path is left
SIZE          8 MiB at most: cut the recording around the incident
INDEX         cases/INDEX.md matches the case files
```

Then a person reviews: does the incident read clearly, is the hardware
described well enough to reproduce it, is the expected behavior right,
are the console lines clean.

A simulated recording names no one: its invented addresses and serials
are not privacy problems (e-mails, secrets and user names still are).

---

## WHEN THE ENGINE CHANGES

A case is a promise: this recording, these rules, this diagnosis. When a
rule improves and a case's outcome changes, the test says exactly what
changed; the case is updated in the same pull request as the rule, on
purpose and reviewed, never silently. A recording is never rewritten.

Code: `web/src/core/anonymize.ts`, `web/src/core/library.ts`,
`web/src/cli/hwdog.ts`. Tests: `web/test/anonymize.test.ts`,
`web/test/library.test.ts`, `web/test/cases.test.ts`.
