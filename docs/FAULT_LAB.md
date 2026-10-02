# HARDWARE DOG / FAULT LAB

```text
PHYSICAL FAILURE -> .HDLOG -> CASE -> REGRESSION TEST -> BETTER RULES
```

LVL 70. Faults made **on purpose**, on a bench, so that every diagnosis
rests on at least one real recording and not only on the simulator. Each
fault below says how to create it, what to expect, and whether the
reference firmware can see it today. A fault the firmware cannot observe is
not recorded "for the count": it waits for the level that can see it.

```text
STATUS   LVL 70 PARTIAL
         software    PASS   one case per diagnosis (14 simulated cases),
                            hwdog test cases/ in CI, case context
         bench       PENDING  needs the DEVKIT-S3 + INA226 (FIRMWARE.md)
```

---

## THE BENCH

```text
REQUIRED                                 FOR
ESP32-S3 DevKitC + INA226 (R100)         the Hardware Dog (FIRMWARE.md wiring)
a target board (ESP32 dev board)         the device under test
a bench supply, 0-6 V, current limit     undervoltage, brownout
a multimeter                             truth (and LVL 65 calibration)
cables: one good short USB, one long     the cable faults
  thin one (2 m, AWG 28 power)
a 10 ohm 5 W resistor + logic MOSFET     a switched load
  (e.g. IRLZ44N) or a USB load tester
a second router or a Linux box           the network faults
jumper wires, a breadboard               the connector and I2C faults
```

**SAFETY.** 5 V targets stay at or below 5.5 V; set the bench supply
current limit before connecting (500 mA is plenty). The ESP32-S3 pins are
3.3 V: a 5 V UART needs a level shifter. All grounds common. The 10 ohm
load dissipates 2.5 W at 5 V: it gets hot, keep it off the bench mat.

---

## RECORD A FAULT, MAKE IT A CASE

```text
1  dogd serve --source serial:/dev/ttyACM0      (or WEB SERIAL in SETUP)
2  SESSION MARK "fault starts"   (palette: session mark "...")
3  create the fault, keep it 1-3 minutes, mark when it stops
4  REPORT: check the diagnosis is the one expected; EXPORT PDF
5  REPORT -> SAVE AS CASE: case.json + the untouched .hdlog
6  rename to the next free HD-Cxxx, fill "context": description,
   hardware (boards, cable, supply, firmware), notes
7  cases/ + README table; npm run test:cases (web/)
```

A recording that does **not** give the expected diagnosis is the most
valuable one: it becomes a case with what the engine says today, and an
issue explaining what it should say. Rules are changed on purpose, and the
case shows the change.

---

## THE FAULTS

`SEEN TODAY` is what the reference firmware (DEVKIT-S3) observes: power
(INA226), target UART, I2C scan, Wi-Fi status. The dev board has no USB
host port for the target: USB faults need a board that watches USB
(LVL 85 PCB, or a USB host add-on), and say so (`hello.caps`).

```text
#   FAULT                 EXPECTED DIAGNOSIS            SEEN TODAY   SIM CASE
1   cheap USB cable       SUPPLY SAG / POWER INSTAB.    power, UART  HD-C014 HD-C002
2   undervoltage          SUPPLY SAG                    power        HD-C014
3   brownout              TARGET RESET LOOP + sag       power, UART  HD-C007
4   loose connector       USB INTERMITTENT              NO (usb)     HD-C003
5   wrong baud            SERIAL CONFIG MISMATCH        UART         HD-C006
6   missing I2C pull-up   I2C BUS FAULT                 i2c.error    HD-C016
7   intermittent I2C      I2C DEVICE DISAPPEARED        i2c watch    HD-C015
8   DHCP loss             DHCP FAILURE                  Wi-Fi        HD-C004
9   DNS loss              DNS FAILURE                   net watch    HD-C005
10  network latency       NETWORK UNSTABLE              net watch    HD-C008
13  router loses power    NETWORK LOST WITH POWER       power, net   HD-C017
11  boot loop             TARGET RESET LOOP             UART         HD-C007
12  USB reconnect loop    USB INTERMITTENT              NO (usb)     HD-C003
```

DNS, latency and loss come from `net watch` (LVL 80): until it runs, the
firmware reports them UNKNOWN, never guessed.

### 1  CHEAP USB CABLE

Power the target through the 2 m thin cable, through the INA226 (VIN+ on
the supply side, VIN- on the target side). Load bursts: the 10 ohm load
switched by the MOSFET from a target GPIO, 300 ms on every 8 s (or the
target's Wi-Fi transmitting).

```text
EXPECT   undervoltage events during each burst; with the target
         browning out: resets on its UART (rst:0xf BROWNOUT_RST)
CONTROL  same session with the short good cable: no finding
```

### 2  UNDERVOLTAGE

Bench supply at 5.00 V, current limit 500 mA, target running. Lower to
4.70 V for 30 s, back to 5.00 V. Repeat three times.

```text
EXPECT   SUPPLY SAG, MEDIUM (3 drops, target survived)
NOTE     the drop must last more than one sample (20 ms) to be seen
```

### 3  BROWNOUT

Lower the bench supply by 0.1 V steps (10 s each) from 5.0 V until the
target resets, note the voltage, restore 5.0 V. The ESP32 brownout
detector watches the 3.3 V rail (its level is a menuconfig setting), so
the 5 V input usually falls well below 4 V before it trips: the value is
the board's, measure it, do not assume it.

```text
EXPECT   undervoltage + target reset with reason BROWNOUT on UART
VALUE    the trip voltage, written in the case notes
```

### 4  LOOSE CONNECTOR

A USB extension whose data lines go through a breadboard, one wire
touched by hand / pulled in and out. **Needs USB observation**: not
recordable on the DEVKIT-S3. Keep the procedure, wait for the board.

### 5  WRONG BAUD

Target firmware prints at 9600; Hardware Dog listens at 115200.

```text
EXPECT   framing errors, SERIAL CONFIGURATION MISMATCH, HIGH
FIX      serial 9600 in the palette: the text becomes readable,
         errors stop (both in the same recording)
```

### 6  MISSING I2C PULL-UP

Target bus with a BME280 breakout whose pull-ups are removed (cut the
jumper or desolder), no other pull-ups. PROBE -> I2C scan every 5 s.

```text
EXPECT   LVL 80: the scan sees a bus fault (SDA or SCL held low, or no
         ACK where a device was), never a made-up device
```

### 7  INTERMITTENT I2C

The same sensor on long jumper wires; wiggle the SDA wire during a
2 minute session with periodic scans.

```text
EXPECT   LVL 80: I2C DEVICE DISAPPEARED, the address present in some
         scans and absent in others
```

### 8  DHCP LOSS

Hardware Dog on a test router's Wi-Fi. Disable the DHCP server, reboot
the Hardware Dog (or renew its lease), re-enable after 60 s.

```text
EXPECT   DHCP FAILURE while the server is off; recovery visible after
```

### 9  DNS LOSS

On the test router, set the DNS server handed out by DHCP to
192.0.2.1 (TEST-NET-1: routed nowhere, by design).

```text
EXPECT   LVL 80 probes: DNS FAILURE while the gateway answers
```

### 10  NETWORK LATENCY

A Linux box bridging the test network, with `netem`:

```sh
sudo tc qdisc add dev br0 root netem delay 200ms 120ms loss 8%
sudo tc qdisc del dev br0 root          # back to normal
```

```text
EXPECT   LVL 80 probes: NETWORK UNSTABLE (latency swings, loss)
```

### 11  BOOT LOOP

Target firmware that blocks a task for 10 s with the task watchdog on
(`esp_task_wdt_add` then a busy loop), so it reboots by itself.

```text
EXPECT   TARGET RESET LOOP, reason TG1WDT_SYS_RST / TASK_WDT, intervals
         listed; the supply stays solid (it is not a power fault)
```

### 12  USB RECONNECT LOOP

Target firmware that disconnects and reconnects its USB device every
5 s (`tud_disconnect()` / `tud_connect()` in TinyUSB). **Needs USB
observation**, like fault 4.

### 13  ROUTER LOSES POWER

A USB-powered travel router (5 V) fed through the INA226 and the thin 2 m
cable; the W5500 of Hardware Dog plugged into one of its LAN ports;
`net watch 10 <a name>` running. Load bursts on the same rail (the 10 ohm
load) until the router browns out.

```text
EXPECT   NETWORK LOST WITH POWER: voltage drop > link down > up > DHCP >
         DNS, each step timed; NET -> OUTAGES lists every loss
CONTROL  the router on its own stable supply: link stays up through the
         same bursts
```

---

## WHAT "DONE" MEANS FOR LVL 70

```text
[ OK ] every diagnosis has a case (simulated): hwdog test cases/ in CI
[ OK ] case files carry description, hardware, notes
[ OK ] the procedure above, one per fault
[ -- ] faults 1, 2, 3, 5, 8, 11 recorded on the bench as PHYSICAL cases
[ -- ] faults 6, 7, 9, 10, 13 with the LVL 80 firmware; 4 and 12 on a
       board that watches USB
[ -- ] simulator scenarios re-tuned from the physical recordings
       (the sag depth, the burst timing, the reset intervals measured)
```
