# HARDWARE DOG / PACK

```text
SEVERAL DOGS. ONE TIMELINE. ONE CLOCK.
```

LVL 90 turns Hardware Dog from a box into a platform: a POWER DOG on the
supply, a USB DOG on the cable, a NET DOG on the switch, later a CAN DOG or
an RS-485 DOG. Each one is a probe that simply produces HDP v1. Together
they are a **pack**, watching one incident.

The laws still hold: one event model (every Dog speaks HDP v1), one clock,
one timeline, and the rules never know which Dog spoke.

Code: `web/src/core/pack.ts` (clocks and merge, pure),
`web/src/core/session.ts` (hdlog v3, a pack recorded and replayed),
`web/src/core/system.ts` (the pack in the System),
`web/src/core/transport.ts` (`PackTransport`),
`web/src/core/simpack.ts` (a simulated pack),
`web/src/core/dogd.ts` (a pack through dogd: one stream per Dog),
`web/src/core/packbuilder.ts` (a pack of boards on USB, built by hand),
`web/src/ui/components/PackPanel.tsx` (the pack on screen).

---

## IN THE INTERFACE

```text
BUILD A PACK   CONNECT DOGD           dogd with several --source: one Dog each
               SETUP > ADD A PORT     boards on USB, one port per click (the
                                      browser asks every time), START PACK
               SETUP > DEMO PACK      three simulated Dogs, labeled SIMULATED
SEE IT         STATUS > PACK          every Dog: who it is, its link (WAITING,
                                      ONLINE, LOST), what it observes (and what
                                      it was refused), its clock (+-ms, or
                                      UNBOUNDED before its first time sample)
               header                 DEVICE 3 DOGS, VIA PACK OF 3
               REPORT                 a PACK section, in every format
               TOUR                   a stop on the pack
```

---

## WHAT A PACK IS

```text
D1  HD-P0WER   power                 a Dog on the supply
D2  HD-TARGET  usb uart i2c          a Dog on the target
D3  HD-NET     net probe             a Dog on the network
```

Each Dog has a fixed place in the pack (D1, D2...) and its own link: Web
Serial, dogd, the simulator. Every frame and every command is tagged with
its Dog.

**One source of truth per signal.** Each capability is observed by one
Dog only: the first one to claim it in its `hello.caps`. A second Dog that
claims the same capability is told so on the timeline, and its frames for
it are ignored and counted. That is why the rules need no change: there is
still one supply, one USB link and one network, and each has one source.

Commands go to the Dog that observes them: `i2c.scan` goes to the I2C Dog,
`hello` goes to every Dog, `time` goes to one. A command no Dog can carry
out is refused with a reason ("no Dog of the pack observes net").

---

## ONE CLOCK

Every Dog counts time from its own boot. Each one is mapped onto the host
clock, and the error of that mapping is known and kept.

```text
hello          provisional: host = arrival - t. The link latency is not
               known, so the error is UNBOUNDED.
time sample    the host sends {"cmd":"time","id":n} at h0 and gets
               {"type":"time","t":T,"id":n} at h1. The Dog read T between
               h0 and h1:  offset = (h0 + h1) / 2 - T,  error = (h1 - h0) / 2.
drift          crystals drift. A sample's error grows by 100 ppm per ms
               away from it (0.1 ms per second, 6 ms per minute). The
               sample with the smallest error at that moment is used.
resampling     right after each hello, then every 10 s.
reboot         a new hello voids the Dog's samples: its clock started again.
```

Within one Dog, the order of its own frames is the truth: a better sample
never moves one of its frames before an earlier one.

Over a USB serial link the round trip is a few milliseconds: the Dogs agree
to a few milliseconds. Over a busy Wi-Fi link it can be hundreds.

---

## ONE TIMELINE

Links differ. A USB detach can arrive before the voltage drop that caused
it, because the supply Dog's link is slower. So a frame goes on the
timeline only once every other live Dog has spoken past it, or 500 ms after
it at the latest (a silent Dog does not hold the others for long; a lost
Dog not at all).

Frames are released only when a frame arrives, never on a timer. A replay
feeds the same arrivals at the same moments, so it releases the same
frames in the same order: the replay is the session again.

Frame numbers (what diagnoses cite as evidence) are given **on arrival**:
the frame's place in the stream, as recorded.

---

## NO FAKE CERTAINTY ACROSS CLOCKS

Some diagnoses compare times from different domains: a USB disconnect
against a voltage drop, a network loss against a drop or a target reset,
an I2C device lost against a drop. In a pack those may come from two
clocks. Every fact carries the clock it was read on and that clock's
error, and a comparison across clocks uses the sum of the two errors as a
margin, either way:

```text
IN         certainly inside the window             counted as correlated
OUT        certainly outside                       counted as not
UNKNOWN    the margin cannot tell                  neither: said as it is
```

A disconnect that cannot be placed is neither explained by the supply nor
blamed on USB. The diagnosis says how many there were and how well the
clocks agree:

```text
2 disconnect(s) could not be placed against the drops: the probes' clocks
are aligned to +-175 ms, too coarse for the 100 ms window.
```

Within one clock nothing changes: comparisons are exact, as before packs.

---

## THE GATE

```text
SIMULATED PACK == ONE DEVICE   PASS  every scenario (HD-T000 to HD-T016),
                                     three Dogs with clocks hours apart and
                                     1-6 ms links: the same diagnoses and
                                     confidences (web/test/pack-system.test.ts)
CLOCKS                         PASS  every Dog sampled after hello and every
                                     10 s, aligned to a few ms
SLOW LINK, STILL CERTAIN       PASS  40-60 ms: the drops start long before
                                     the disconnects, the correlation holds
SLOW LINK, UNDETERMINED        PASS  150-200 ms: no POWER INSTABILITY, no
                                     INTERMITTENT USB; said as undetermined
ONE SOURCE PER SIGNAL          PASS  a second claim is refused, said once
COMMANDS ROUTED                PASS  to the Dog that observes them
A DOG DROPS OUT                PASS  the pack goes on; its signals NO SIGNAL
CONTRACT                       PASS  every pack frame (time included)
                                     validates protocol/hdp_v1.json
FIRMWARE                       PASS  the core answers time (C tests, host
                                     build in firmware.test.ts)
ONE DEVICE UNCHANGED           PASS  every earlier test and case, same result
RECORDED (hdlog v3)            PASS  the Dogs in the header, one on every
                                     line, every time command before its
                                     answer (PROTOCOL.md, a pack)
REPLAY == SESSION              PASS  same timeline (times included), clocks,
                                     facts and diagnosis (pack-hdlog.test.ts)
A PACK IS A CASE               PASS  HD-C018: the router incident (HD-T016)
                                     seen by three Dogs; same facts and
                                     diagnosis as HD-C017, one Dog
DOGD STORES IT                 PASS  dogd verifies a v3 file like a v2 one
DOGD, SEVERAL SOURCES          PASS  one link per --source, D1..D8, each on
                                     its own stream (/v1/hdp/D2), bridged
                                     unchanged; CONNECT DOGD opens the pack
A DOG SAYS WHAT IT OBSERVES    PASS  the firmware core sends frames only for
                                     its caps, rejects commands for others
                                     (C tests; hwdog-host --caps)
TWO FIRMWARES, ONE PACK        PASS  two firmware processes (supply: power
                                     uart i2c; network: net probe) through
                                     one dogd, in real time: the router
                                     chain on one timeline, clocks to a few
                                     ms, the same diagnosis as one board,
                                     recorded and replayed the same
                                     (firmware.test.ts)
THE INTERFACE SHOWS IT         PASS  the PACK panel, the header, the report
                                     (pack-ui.test.ts); built from dogd, from
                                     boards on USB, or as a demo; checked in
                                     Chromium on a desktop and a phone
ONE READING PER ARRIVAL        PASS  the time a frame is recorded at is the
                                     time it is handled at, so the replay
                                     agrees to the last digit (found with
                                     the real-time test; pack-hdlog.test.ts)
```

---

## NOT YET

```text
[ -- ] two real boards on one bench, recorded as a PHYSICAL case
[ -- ] new probe kinds (CAN, RS-485, GPIO, environment): each is new HDP
       frames for a new capability, under the same pack
[ -- ] the target's state seen by two Dogs at once ("current drawn while
       no USB device") is compared frame by frame, without a clock margin;
       the effect is a few ms on a duration measured in seconds
```
