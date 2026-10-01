# HARDWARE DOG / MARKET POSITIONING

```text
THEY GO DEEPER.
HARDWARE DOG GOES WIDER.
```

---

## THE PROBLEM IS FRAGMENTATION

Hardware troubleshooting rarely happens inside one layer.

A device can appear to have a USB problem when the real cause is power.
A network failure can actually begin with a firmware reboot.
A serial error can happen at the same moment as an electrical event.

Today, those signals are usually observed through separate tools:

```text
POWER
USB
SERIAL
EMBEDDED BUS
NETWORK
SYSTEM LOGS
```

Each tool may be excellent at its own job.
The problem is that the evidence is fragmented.

Hardware Dog is built around a different question:

> **What happened across the system at the same time?**

---

## HORIZONTAL, NOT VERTICAL

Most diagnostic instruments are vertically specialized.

```text
POWER PROFILERS     go very deep into electrical measurement
LOGIC ANALYZERS     go very deep into digital signals
USB ANALYZERS       go very deep into USB traffic
NETWORK TOOLS       go very deep into network diagnostics
```

Hardware Dog intentionally does not try to replace them.

Hardware Dog takes the horizontal layer:

```text
                 ONE CLOCK
                     │
     ┌───────────────┼───────────────┐
     │               │               │
   POWER            USB            SERIAL
     │               │               │
     ├───────────────┼───────────────┤
     │               │               │
    I2C            NETWORK         SYSTEM
     │               │               │
     └───────────────┼───────────────┘
                     │
                ONE TIMELINE
                     │
                CORRELATION
                     │
                 DIAGNOSIS
```

The product is not defined by how deeply it measures one signal.
It is defined by how well it connects evidence from multiple signals.

---

## WHAT HARDWARE DOG IS NOT

```text
[ NO ] a calibrated laboratory multimeter
[ NO ] an oscilloscope replacement
[ NO ] a precision power profiler
[ NO ] a full USB packet analyzer
[ NO ] a high-speed logic analyzer
[ NO ] a certification instrument
[ NO ] a replacement for specialized RF equipment
```

When one of those tools is required, use one.
Hardware Dog should never pretend otherwise.

---

## WHAT HARDWARE DOG IS

Hardware Dog is a general-purpose diagnostic companion.

Its job is to:

```text
CAPTURE
CORRELATE
REPLAY
DIAGNOSE
EXPLAIN
```

across multiple layers of a hardware system.

Its core value is not maximum measurement precision.
Its core value is **context**.

---

## SPECIALIZED TOOLS VS HARDWARE DOG

A specialized power profiler may tell me exactly how much current a device
consumed.

Hardware Dog should help me see:

```text
POWER DROP
    ↓ 42 ms
USB RESET
    ↓ 118 ms
SERIAL BOOT MESSAGE
    ↓
NETWORK DISCONNECTED
```

That is a different product.

The specialized instrument answers:

> What happened electrically?

Hardware Dog answers:

> What happened to the system?

---

## THE PRODUCT LAW

```text
ONE EVENT MODEL.
ONE CLOCK.
ONE TIMELINE.
```

Every data source becomes evidence on the same timeline.

Whether the source is:

```text
real hardware
Web Serial
dogd
the simulator
a future probe
a replayed trace
```

the trace engine receives the same HDP event model.

That architectural rule is also the product strategy.

---

## WHY THIS MATTERS

Hardware failures are often misdiagnosed because the visible symptom occurs
in a different layer from the actual cause.

Examples:

```text
SYMPTOM                    CAUSE
USB failure                ← power instability
network failure            ← device reboot
firmware crash             ← electrical event
bad sensor                 ← bus instability
intermittent peripheral    ← connector / voltage / enumeration sequence
```

A tool that only sees one layer can accurately describe the symptom while
missing the chain of events around it.

Hardware Dog is designed to preserve that chain.

---

## POSITIONING

Hardware Dog does not compete by saying:

> "We measure power better than a power profiler."

or:

> "We analyze USB better than a dedicated USB analyzer."

The position is:

> **Specialized tools investigate a layer.
> Hardware Dog investigates the incident.**

---

## SEND ME THE INCIDENT

A specialized instrument produces a measurement. Hardware Dog produces an
incident that travels:

```text
TECHNICIAN A                         TECHNICIAN B
captures a weird failure    ──>      opens fault-0147.hdlog
                                     same frames, same rejects,
                                     same thresholds, same trace,
                                     same facts, same diagnosis
```

No hardware to ship. No screen recording. No "it was doing it earlier".
The file says where it comes from (real hardware or simulator) and whether
a single byte changed since it was recorded.

```text
DON'T SEND ME A SCREENSHOT.
SEND ME THE .HDLOG.
```

---

## WHEN TO USE HARDWARE DOG

Use Hardware Dog early in troubleshooting.

When I do not yet know whether the problem is:

```text
POWER
USB
SERIAL
BUS
NETWORK
FIRMWARE
```

Hardware Dog helps narrow the search.

Once the problem requires deep analysis of one specific layer, a specialized
instrument can take over.

Hardware Dog therefore belongs near the beginning of the diagnostic
workflow rather than replacing every instrument at the end of it.

---

## MARKET PHILOSOPHY

I am not trying to recreate a $1,000+ laboratory instrument for free.

I am trying to make useful system-level diagnostic capability accessible
to people who currently troubleshoot with a pile of disconnected tools.

```text
GARAGE HACKERS
REPAIR TECHNICIANS
EMBEDDED DEVELOPERS
MAKERS
STUDENTS
SMALL LABS
```

The goal is not cheaper metrology.
The goal is better visibility.

---

## THE SHORT VERSION

```text
They go deeper.
Hardware Dog goes wider.

They measure the signal.
Hardware Dog connects the evidence.

They investigate the layer.
```

**Hardware Dog investigates what happened.**
