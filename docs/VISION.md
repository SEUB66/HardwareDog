# HARDWARE DOG / PRODUCT VISION

```text
PROJECT TYPE     OPEN HARDWARE + FIRMWARE + INTERFACE
FORM             FIELD DIAGNOSTIC BOX, FITS IN A SERVICE BAG
QUESTION         WHAT ACTUALLY HAPPENED?
```

Hardware Dog is a real open-source hardware + firmware + interface project,
not a gadget built to look good. It is a small field diagnostic box you can
actually keep in your bag.

Plug in USB-C / USB, network, and optionally UART / I2C, and Hardware Dog
immediately shows what is really going on:

```text
POWER      supply and USB power negotiation, simple voltages
USB        detected device, descriptors, connect / disconnect
NET        link, throughput, local discovery, latency, packet loss
SERIAL     UART logs
SENSORS    I2C devices and readings
HISTORY    a record of every problem seen
```

A multimeter for the modern technician, aimed at electronics and computing
at the same time.

---

## STACK

```text
HARDWARE   ESP32-S3 or RP2040, small display, USB-C, optional Ethernet,
           a few protected inputs

FIRMWARE   C/C++ or Rust, drivers, real-time acquisition,
           diagnostic storage

WEB        Hardware Dog serves its own small local dashboard.
           Plug it in -> open hardware.dog -> graphs, logs, tests, export.

OPEN       PCB, firmware, 3D enclosure, frontend and documentation
           are all public
```

---

## FULL STACK, DOWN TO THE COPPER

```text
PCB -> FIRMWARE -> PROTOCOLS -> WEBUSB / WEBSERIAL -> NETWORK -> UI
    -> 3D PRINTING -> FINISHED PRODUCT
```

The name says it: the dog sniffs your hardware until it finds what is wrong.

See [`DESIGN_SPEC.md`](DESIGN_SPEC.md) for the interface and industrial
design rules.
