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
```

The seed cases come from the **simulator** and say so (`origin`:
`SIMULATED`). Cases recorded on real hardware will say `PHYSICAL`.

`web/test/cases.test.ts` checks every case on each commit: the recording
must be the exact file the case names, intact, and must replay through
today's decoder and rules to the stated facts and diagnosis. If a rule
changes the outcome, the test says what changed; the case is updated on
purpose, never silently.

## ADD A CASE

1. Replay the recording in the interface (**SETUP → SESSIONS**).
2. **REPORT → SAVE AS CASE**: saves `HD-C-xxxxxxxx.case.json` and the
   `.hdlog`. Only intact, finalized recordings can become cases.
3. Rename both to the next `HD-C` number (in the file names, and `id` /
   `recording.file` in the JSON), give it a clear `title`, and add them
   here.

Regenerate the seed cases: `npm run cases` in `web/`.

Format: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md#cases).
