# HARDWARE DOG / SERIAL CONSOLE

```text
NO PROBE. ANY BOARD. CHROME OR EDGE.
```

The first way to use Hardware Dog needs nothing but a board and a cable:
the browser reads the board's serial console, and Hardware Dog puts it on
the timeline, runs the rules, records it, and writes the report.

---

## WHAT WORKS

```text
ANY USB SERIAL PORT    Arduino (Uno, Nano, Mega...), ESP32 / ESP8266 dev
                       boards, Raspberry Pi Pico, STM32 Nucleo, USB-UART
                       adapters (CH340, CP210x, FTDI, PL2303) wired to any
                       board's TX / RX / GND: a router, a 3D printer...
NOT A SERIAL PORT      phones, tablets, mice, keyboards, game pads, USB
                       sticks, vapes: Chrome does not list them, and there
                       is no console to read
BROWSER                Chrome or Edge on a computer (Web Serial), over https
                       or localhost; not Firefox, Safari, or a phone
```

## HOW

```text
1. PLUG IN     the board, with a data cable (some cables only charge)
2. CHOOSE      START HERE -> SERIAL CONSOLE, then the port in Chrome's list
3. WATCH       SERIAL: every line, live; the rate is 115200 to start
4. RATE        unreadable lines? choose the board's rate on SERIAL (9600,
               74880 for an ESP8266 boot, 115200...) and APPLY
5. READ        STATUS and REPORT: what the rules found
```

The port list is empty on Linux? Your user needs access to serial ports:
`sudo usermod -aG dialout $USER`, then log out and in again. A port that
another program holds (Arduino IDE serial monitor, screen, minicom) cannot
be opened twice: close it there first.

---

## WHAT IT SEES, WHAT IT CANNOT

```text
SEEN           every console line, timestamped by this computer
               target resets: an ESP-IDF "rst:0x.. (REASON)" line
               wrong baud rate: framing errors when the port reports them,
               and lines that do not read as text (garbled)
               the board unplugged: the link is lost, said and recorded
DIAGNOSED      TARGET_RESET_LOOP, SERIAL_CONFIGURATION_MISMATCH
               (DIAGNOSTICS.md)
NOT SEEN       supply voltage and current, USB enumeration, I2C, network:
               STATUS says NOT MONITORED. A computer cannot measure them;
               a Hardware Dog probe does (FIRMWARE.md)
```

## THE EVIDENCE

A console session is a real recording like any other: PHYSICAL, sealed,
replayable, shareable with the incident library (LIBRARY.md). The browser
turns what it reads into HDP frames (PROTOCOL.md): its `hello` says
`device CONSOLE, rev HOST, caps [uart]`, then `uart.config`, `uart.rx`
and `uart.error`. Times are this computer's clock from the moment the port
opened.

```text
ENDS A LINE    \n, \r\n, or a lone \r; a line with no end is shown after
               300 ms of silence (a prompt); 1024 characters at most
REMOVED        terminal colors (ESP-IDF logs) and empty lines
SENT           SERIAL -> line to send writes it, then \n (ACTIVE)
```

Code: `web/src/core/console.ts`. Tests: `web/test/console.test.ts`.
