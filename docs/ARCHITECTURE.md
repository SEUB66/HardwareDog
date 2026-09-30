# HARDWARE DOG / ARCHITECTURE

```text
STATUS
------

[ OK ] web interface          web/
[ OK ] wire protocol v1       docs/PROTOCOL.md, protocol/hdp_v1.json (contract)
[ OK ] device simulator       web/src/core/simulator.ts
[ -- ] firmware               not started
[ -- ] hardware / PCB         not started
[ -- ] enclosure              not started
```

## DATA FLOW

```text
 ┌──────────────┐   NDJSON    ┌──────────────┐   frames   ┌──────────────┐
 │ HARDWARE DOG │ ──────────> │  TRANSPORT   │ ─────────> │    SYSTEM    │
 │   firmware   │ <────────── │ web serial / │ <───────── │ state + rules│
 └──────────────┘  commands   │  simulator   │  commands  └──────┬───────┘
                              └──────────────┘                   │
                                                  ┌──────────────┼──────────────┐
                                                  v              v              v
                                            ┌──────────┐  ┌─────────────┐ ┌──────────┐
                                            │  TRACE   │  │   SCREENS   │ │ COMMANDS │
                                            │ timeline │  │ GUI panels  │ │  CTRL+K  │
                                            └────┬─────┘  └─────────────┘ └──────────┘
                                                 v
                                            ┌──────────┐
                                            │  REPORT  │  txt / json, local only
                                            └──────────┘
```

## LAYERS

```text
web/src/core/        no UI, no DOM rendering, fully unit tested
  protocol.ts        frame types, validating decoder, line splitter
  transport.ts       Transport interface
  webserial.ts       real device over Web Serial (Chromium)
  simulator.ts       simulated device + simulated target, same protocol
  system.ts          single source of truth, diagnostic rules
  trace.ts           chronological timeline, pause without data loss
  diagnostics.ts     deterministic diagnostic engine, session facts
  scenarios.ts       physical fault scenarios for the simulator
  report.ts          observation / correlation / possible cause
  commands.ts        command layer, calls the same System methods as the GUI
  format.ts          units and timestamps
  ascii.ts           ASCII identity

web/src/ui/          Preact components, one file per screen
web/src/styles/      design tokens (spec 06, 07) and panel styles
```

## RULES OF THE CODEBASE

```text
ONE SOURCE OF TRUTH   The GUI and the command layer never keep their own
                      copy of device state. Both call System.

FRAMES ONLY           Device state changes only when a validated frame
                      arrives. Buttons send commands; they do not edit state.

NO FAKE CERTAINTY     Rules emit OBSERVED facts, CORRELATION in time, and
                      POSSIBLE CAUSE. Nothing is promoted to a diagnosis.

SIMULATOR IS LABELED  Simulated sessions say so in the header, the boot
                      sequence and every exported report. Switching source
                      starts a new session so data never mixes.

LOCAL FIRST           No network requests, no CDN, no account. Fonts are
                      bundled. Settings stay in the browser.

SMALL                 The build must fit on the device flash and be served
                      by the firmware. Check the gzip size on every change.
```

## DIAGNOSTIC RULES

The deterministic engine (`web/src/core/diagnostics.ts`), its 13 rules,
confidence definitions, the 11 fault scenarios and the reliability matrix
are documented in [`DIAGNOSTICS.md`](DIAGNOSTICS.md).
