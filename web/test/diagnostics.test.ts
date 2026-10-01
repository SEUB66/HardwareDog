import { describe, expect, it } from 'vitest';
import { diagnose, emptyFacts, parseResetLine, type NetFact, type SessionFacts } from '../src/core/diagnostics';
import { DEFAULT_SETTINGS } from '../src/core/types';

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
