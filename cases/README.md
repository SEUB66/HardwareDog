# CASES

Recorded incidents kept as regression tests. Each case is two files:

```text
HD-C002.hdlog        the recording, untouched (SHA-256 sealed)
HD-C002.case.json    the file's SHA-256, and the facts and diagnosis
                     replaying it must produce
```

```text
CASE      FROM                          EXPECTED DIAGNOSIS
HD-C001   simulator HD-T000, 30 s       none (healthy baseline)
HD-C002   simulator HD-T001, 30 s       POWER INSTABILITY, HIGH
HD-C003   simulator HD-T005, 30 s       USB INTERMITTENT, HIGH
HD-C004   simulator HD-T002, 30 s       DHCP FAILURE, HIGH
HD-C005   simulator HD-T003, 30 s       DNS FAILURE, HIGH
HD-C006   simulator HD-T004, 30 s       SERIAL CONFIGURATION MISMATCH, HIGH
HD-C007   simulator HD-T006, 30 s       TARGET RESET LOOP, HIGH
HD-C008   simulator HD-T007, 30 s       NETWORK UNSTABLE, HIGH
HD-C009   simulator HD-T008, 30 s       UPSTREAM FAILURE, HIGH
HD-C010   simulator HD-T009, 30 s       OVERCURRENT, HIGH
HD-C011   simulator HD-T010, 30 s       USB NOT ENUMERATED, HIGH
HD-C012   simulator HD-T011, 30 s       NO NETWORK LINK, HIGH
HD-C013   simulator HD-T012, 30 s       GATEWAY UNREACHABLE, HIGH
HD-C014   simulator HD-T013, 40 s       SUPPLY SAG, MEDIUM (its ceiling)
HD-C015   simulator HD-T014, 45 s       I2C DEVICE DISAPPEARED, HIGH
HD-C016   simulator HD-T015, 30 s       I2C BUS FAULT, HIGH
HD-C017   simulator HD-T016, 45 s       POWER INSTABILITY + NETWORK LOST WITH POWER, HIGH
```

Every diagnosis of the engine has at least one case (checked by
`cases.test.ts`). Physical recordings come from the fault lab
([`docs/FAULT_LAB.md`](../docs/FAULT_LAB.md)).

The seed cases come from the **simulator** and say so (`origin`:
`SIMULATED`). Cases recorded on real hardware will say `PHYSICAL`.

Check them from a terminal, outside the test suite (CI runs it too):

```sh
cd web && npm run test:cases          # = node dist-cli/hwdog.mjs test ../cases
node dist-cli/hwdog.mjs report ../cases/HD-C007.hdlog --format pdf --out c007.pdf
```

`web/test/cases.test.ts` also checks every case on each commit: the recording
must be the exact file the case names, intact, and must replay through
today's decoder and rules to the stated facts and diagnosis. If a rule
changes the outcome, the test says what changed; the case is updated on
purpose, never silently.

## ADD A CASE

1. Replay the recording in the interface (**SETUP → SESSIONS**).
2. **REPORT → SAVE AS CASE**: saves `HD-C-xxxxxxxx.case.json` and the
   `.hdlog`. Only intact, finalized recordings can become cases.
3. Rename both to the next `HD-C` number (in the file names, and `id` /
   `recording.file` in the JSON), give it a clear `title`, fill `context`
   (`description`: what went wrong; `hardware`: boards, cable, supply,
   firmware; `notes`), and add them here.

Write the seed cases that do not exist yet: `npm run cases` in `web/`.
An existing `.hdlog` is never rewritten: it is evidence.

Format: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md#cases).
