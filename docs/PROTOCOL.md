# HARDWARE DOG / WIRE PROTOCOL

```text
VERSION        1
TRANSPORT      USB CDC serial (115200 8N1), any byte stream later
ENCODING       UTF-8, newline-delimited JSON (one object per line)
MAX LINE       64 KiB, longer lines are dropped and reported
CLOCK          "t" = device uptime in milliseconds
SCHEMA         protocol/hdp_v1.json (JSON Schema, the contract)
REFERENCE      web/src/core/protocol.ts (decoder + tests)
CONTRACT TEST  web/test/protocol-contract.test.ts
```

The firmware and the interface speak one protocol. The simulator in the web
interface speaks it too, as text, through the same decoder.

> **ONE EVENT MODEL.** Every HDP producer, the firmware and the simulator
> alike, must emit frames that validate against `protocol/hdp_v1.json`. The
> contract test checks every simulator frame of every fault scenario on
> each commit. The firmware will run the same check.

## RULES

```text
[ 1 ] Every device frame is a JSON object with "type" and "t".
[ 2 ] "t" is milliseconds since device boot. It never goes backwards.
[ 3 ] Producers emit enums in the canonical case of the schema.
      Decoders accept any case (be strict in what you send, liberal in
      what you accept).
[ 4 ] Optional strings may be null or omitted. Numbers must be finite.
[ 5 ] A frame that does not validate is rejected, counted and logged.
      The interface never guesses what a broken frame meant.
[ 6 ] The device must not claim an identity it has not verified
      (see i2c.scan: "ident" only with a "method").
```

---

## DEVICE -> HOST

### hello

Sent on boot and in reply to a host `hello`. Anchors the device clock to the
host clock.

```json
{"type":"hello","t":0,"proto":1,"device":"HD-001","rev":"A","fw":"0.1.0"}
```

### power

One sample of the target supply rail. Volts and amps.

```json
{"type":"power","t":1200,"v":5.041,"i":0.312}
```

### usb.attach / usb.detach

```json
{"type":"usb.attach","t":1214,"speed":"FULL","vid":12346,"pid":4097,"cls":"CDC","power":"BUS","manufacturer":"Espressif","product":"USB JTAG/Serial","serial":"48:27:E2:5C:1A:90"}
{"type":"usb.detach","t":2088}
```

```text
speed     LOW | FULL | HIGH | SUPER
          the speed at which the device enumerated ON HARDWARE DOG, not its
          maximum capability. The ESP32-S3 host port is full-speed: a
          high-speed device enumerates there at FULL (USB 2.0 fallback).
power     BUS | SELF
```

### uart.config / uart.rx / uart.error

```json
{"type":"uart.config","t":0,"port":"UART0","baud":115200,"bits":8,"parity":"NONE","stop":1}
{"type":"uart.rx","t":1320,"data":"bootloader 0.9"}
{"type":"uart.error","t":1330,"kind":"framing"}
```

One `uart.rx` per received line, without the line terminator.

### i2c.scan

```json
{"type":"i2c.scan","t":5000,"speed":400000,"devices":[
  {"addr":60,"ident":null,"method":null},
  {"addr":64,"ident":"INA226","method":"manufacturer ID register 0xFE = 0x5449"}
]}
```

`addr` is the 7-bit address (0x00 to 0x7F). `ident` is set only when the
firmware confirmed it, and `method` says how.

### net.status

```json
{"type":"net.status","t":2000,
 "link":{"up":true,"mbps":1000,"duplex":"FULL"},
 "address":"192.168.1.84","dhcp":"PASS",
 "gateway":{"address":"192.168.1.1","status":"PASS"},
 "dns":{"address":"1.1.1.1","status":"PASS"},
 "internet":"PASS","latency":12,"loss":0}
```

Check status: `PASS | WARN | FAIL | PENDING | UNKNOWN`. UNKNOWN means not
measured, never "probably fine".

### probe.result / probe.done

```json
{"type":"probe.result","t":9000,"id":"p1","test":"PING","status":"PASS","detail":"4/4 replies, avg 4 ms"}
{"type":"probe.done","t":9400,"id":"p1"}
```

### log

```json
{"type":"log","t":3000,"level":"warn","message":"INA226 calibration missing, using defaults"}
```

`level`: `info | warn | error`.

---

## HOST -> DEVICE

```json
{"cmd":"hello","proto":1}
{"cmd":"usb.enumerate"}
{"cmd":"uart.config","baud":115200}
{"cmd":"uart.tx","data":"AT+RST"}
{"cmd":"i2c.scan"}
{"cmd":"net.refresh"}
{"cmd":"probe","id":"p1","target":"192.168.1.1","tests":["PING","DNS","TCP"]}
```

`i2c.scan`, `usb.enumerate`, `uart.tx` and `probe` are ACTIVE operations:
the interface always states what they will do before sending them.
