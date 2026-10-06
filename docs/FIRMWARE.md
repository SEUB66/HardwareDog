# HARDWARE DOG / FIRMWARE

```text
TARGET        ESP32-S3 dev board (ESP32-S3-DevKitC-1 or equivalent)
SENSOR        INA226 breakout (R100 shunt), I2C
SDK           ESP-IDF v5.4, C11
HDP LINK      native USB (USB-Serial-JTAG), 303A:1001
STATUS        LVL 60-80: core verified on a PC and in CI, ESP32-S3 builds
              in CI (Wi-Fi, and W5500 + I2C watch), SILICON BRING-UP
              PENDING (needs the board on a desk)
```

The firmware is a producer of HDP v1, like the simulator. Nothing else.
The interface, the trace engine and dogd do not change for it.

```text
REALITY -> firmware -> HDP v1 -> (Web Serial | dogd) -> same decoder
        -> same trace -> same diagnosis
```

---

## WHAT IS VERIFIED, AND WHERE

No claim without the test that backs it.

```text
                                       PC      CI      BOARD
core: HDP frames, commands, UART       PASS    PASS    pending
  lines, I2C scan, INA226 driver math
every frame validates hdp_v1.json      PASS    PASS    pending
engine reads it like the simulator     PASS    PASS    pending
firmware -> TCP -> dogd == direct      PASS    PASS    --
ESP-IDF build for esp32s3              --      CI      --
  (default, and W5500 + I2C watch)
I2C watch, bus faults, net checks,     PASS    PASS    pending
  background probes (host simulation)
W5500 link, real ping / DNS / TCP      --      --      pending
I2C timing, real INA226, UART pins,    --      --      pending
  USB link, Wi-Fi
measurement accuracy                   --      --      LVL 65
```

"PC" is the core built natively (`firmware/host`) against a board
simulated at the register level: the INA226 model computes the current
register the way the chip does (shunt register x calibration / 2048), so
the driver math is really exercised. It is a test fixture, not the device.

---

## WIRED NETWORK PORT (LVL 80, optional)

`idf.py menuconfig` -> Hardware Dog -> W5500 Ethernet. The wired port wins
over Wi-Fi when both are configured.

```text
ESP32-S3            W5500 module (3.3 V)
3V3        ──────── 3V3
GND        ──────── GND
GPIO 12    ──────── SCLK
GPIO 11    ──────── MOSI
GPIO 13    ──────── MISO
GPIO 10    ──────── CS
GPIO 14    ──────── INT     (-1 in menuconfig: not wired, polled)
GPIO 21    ──────── RST     (-1: not wired)
```

Plug the W5500 into the network the incident is about, e.g. into the
router the target powers: when the router reboots with the supply, the
link loss, DHCP and DNS are on the same timeline as the voltage drop.

---

## LAYOUT

```text
firmware/
├── components/hdp/        THE CORE, portable C11, no ESP-IDF
│   ├── include/hdp/hdp.h  HAL interface, config, capabilities
│   └── hdp.c              HDP writer, command parser, INA226 driver
├── main/main.c            ESP-IDF glue: I2C, UART, USB, Wi-Fi
├── main/Kconfig.projbuild pins, shunt, Wi-Fi (menuconfig)
├── sdkconfig.defaults     logs on UART0, never on the HDP link
└── host/                  the core on a PC
    ├── host_main.c        hwdog-host: simulated board, stdout or TCP
    └── tests.c            unit tests (AddressSanitizer + UBSan)
```

---

## WIRING (defaults, change in menuconfig)

```text
ESP32-S3            INA226 breakout
3V3        ──────── VCC
GND        ──────── GND
GPIO 8     ──────── SDA
GPIO 9     ──────── SCL
                    VIN+  ── supply side (e.g. 5 V from the charger)
                    VIN-  ── target side (the device under test)

ESP32-S3            TARGET
GPIO 18 (RX) ────── target TX      (3.3 V logic only)
GPIO 17 (TX) ────── target RX
GPIO 4  (SDA) ───── target I2C SDA (target pull-ups)
GPIO 5  (SCL) ───── target I2C SCL
GND        ──────── target GND     (always)
```

**The ESP32-S3 pins are 3.3 V.** A 5 V target UART needs a level shifter.
The INA226 measures the target rail up to 36 V; its own supply is 3.3 V.
Default full scale: 0.8 A with a 0.1 ohm shunt (81.92 mV max across it).
For more current, a smaller shunt and `HWDOG_SHUNT_MOHM` /
`HWDOG_MAX_CURRENT_MA`.

---

## WHAT THIS REVISION OBSERVES

The device says it in `hello.caps` (PROTOCOL.md):

```text
power   YES   INA226, identity verified (manufacturer 0x5449, die 0x226)
uart    YES   lines, framing / parity / overrun / break errors
i2c     YES   address scan 0x08-0x77 on request, or every N ms (i2c.watch,
              or HWDOG_I2C_WATCH_MS from boot); a line stuck low or a bus
              timeout is an i2c.error, never an empty scan; no identity
              claimed
net     WITH W5500 OR WI-FI CONFIGURED: link, address, DHCP, sent at once
              when they change. Gateway, DNS, Internet, latency, loss only
              from net.watch checks (ping, resolve, TCP 443), else UNKNOWN
usb     NO    the dev board has no USB host port wired for the target
probe   WITH A NETWORK: PING (ICMP x4), DNS (resolve), TCP (port 80),
              HTTP (GET /, status line), in a background task
```

A floating line (no pull-up at all) can read high as well as low: a stuck
low line is certain, a floating one is not always seen. The scan then
finds nothing, or a device that comes and goes.

Because `usb` is not declared, the engine makes **no** USB diagnosis from
silence (ruleset v2). A target drawing current is not "not enumerated" just
because nobody is watching its USB.

The INA226 is identified before any number is published. Not answering, or
answering with another identity, gives a `log` error and **no** power
frames: never a made-up value.

---

## BUILD AND FLASH

```sh
cd firmware
idf.py set-target esp32s3
idf.py menuconfig            # optional: Hardware Dog -> Wi-Fi, pins, shunt
idf.py build
idf.py -p /dev/ttyUSB0 flash # the UART port of the dev board
```

The Wi-Fi password, if set, stays in your local `sdkconfig` (ignored by
git). Never commit it.

The core on a PC, no board needed:

```sh
cmake -S firmware/host -B firmware/host/build && cmake --build firmware/host/build
ctest --test-dir firmware/host/build
firmware/host/build/hwdog-host --fast --scenario sag --seconds 30
```

`--chip 7cdfa13a1f2c` gives the simulated board a factory id for its
hello (a board knows its own; a simulation is given one or sends none).
With `--fast` and commands piped on stdin, every command is read at t=0
before device time runs: a scripted run never races its script.

`--caps power,uart,i2c` makes the process one Dog of a pack: it declares
and observes only those (the core sends no frame for anything else, and
rejects commands for it); `--device HD-P0WER` names it. Two processes
through one dogd are a pack on a PC (web/test/firmware.test.ts, LVL 90.3).
Each plays the same scripted incident from its own start: that proves the
links, the clocks and the merge, not shared physics, which takes two
boards on one bench.

---

## UPDATE

There is no over-the-air update: a Hardware Dog is updated on the bench,
by cable, by the person who owns it. Nothing reaches the board by itself.

```sh
cd firmware && git pull
idf.py build
idf.py -p PORT app-flash      # the application only: the calibration stays
```

`app-flash` writes the application partition only. The calibration lives
in NVS and survives it; `idf.py flash` also rewrites the bootloader and
the partition table, and survives it as well unless the partition table
changed. **`erase-flash` removes the calibration**: write the calibration
points down (METER in the interface) before using it.

After an update the interface shows the new version at the next hello
(`DEVICE` / `FIRMWARE`), and every recording names the firmware that
produced it, so no session ever mixes two versions without saying so.

The image is reproducible (`CONFIG_APP_REPRODUCIBLE_BUILD`): the same
sources give the same bytes, checked in CI by building twice. Anyone can
check that a published image is what the code builds:
`sha256sum build/hwdog.bin`.

## RECOVERY (a failed update)

An ESP32-S3 cannot be bricked by a bad application: the first bootloader
is in mask ROM and always answers in download mode.

```text
1  Hold BOOT (GPIO0), press and release RESET, release BOOT.
   The board is now in ROM download mode, whatever was flashed.
2  idf.py -p PORT flash          the known good build (git checkout <tag>)
3  If the board still does not boot: idf.py -p PORT erase-flash, then
   idf.py -p PORT flash. The calibration is lost: calibrate again.
4  Press RESET. The interface must show the hello of the version flashed.
```

The UART port of the dev board (CP2102 / CH343) is the most reliable for
recovery: it does not depend on the firmware's USB stack.

```text
[ -- ] update and recovery procedures, checked on the board    LVL 60 bring-up
```

These steps follow the ESP-IDF tools and the ESP32-S3 boot ROM. They are
**not yet verified on a Hardware Dog**: that is part of the bring-up.

---

## BRING-UP ON THE BOARD (the LVL 60 gate)

This is the part a computer cannot do for us. Each step has the result to
expect; a different result is a finding, not a failure to hide.

```text
[ ] 1  FLASH       idf.py flash, then plug the NATIVE USB port.
[ ] 2  IDENTIFY    dogd devices --identify
                   expect: HARDWARE DOG HD-xxxxxx rev DEVKIT-S3 fw 0.1.0 hdp v1
                   (the ROM may print its boot banner on USB at reset: those
                   2-3 lines are not HDP, the interface rejects and counts them)
[ ] 3  NO SENSOR   INA226 unplugged. Interface: SETUP -> CONNECT DOGD
                   (dogd --source serial:PORT) or CONNECT WEB SERIAL.
                   expect: timeline "INA226 not answering at 0x40", no power
[ ] 4  POWER       INA226 wired, target powered through it.
                   expect: power frames at 50 Hz, voltage within the declared
                   error (POWER -> MEASUREMENT) of a multimeter on VIN-.
                   3 points with `meter point` (no load, ~100 mA, ~500 mA),
                   then `meter cal "<multimeter>"`: CALIBRATION survives a
                   reboot. These points seed the LVL 65 gate.
[ ] 5  UART        target TX on GPIO 18. expect: its lines on SERIAL.
                   Set a wrong baud: expect framing errors, then
                   SERIAL CONFIGURATION MISMATCH.
[ ] 6  I2C         a known sensor on the target bus, PROBE -> I2C scan.
                   expect: its address listed, no identity claimed.
[ ] 7  RECORD      a 10 min session, SAVE .HDLOG, replay it.
                   expect: VERIFIED, origin PHYSICAL, same diagnosis replayed.
[ ] 8  HD-P001     a resistive cable (long, thin) between supply and target,
                   target under load. expect: undervoltage events, SUPPLY SAG.

LVL 80, on the same bench:

[ ] 9  I2C WATCH   i2c watch 5 in the palette, a sensor on the target bus.
                   Pull its SDA wire for 10 s, twice.
                   expect: "0x76 no longer answers" / "answers", then
                   I2C DEVICE DISAPPEARED, HIGH.
[ ] 10 PULL-UPS    remove the target bus pull-ups (keep the device).
                   expect: i2c.error SDA_LOW or SCL_LOW, I2C BUS FAULT; no
                   empty scan. If the lines float high instead, write it in
                   the notes: that is what the board does.
[ ] 11 NET WATCH   W5500 (or Wi-Fi) up, net watch 10 example.com in the
                   palette. expect: gateway, DNS PASS with latency.
                   Unplug the cable 20 s: link down, then link, DHCP, DNS
                   back, timed in NET -> OUTAGES.
[ ] 12 ROUTER      power a USB travel router through the INA226 and a thin
                   cable, W5500 plugged into it. Load the rail.
                   expect: NETWORK LOST WITH POWER, the chain drop > link
                   down > up > DHCP > DNS. The recording becomes a PHYSICAL
                   case.
```

When 1 to 7 pass, LVL 60 is done. The recording of step 8 becomes the first
**PHYSICAL** case (the next free `HD-Cxxx`, on its shelf: [`LIBRARY.md`](LIBRARY.md)): send the `.hdlog`. The
other faults to record are in [`FAULT_LAB.md`](FAULT_LAB.md).

---

## CALIBRATION (LVL 65)

The firmware declares what its numbers are worth (`power.meter`): the
INA226 datasheet worst case until the board is calibrated against a
reference instrument. Out of the box, with a 1 % R100 shunt:

```text
VOLTAGE   +-0.1 % + 8.75 mV     (5 V rail: +-13.8 mV)
CURRENT   +-1.1 % + 0.12 mA     (300 mA: +-3.4 mA)   the shunt tolerance dominates
```

Calibrating, from the command palette (CTRL+K), with a multimeter on the
same rail and the same load:

```text
meter                         what the numbers are worth now
meter point 5.012 2.1         no load: what the multimeter reads (V, mA)
meter point 4.981 101.4       ~100 mA load
meter point 4.874 498.0       ~500 mA load
meter cal "Fluke 87V"         fit, store on the device (NVS), declare
meter clear                   back to datasheet accuracy
```

Each point averages the last second of samples, taken before any stored
calibration. Voltage: one gain. Current: gain and offset when the points
span 50 mA or more. The device stores the largest residual seen and
declares it as its accuracy, with the date and the reference named.
Disagreement above 10 % is refused: that is a wiring fault, not a
calibration.

**What this is not:** traceable metrology. A calibration is worth the
reference it was made with, and its accuracy is not included.

## RULES OF THE FIRMWARE

```text
HDP ONLY ON THE LINK   logs on UART0; the native USB carries HDP and nothing else
NO MADE-UP VALUE       sensor missing or failing: a log, no number
NO FAKE IDENTITY       i2c.scan lists addresses; ident only when verified
SAY WHAT IS OBSERVED   hello.caps; UNKNOWN for what is not checked
TIME NEVER GOES BACK   t from esp_timer, clamped monotonic
NO SILENT LOSS         UART overrun -> uart.error "overrun"; long lines split,
                       never dropped; a frame too long is not sent half
```
