# EXAMPLE SESSIONS

```text
FILE            SCENARIO   FAULT                          EXPECTED DIAGNOSIS
HD-T000.hdlog   HD-T000    healthy baseline               none
HD-T001.hdlog   HD-T001    USB undervoltage               POWER INSTABILITY
HD-T005.hdlog   HD-T005    intermittent USB disconnect    USB INTERMITTENT
```

Recorded from the built-in **simulator** (30 s each), and labeled so: a
replay says SIMULATOR everywhere, including in exported reports. They are
not measurements of real hardware.

Open one in the interface: **SETUP → SESSIONS → OPEN .HDLOG FILE**.

Format: [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md#session-files-hdlog).

Each file is also a regression test (`web/test/examples.test.ts`): replayed
through today's decoder and rules, it must give the diagnosis its scenario
expects. Regenerate with `npm run examples` in `web/`.
