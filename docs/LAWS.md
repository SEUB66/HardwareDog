# HARDWARE DOG / LAWS OF THE PROJECT

```text
ONE EVENT MODEL.
ONE CLOCK.
ONE TIMELINE.

EVERY REAL FAILURE SHOULD BE ABLE
TO BECOME A REPRODUCIBLE TEST.

LOCAL IS THE SOURCE OF TRUTH.
THE CLOUD IS NEVER REQUIRED.
```

```text
SPECIALIZED TOOLS INVESTIGATE A LAYER.
HARDWARE DOG INVESTIGATES THE INCIDENT.
```

These are architecture boundaries, not preferences. A change that breaks
one of them is a bug, whatever it adds. Where a law can be checked by a
machine, it is: the test is named next to it.

---

## 1 — ONE EVENT MODEL. ONE CLOCK. ONE TIMELINE.

Every producer speaks HDP v1: the firmware, the simulator, a replayed
recording, dogd, any future probe. The trace engine and the rules never
know which one produced an event, and never get a special case for one.

```text
LIVE DEVICE ─────┐
SIMULATOR ───────┤
.HDLOG REPLAY ───┼──> HDP DECODER ──> TRACE ──> RULES ──> DIAGNOSIS
dogd ────────────┤
FUTURE PROBES ───┘
```

```text
ENFORCED BY   web/test/protocol-contract.test.ts   every simulator frame
                                                    validates against
                                                    protocol/hdp_v1.json
              web/test/firmware.test.ts            every firmware frame too
              web/test/session.test.ts             replay == live: same
                                                    timeline, facts,
                                                    diagnoses
```

---

## 2 — EVERY REAL FAILURE SHOULD BE ABLE TO BECOME A REPRODUCIBLE TEST.

A recorded incident (`.hdlog`) can become a case: the untouched recording,
its SHA-256, and the facts and diagnosis replaying it must produce. Cases
run on every commit. A real bug found once makes Hardware Dog better for
good, without special code.

```text
LIVE INCIDENT -> .HDLOG -> CASE -> REGRESSION TEST -> BETTER RULES
```

```text
ENFORCED BY   web/test/cases.test.ts               every case replays to
                                                    what it states
```

---

## 3 — LOCAL IS THE SOURCE OF TRUTH. THE CLOUD IS NEVER REQUIRED.

```text
LOCAL FIRST.
NO ACCOUNT.
NO SUBSCRIPTION.
NO REQUIRED CLOUD.
NO TELEMETRY BY DEFAULT.
NO REMOTE DEPENDENCY.
```

Hardware Dog works **100 % offline** to:

```text
[ X ] capture
[ X ] diagnose
[ X ] record
[ X ] replay
[ X ] export
[ X ] generate reports
[ ] update the firmware          (firmware not written yet: same rule)
[ ] use the personal license     (no license check exists, and none
                                  will ever need a server)
```

The cloud is never a dependency of the product. If remote sharing, a case
library or sync is added one day, it must be:

```text
OPTIONAL
EXPLICIT
USER-CONTROLLED
DISABLEABLE
```

and never:

```text
SIGN IN TO CONTINUE
SUBSCRIBE TO UNLOCK
YOUR SESSION IS IN THE CLOUD
PAY TO EXPORT
LICENSE SERVER UNAVAILABLE
```

**dogd is a local daemon, not an Internet backend.** It listens on the
machine it runs on (127.0.0.1 unless `--listen-lan` is given), stores
sessions on that machine, contains no HTTP client, and works with the
network cable unplugged. It refuses requests that do not name a loopback
host and browser pages from origins it was not told to trust
([`DOGD.md`](DOGD.md)).

```text
ENFORCED BY   web/test/laws.test.ts                the interface source
                                                    makes no network call
                                                    (fetch, XHR, WebSocket,
                                                    beacon, EventSource)
                                                    and loads nothing
                                                    remote; only dogd.ts
                                                    talks, to 127.0.0.1
              dogd/src/config.rs, dogd/src/api     loopback by default,
                                                    host + origin guard
```

Hosting the interface on a web server (a demo site, the device itself) is
distribution, not dependency: once loaded, it never calls home.

---

## 4 — NO FAKE CERTAINTY

A diagnosis is OBSERVED facts, a CORRELATION in time, a POSSIBLE CAUSE with
a CONFIDENCE, and a NEXT CHECK. Never "the problem is definitely X".

Measurements are diagnostic, not certified metrology. Hardware Dog says
what its numbers are worth, and does not pretend to be a lab instrument.

---

## 5 — EVIDENCE STAYS EVIDENCE

A recording is sealed (SHA-256 chain + footer). Its origin, PHYSICAL or
SIMULATED, is set once and never rewritten. A modified file is still
shown, and labeled MODIFIED. A simulated session is labeled SIMULATED in
every screen and every export. Format: [`PROTOCOL.md`](PROTOCOL.md).
