import { describe, expect, it } from 'vitest';
import { diagnose, emptyFacts, parseResetLine, resetKind, type NetFact, type SessionFacts } from '../src/core/diagnostics';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { attach, connectedSystem } from './helpers';

const S = DEFAULT_SETTINGS;
const net = (over: Partial<NetFact>, t: number): NetFact => ({
  seq: t,
  t,
  linkUp: true,
  dhcp: 'PASS',
  gateway: 'PASS',
  dns: 'PASS',
  internet: 'PASS',
  latency: 10,
  loss: 0,
  ...over,
});
const facts = (f: (x: SessionFacts) => void) => {
  const x = emptyFacts();
  f(x);
  return x;
};
const ids = (x: SessionFacts, now = 100_000) => diagnose(x, S, now).map((d) => `${d.id}:${d.confidence}`);

describe('power rules', () => {
  const detach = (t: number, dropAt: number | null) => ({ seq: t, t, dropAt, dropSeq: dropAt, dropMin: dropAt ? 4.6 : null, currentAfter: 0.004 });

  it('confidence follows the correlated count and ratio', () => {
    const one = facts((x) => {
      x.drops.push({ seq: 900, start: 900, end: 1200, min: 4.6 });
      x.detaches.push(detach(960, 900));
    });
    expect(ids(one)).toEqual(['POWER_INSTABILITY:LOW']);
    const three = facts((x) => {
      for (const t of [1000, 5000, 9000]) {
        x.drops.push({ seq: t, start: t, end: t + 300, min: 4.6 });
        x.detaches.push(detach(t + 60, t));
      }
    });
    expect(ids(three)).toEqual(['POWER_INSTABILITY:HIGH']);
  });

  it('does not blame power when most disconnects are unexplained', () => {
    const x = facts((x) => {
      x.drops.push({ seq: 900, start: 900, end: 1200, min: 4.6 });
      x.detaches.push(detach(960, 900), detach(5000, null), detach(9000, null), detach(13000, null));
    });
    expect(ids(x)).toEqual(['POWER_INSTABILITY:LOW', 'USB_INTERMITTENT:HIGH']);
  });

  it('reports a sag without disconnects as SUPPLY_SAG, not instability', () => {
    const x = facts((x) => x.drops.push({ seq: 1, start: 1, end: 2, min: 4.7 }));
    expect(ids(x)).toEqual(['SUPPLY_SAG:LOW']);
  });
});

describe('target rules', () => {
  it('ignores power-on resets and needs 2 other resets', () => {
    const x = facts((x) => {
      x.uart.resets.push({ seq: 1, t: 1, code: 1, reason: 'POWERON' }, { seq: 2, t: 2, code: 1, reason: 'POWERON' }, { seq: 3, t: 3, code: 8, reason: 'TG1WDT_SYS_RST' });
    });
    expect(ids(x)).toEqual([]);
    x.uart.resets.push({ seq: 6000, t: 6000, code: 8, reason: 'TG1WDT_SYS_RST' });
    expect(ids(x)).toEqual(['TARGET_RESET_LOOP:MEDIUM']);
  });

  it('parses ESP-IDF reset lines', () => {
    expect(parseResetLine('rst:0x8 (TG1WDT_SYS_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)', 5)).toEqual({ seq: 0, t: 5, code: 8, reason: 'TG1WDT_SYS_RST' });
    expect(parseResetLine('sensor init', 5)).toBeNull();
  });

  it('needs a meaningful framing error ratio, and recent errors', () => {
    const x = facts((x) => {
      x.uart.rxAtBaud = 100;
      x.uart.framingAtBaud.push(...[1000, 2000, 3000].map((t) => ({ t, seq: t })));
    });
    expect(ids(x, 4000)).toEqual([]); // 3 % of lines: noise, not a mismatch
    x.uart.rxAtBaud = 5;
    expect(ids(x, 4000)).toEqual(['SERIAL_CONFIGURATION_MISMATCH:MEDIUM']);
    expect(ids(x, 60_000)).toEqual([]); // stale
  });
});

describe('network rules', () => {
  it('reports only the lowest failing layer', () => {
    const x = facts((x) => x.net.push(net({ dhcp: 'FAIL', gateway: 'UNKNOWN', dns: 'UNKNOWN', internet: 'UNKNOWN' }, 1)));
    expect(ids(x)).toEqual(['DHCP_FAILURE:LOW']);
  });

  it('separates DNS failure from an upstream outage', () => {
    const dns = facts((x) => [1, 2, 3].forEach((t) => x.net.push(net({ dns: 'FAIL', internet: 'PASS' }, t))));
    expect(ids(dns)).toEqual(['DNS_FAILURE:HIGH']);
    const up = facts((x) => [1, 2, 3].forEach((t) => x.net.push(net({ dns: 'FAIL', internet: 'FAIL' }, t))));
    expect(ids(up)).toEqual(['UPSTREAM_FAILURE:HIGH']);
    const unknown = facts((x) => [1, 2, 3].forEach((t) => x.net.push(net({ dns: 'FAIL', internet: 'UNKNOWN' }, t))));
    expect(ids(unknown)).toEqual(['DNS_FAILURE:MEDIUM']);
  });

  it('confidence grows with consecutive failing reports and resets on recovery', () => {
    const x = facts((x) => x.net.push(net({ gateway: 'FAIL' }, 1)));
    expect(ids(x)).toEqual(['GATEWAY_UNREACHABLE:LOW']);
    x.net.push(net({ gateway: 'FAIL' }, 2));
    expect(ids(x)).toEqual(['GATEWAY_UNREACHABLE:MEDIUM']);
    x.net.push(net({}, 3));
    expect(ids(x)).toEqual([]);
  });

  it('does not call a steady, slightly slow path unstable', () => {
    const x = facts((x) => [1, 2, 3, 4, 5, 6].forEach((t) => x.net.push(net({ latency: 80 + t, loss: 0.5 }, t))));
    expect(ids(x)).toEqual([]);
  });
});

describe('usb enumeration', () => {
  it('needs 3 s of running current with no USB device', () => {
    const x = facts((x) => {
      x.unenumerated = { since: 1000, longestMs: 0, firstAt: 1000, firstSeq: 1 };
    });
    expect(ids(x, 3500)).toEqual([]);
    expect(ids(x, 4000)).toEqual(['USB_NOT_ENUMERATED:MEDIUM']);
    expect(ids(x, 12_000)).toEqual(['USB_NOT_ENUMERATED:HIGH']);
  });
});

describe('long sessions (audit 2026-10)', () => {
  it('a target at the wrong baud rate for 2100 lines keeps its diagnosis, with true counts', async () => {
    const { sys, transport, clock } = await connectedSystem();
    transport.push({ type: 'uart.config', t: 1, port: 'UART0', baud: 115200, bits: 8, parity: 'NONE', stop: 1 });
    for (let n = 0; n < 2100; n++) {
      transport.push({ type: 'uart.rx', t: 10 + n * 10, data: 'à\u0000þ\u0080\u001cø' });
      transport.push({ type: 'uart.error', t: 10 + n * 10, kind: 'garbled' });
    }
    clock.set(1_000_000 + 21_100);
    sys.evaluate();
    const d = sys.diagnoses.find((x) => x.id === 'SERIAL_CONFIGURATION_MISMATCH');
    expect(d?.confidence).toBe('HIGH');
    expect(d!.basis).toBe('2100 garbled lines on 2100 lines (100 %)');
    expect(d!.evidence.length).toBeLessThanOrEqual(500);
  });
});

describe('a disconnect that beats the sample (audit 2026-10)', () => {
  it('counts with the drop whose first low sample comes right after it, never blamed on the cable', async () => {
    const { sys, transport, clock } = await connectedSystem();
    transport.push(attach(1));
    for (let k = 0; k < 3; k++) {
      const t0 = 1000 + k * 4000;
      for (let t = t0 - 200; t < t0; t += 20) transport.push({ type: 'power', t, v: 5.05, i: 0.3 });
      transport.push({ type: 'usb.detach', t: t0 + 8 }); // the rail collapses between two samples
      transport.push({ type: 'power', t: t0 + 20, v: 4.4, i: 0.7 });
      transport.push({ type: 'power', t: t0 + 40, v: 4.5, i: 0.6 });
      for (let t = t0 + 60; t < t0 + 400; t += 20) transport.push({ type: 'power', t, v: 5.05, i: 0.3 });
      transport.push(attach(t0 + 900));
    }
    clock.set(1_000_000 + 13_000);
    sys.evaluate();
    const ids = sys.diagnoses.map((d) => `${d.id}:${d.confidence}`);
    expect(ids).toContain('POWER_INSTABILITY:HIGH');
    expect(ids.some((x) => x.startsWith('USB_INTERMITTENT'))).toBe(false);
    expect(ids.some((x) => x.startsWith('SUPPLY_SAG'))).toBe(false);
    const p = sys.diagnoses.find((d) => d.id === 'POWER_INSTABILITY')!;
    expect(p.correlation).toMatch(/delay -12 ms to -12 ms/);
    expect(sys.trace.all().some((e) => e.message === 'disconnect just before the first low sample')).toBe(true);
  });
});

describe('an I2C device that browns out with the supply (audit 2026-10)', () => {
  it('a loss seen by a scan 3 s later is still set against the drop, not a loose wire', async () => {
    const { sys, transport, clock } = await connectedSystem();
    const scan = (t: number, present: boolean) => transport.push({ type: 'i2c.scan', t, speed: 100000, devices: present ? [{ addr: 0x76, ident: null, method: null }] : [] });
    for (let k = 0; k < 3; k++) {
      const t0 = k * 9000;
      scan(t0, true);
      for (let t = t0 + 400; t < t0 + 500; t += 20) transport.push({ type: 'power', t, v: 5.05, i: 0.3 });
      for (let t = t0 + 500; t < t0 + 600; t += 20) transport.push({ type: 'power', t, v: 4.3, i: 0.6 }); // the sag
      for (let t = t0 + 600; t < t0 + 700; t += 20) transport.push({ type: 'power', t, v: 5.05, i: 0.3 });
      scan(t0 + 3000, false); // 2.5 s after the drop began: the device is gone
      scan(t0 + 6000, true);
    }
    clock.set(1_000_000 + 27_000);
    sys.evaluate();
    const d = sys.diagnoses.find((x) => x.id === 'I2C_DEVICE_DISAPPEARED')!;
    expect(d.correlation).toMatch(/^3 \/ 3 losses during a voltage drop/);
    expect(d.cause).toMatch(/browns out with the supply/);
  });
});

describe('reset kinds and unseen supplies (audit 2026-10)', () => {
  it('flashing or opening the USB port, a power glitch and a sleep wake are not a firmware hang', () => {
    expect(resetKind({ code: 0x15, reason: 'USB_UART_CHIP_RESET' })).toBe('HOST');
    expect(resetKind({ code: 0x10, reason: 'RTCWDT_RTC_RST' })).toBe('HOST');
    expect(resetKind({ code: 0x17, reason: 'POWER_GLITCH_RESET' })).toBe('POWER');
    expect(resetKind({ code: 0xf, reason: 'RTCWDT_BROWN_OUT_RESET' })).toBe('POWER');
    expect(resetKind({ code: 0x8, reason: 'TG1WDT_SYS_RST' })).toBe('WATCHDOG');
    expect(resetKind({ code: 0xc, reason: 'RTC_SW_CPU_RST' })).toBe('SOFTWARE');
    expect(resetKind({ code: 0x5, reason: 'DSLEEP' })).toBe('SLEEP');
    const x = facts((x) => {
      for (const [k, reason] of ['USB_UART_CHIP_RESET', 'USB_JTAG_CHIP_RESET', 'USB_UART_CHIP_RESET', 'POWER_GLITCH_RESET'].entries())
        x.uart.resets.push({ seq: k, t: k * 1000, code: 0x15, reason });
    });
    expect(ids(x)).toEqual([]);
    x.uart.resets.push({ seq: 10, t: 5000, code: 8, reason: 'TG1WDT_SYS_RST' }, { seq: 11, t: 6000, code: 8, reason: 'TG1WDT_SYS_RST' });
    const d = diagnose(x, DEFAULT_SETTINGS, 7000).find((x) => x.id === 'TARGET_RESET_LOOP')!;
    expect(d.confidence).toBe('MEDIUM');
    expect(d.observed.join(' ')).toMatch(/3 more by the host/);
  });

  it('disconnects before the first power sample never make the rail "fine", nor HIGH', () => {
    const detach = (t: number, unseen: boolean) => ({ seq: t, t, dropAt: null, dropSeq: null, dropMin: null, currentAfter: null, ...(unseen ? { supplyUnseen: true as const } : {}) });
    const x = facts((x) => x.detaches.push(detach(1000, true), detach(2000, true), detach(3000, true), detach(4000, false)));
    const d = diagnose(x, DEFAULT_SETTINGS, 5000).find((x) => x.id === 'USB_INTERMITTENT')!;
    expect(d.confidence).toBe('MEDIUM');
    expect(d.observed.join(' ')).not.toMatch(/rail above/);
    x.detaches.push(detach(5000, false), detach(6000, false));
    const e = diagnose(x, DEFAULT_SETTINGS, 7000).find((x) => x.id === 'USB_INTERMITTENT')!;
    expect(e.confidence).toBe('HIGH');
    expect(e.basis).toMatch(/^3 disconnects/);
    expect(e.observed.join(' ')).toMatch(/3 more with the supply not observed/);
  });

  it('a crafted bus of alternating scans stays cheap to evaluate', () => {
    const x = facts((x) => {
      for (let k = 0; k < 500; k++) x.i2c.scans.push({ seq: k, t: k * 1000, addresses: k % 2 ? [] : Array.from({ length: 112 }, (_, a) => a + 8) });
      for (let k = 0; k < 500; k++) x.drops.push({ seq: 10_000 + k, start: k * 1000 + 500, end: k * 1000 + 600, min: 4.5 });
    });
    const started = performance.now();
    diagnose(x, DEFAULT_SETTINGS, 600_000);
    expect(performance.now() - started).toBeLessThan(150);
  });
});
