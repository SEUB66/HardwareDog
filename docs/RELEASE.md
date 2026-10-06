# HARDWARE DOG / 1.0

```text
Hardware Dog 1.0 is a source-available, local-first hardware diagnostic
system that records electrical, protocol and network evidence on one
synchronized timeline and turns real incidents into reproducible
diagnostic cases.
```

That sentence may be said only when every line below reads `[ OK ]`.
Today it may not: the software is ready for the hardware, the hardware
is not built yet. Each line names its evidence; every path cited here
must exist (`web/test/docs.test.ts`).

```text
[ OK ]  done, with the evidence named
[ .. ]  done in software, waiting for a board to confirm it
[ -- ]  not done
```

---

## SOFTWARE

```text
[ OK ] stable HDP v1             protocol/hdp_v1.json; every frame of the simulator and
                                 of the firmware core validates against it:
                                 web/test/protocol-contract.test.ts, web/test/firmware.test.ts;
                                 additions only as optional fields (docs/PROTOCOL.md)
[ OK ] stable HDLOG              v1 to v3 read forever, never rewritten:
                                 web/test/fixtures/hdlog-v1.hdlog, cases/INDEX.md,
                                 web/test/session.test.ts, web/test/pack-hdlog.test.ts
[ OK ] deterministic replay      a replay is the session again, timeline, clocks, facts,
                                 diagnosis: web/test/session.test.ts,
                                 web/test/pack-hdlog.test.ts, web/test/cases.test.ts
[ OK ] evidence integrity        SHA-256 seal chain, MODIFIED on any changed byte, the
                                 file hash in every report: web/src/core/session.ts,
                                 web/test/session.test.ts (no signature yet: docs/SECURITY.md)
[ OK ] diagnostic engine         16 rules, every one with a case that must keep its
                                 diagnosis: web/src/core/diagnostics.ts,
                                 web/test/diagnostics.test.ts, cases/INDEX.md
[ OK ] dogd                      device link, several sources, store, identity, local
                                 API: dogd/src/main.rs, docs/DOGD.md, web/test/dogd.test.ts
[ OK ] session archive           every live session recorded, sealed, recovered after a
                                 crash: web/src/core/archive.ts, web/test/archive.test.ts
[ OK ] professional reports      TXT, JSON, HTML, PDF from the same lines:
                                 web/src/core/report.ts, web/test/reports.test.ts
[ OK ] reproducible build        interface, command line, dogd and firmware image built
                                 twice and compared byte for byte, in CI:
                                 web/scripts/verify-reproducible.mjs,
                                 .github/workflows/dogd.yml, .github/workflows/firmware.yml
[ OK ] security review           threat model, what is done and what is not, reporting;
                                 dogd on the LAN needs a token; CSP on the site:
                                 docs/SECURITY.md, netlify.toml
[ OK ] license + trademark       LICENSE, COMMERCIAL.md, TRADEMARK.md
[ OK ] complete documentation    every document indexed, every link resolved:
                                 docs/README.md, web/test/docs.test.ts
[ OK ] incident library          shelves, anonymize, checks on every pull request:
                                 docs/LIBRARY.md, web/test/library.test.ts
[ .. ] documented measurement    sensor, range, resolution, rate and expected error said
       limits                    with every number: web/src/core/calibration.ts,
                                 web/test/calibration.test.ts; the comparison against a
                                 reference instrument on a board is pending
[ .. ] firmware update           by cable, the calibration kept: docs/FIRMWARE.md;
       procedure                 not yet run on a Hardware Dog
[ .. ] recovery / failed         ROM download mode, always reachable: docs/FIRMWARE.md;
       update path               not yet run on a Hardware Dog
```

## HARDWARE

```text
[ -- ] physical reference        the LVL 60 bring-up on an ESP32-S3 dev board:
       hardware                  docs/FIRMWARE.md (the core passes on a PC and in CI)
[ .. ] power                     INA226, identity verified, errors stated: firmware core
                                 and host build pass; on the board: pending
[ .. ] UART                      lines, framing, resets: core passes; board pending
[ .. ] I2C                       scan, watch, bus faults: core passes; board pending
[ .. ] network                   W5500 / Wi-Fi status and checks: builds in CI; board pending
[ -- ] USB                       this revision has no USB host port: the target's USB is
                                 observed only in the simulator so far
[ -- ] real fault regression     the library holds simulated cases only: the first
       library                   PHYSICAL case comes from the fault lab (docs/FAULT_LAB.md)
[ -- ] custom PCB                LVL 85, after many real hours on the prototype
                                 (docs/ENGINEERING_PLAN.md)
[ -- ] enclosure                 after the PCB
```

---

## THE ORDER FROM HERE

```text
1  LVL 60 bring-up on the board          docs/FIRMWARE.md, steps 1 to 8
2  the fault lab, recorded               docs/FAULT_LAB.md -> PHYSICAL cases
3  measurement against a reference        LVL 65, the calibration flow
4  update and recovery, run on the board  docs/FIRMWARE.md
5  two boards, one bench                 docs/PACK.md
6  many real hours, then the PCB          LVL 85, then the enclosure
7  every line above [ OK ]: 1.0
```

No line moves to `[ OK ]` without its evidence: a recording, a case, a
test, or a photo of the bench, named here.
