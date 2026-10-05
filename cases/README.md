# CASES / THE INCIDENT LIBRARY

Recorded incidents kept as regression tests, on shelves by domain. The
table of contents is [`INDEX.md`](INDEX.md) (generated); how to add an
incident is [`docs/LIBRARY.md`](../docs/LIBRARY.md).

```text
baseline/   power/   usb/   uart/   network/   i2c/
```

Each case is two files on its shelf:

```text
power/HD-C002.hdlog        the recording, untouched (SHA-256 sealed)
power/HD-C002.case.json    its shelf, the incident in words, and the facts
                           and diagnosis replaying it must produce
```

Every diagnosis of the engine has at least one case (checked by
`cases.test.ts`). The seed cases come from the **simulator** and say so
(`origin`: `SIMULATED`); cases recorded on real hardware say `PHYSICAL`
and are anonymized before they are shared. Physical recordings come
from the fault lab ([`docs/FAULT_LAB.md`](../docs/FAULT_LAB.md)) and
from anyone who sends one.

Check them from a terminal, outside the test suite (CI runs it too):

```sh
cd web && npm run test:cases          # = node dist-cli/hwdog.mjs test ../cases
node dist-cli/hwdog.mjs report ../cases/uart/HD-C007.hdlog --format pdf --out c007.pdf
```

`web/test/cases.test.ts` also checks every case on each commit: the recording
must be the exact file the case names, intact, and must replay through
today's decoder and rules to the stated facts and diagnosis. If a rule
changes the outcome, the test says what changed; the case is updated on
purpose, never silently. `web/test/library.test.ts` holds every case to
the library rules (shelf, words, privacy, index).

## ADD A CASE

To the library, for everyone: [`docs/LIBRARY.md`](../docs/LIBRARY.md)
(**REPORT → SHARE WITH THE LIBRARY**: an anonymized copy and its drafted
case).

For your own regression tests only: **REPORT → SAVE AS CASE** saves the
untouched `.hdlog` and its case.

Write the seed cases that do not exist yet: `npm run cases` in `web/`.
An existing `.hdlog` is never rewritten: it is evidence.

Format: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md#cases).
