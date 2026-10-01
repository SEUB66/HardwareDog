# HARDWARE DOG / DIAGNOSTICS

```text
ENGINE       deterministic, no AI           web/src/core/diagnostics.ts
SCENARIOS    11 physical fault scenarios    web/src/core/scenarios.ts
PROOF        reliability matrix             web/test/scenarios.test.ts
RULE TESTS   threshold / precedence tests   web/test/diagnostics.test.ts
CASES        recorded incidents             cases/, web/test/cases.test.ts
RULESET      version 1                      RULESET_VERSION, diagnostics.ts
```

Hardware Dog does not guess. Every diagnosis comes from a written rule,
every confidence level has a written definition, and every rule is
exercised against simulated faults on every commit.

The ruleset has a version. It is bumped whenever a rule, a default
threshold or a confidence definition changes. Every recording carries the
version it was made with, and a replay on other rules says so in the
report ("recorded v1, diagnosed v2"). Cases pin the expected outcome: a
rule change that alters one fails the test until the case is updated on
purpose.

---

## PIPELINE

```text
FRAMES (HDP) -> SESSION FACTS -> RULES -> DIAGNOSES -> TRACE + STATUS + REPORT
```

**Session facts** are a structured record the System keeps as frames
arrive: undervoltage events, current spikes, USB attaches and detaches
(with the target current 100 ms after each detach), time spent powered
without USB, UART resets and framing errors per baud rate, and the last 30
network reports. The engine reads facts, never the trace (the operator can
clear the trace) and never the simulator scenario.

The engine runs every second of device time. Every new diagnosis, every
confidence change and every cleared diagnosis is written to the timeline
as a `RULE` event.

## OUTPUT

Each diagnosis keeps the four levels of design principle 37 apart:

```text
OBSERVED         measured facts, with times and counts
CORRELATION      facts that line up in time, with a ratio
POSSIBLE CAUSE   a hypothesis, never stated as a fact
NEXT CHECK       what to measure to confirm or reject it
CONFIDENCE       HIGH / MEDIUM / LOW, with its basis in plain numbers
```

---

## RULES

```text
ID                              FIRES WHEN                                         CONFIDENCE
POWER_INSTABILITY               >= 1 USB disconnect within the correlation         HIGH   >= 3 correlated and >= 80 %
                                window (100 ms) after a sample below the           MEDIUM >= 2 correlated and >= 50 %
                                undervoltage threshold (4.75 V)                    LOW    otherwise
SUPPLY_SAG                      undervoltage events, none followed by a            MEDIUM >= 3 drops
                                disconnect                                         LOW    otherwise
OVERCURRENT                     current above the limit (0.9 A)                    HIGH >= 3 / MEDIUM 2 / LOW 1 event
USB_INTERMITTENT                >= 2 disconnects the supply does not explain       HIGH >= 3 / MEDIUM 2
USB_NOT_ENUMERATED              target draws >= 50 mA for >= 3 s with no USB       HIGH  >= 10 s and never enumerated
                                device                                             MEDIUM otherwise
TARGET_RESET_LOOP               >= 2 target resets that are not power-on or        HIGH >= 3 / MEDIUM 2
                                brownout (ESP-IDF "rst:0x.. (REASON)")
SERIAL_CONFIGURATION_MISMATCH   >= 3 framing errors at the current baud, on        HIGH  >= 5 errors and >= 80 %
                                >= 30 % of lines, last one < 15 s ago              MEDIUM otherwise
NO_LINK / DHCP_FAILURE /        the LOWEST failing layer of the latest report      HIGH >= 3 consecutive reports
GATEWAY_UNREACHABLE /           (link > dhcp > gateway > internet > dns)           MEDIUM 2 / LOW 1
UPSTREAM_FAILURE / DNS_FAILURE
NETWORK_UNSTABLE                every layer passes, last >= 5 reports:             HIGH  both
                                latency swings >= 100 ms and reaches 150 ms,       MEDIUM one
                                and / or average loss >= 2 %
```

Precedence rules that prevent double counting:

```text
[X] a disconnect explained by a drop counts for POWER_INSTABILITY only
[X] power-on and brownout resets are power evidence, not a reset loop
[X] framing errors are judged per baud rate: changing the rate starts over
[X] only the lowest failing network layer is reported: no DNS failure when
    the Internet is down beyond the gateway (that is UPSTREAM_FAILURE)
[X] DNS_FAILURE is capped at MEDIUM when the Internet check is not PASS
```

---

## FAULT SCENARIOS

A scenario describes a **physical** situation (supply, cable, firmware,
network). The simulator turns it into HDP frames only.

```text
ID        SCENARIO                      PHYSICAL FAULT                                  EXPECTED
HD-T000   HEALTHY BASELINE              nothing                                         (none)
HD-T001   USB UNDERVOLTAGE              thin cable, load bursts brown the target out    POWER_INSTABILITY
HD-T002   DHCP FAILURE                  link up, no DHCP server answers                 DHCP_FAILURE
HD-T003   DNS FAILURE                   DNS server silent, Internet reachable by IP     DNS_FAILURE
HD-T004   SERIAL FRAMING MISMATCH       target UART at 9600, monitor at 115200          SERIAL_CONFIGURATION_MISMATCH
HD-T005   INTERMITTENT USB DISCONNECT   worn connector, supply solid                    USB_INTERMITTENT
HD-T006   TARGET RESET LOOP             firmware hang, task watchdog reboots            TARGET_RESET_LOOP
HD-T007   UNSTABLE NETWORK              weak Wi-Fi: latency swings, packet loss         NETWORK_UNSTABLE
HD-T008   UPSTREAM DOWN                 LAN fine, Internet beyond the gateway down      UPSTREAM_FAILURE
HD-T009   OVERCURRENT                   stalled motor spikes > 1 A on a stiff supply    OVERCURRENT
HD-T010   USB NOT ENUMERATED            powered, never enumerates (charge-only cable)   USB_NOT_ENUMERATED
```

Run one:

```sh
cd web && npm run demo          # then SETUP -> SIMULATOR SCENARIO
```

or open `?scenario=HD-T004`, or type `sim HD-T004` in the command palette
(CTRL+K).

---

## RELIABILITY

```text
TEST                                         REQUIREMENT
reliability matrix                           11 scenarios x 5 seeds x 90 s: EXACTLY the expected
                                             diagnoses, no false negative, no false positive
confidence                                   every fault reaches HIGH within 90 s
detection time                               every fault diagnosed within 30 s (3 seeds)
endurance                                    HD-T000 silent for 10 min (3 seeds), no RULE event
drift                                        every scenario for 5 min: still exactly as expected
recovery                                     HD-T004: set 9600 baud -> diagnosis clears
protocol                                     0 frame errors in every run
```

Measured detection times, seconds of session time (median / worst of 5 seeds):

```text
ID        DIAGNOSIS                        FIRST REPORTED   REACHES HIGH
HD-T001   POWER_INSTABILITY                 9.0 /  9.0      27.0 / 29.0
HD-T002   DHCP_FAILURE                      1.0 /  1.0       5.0 /  5.0
HD-T003   DNS_FAILURE                       1.0 /  1.0       5.0 /  5.0
HD-T004   SERIAL_CONFIGURATION_MISMATCH     1.0 /  1.0       1.0 /  1.0
HD-T005   USB_INTERMITTENT                 15.0 / 17.0      23.0 / 24.0
HD-T006   TARGET_RESET_LOOP                15.0 / 15.0      20.0 / 22.0
HD-T007   NETWORK_UNSTABLE                  9.0 /  9.0       9.0 /  9.0
HD-T008   UPSTREAM_FAILURE                  1.0 /  1.0       5.0 /  5.0
HD-T009   OVERCURRENT                       7.0 /  7.0      17.0 / 18.0
HD-T010   USB_NOT_ENUMERATED                4.0 /  4.0      11.0 / 11.0
```

Times are bounded by the physics of each scenario (a fault that happens
every 7 s cannot be HIGH before it happened three times) and by the
network report period (2 s).

## LIMITS, STATED

```text
[!] The matrix proves the rules on simulated physics. Physical test
    scenarios (real cable, real ESP32, real network cut) come with the
    firmware (docs/ENGINEERING_PLAN.md section 26).
[!] Thresholds are defaults. They are editable on SETUP and apply to new
    samples only.
[!] A diagnosis is a hypothesis ranked by evidence, not a verdict.
```
