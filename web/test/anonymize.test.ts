/**
 * LVL 95: a recording made shareable keeps its incident. Anonymizing
 * changes who and where, never what happened: same facts, same
 * diagnosis, same evidence, on every case of the library.
 */
import { describe, expect, it } from 'vitest';
import { ANONYMIZE_VERSION, anonymize, findLeaks, isNeutralIpv4 } from '../src/core/anonymize';
import { factSummary, replayRecording } from '../src/core/cases';
import { SessionRecorder, newHeader, parseHdlog, toHdlog } from '../src/core/session';
import { sha256 } from '../src/core/sha256';
import { T0 } from './helpers';

const hdlogs = import.meta.glob('../../cases/**/*.hdlog', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

async function outcome(text: string) {
  const sys = await replayRecording(parseHdlog(text));
  return { facts: factSummary(sys), diagnoses: sys.diagnoses.map((d) => [d.id, d.confidence, d.evidence]) };
}

describe('anonymize: the incident stays', () => {
  for (const [path, text] of Object.entries(hdlogs)) {
    it(`${path.split('/').pop()}: same facts, diagnosis and evidence`, async () => {
      const { hdlog } = anonymize(text);
      const copy = parseHdlog(hdlog);
      expect(copy.integrity!.status).toBe('VERIFIED');
      expect(await outcome(hdlog)).toEqual(await outcome(text));
      expect(findLeaks(hdlog)).toEqual([]);
      // the same file gives the same bytes: a copy can be checked by anyone
      expect(anonymize(text).hdlog).toBe(hdlog);
    });
  }
});

/** A bench session full of things that name people and places. */
function realSession(): string {
  const header = newHeader({
    id: 'HD-20261001-0930',
    startedAt: T0,
    source: 'WEB SERIAL',
    endpoint: 'USB CDC 303A:1001 /Users/seb/dev/tty.usbmodem1101',
    scenario: null,
    app: 'test',
    recording: 'aa'.repeat(16),
  });
  const rec = new SessionRecorder(header);
  let t = 0;
  const at = () => T0 + (t += 10);
  rec.add({ at: at(), frame: { type: 'hello', t: 0, proto: 1, device: 'HD-3A1F2C', rev: 'A', fw: '0.1.0', chip: '7cdfa13a1f2c', caps: ['power', 'usb', 'uart', 'net', 'probe'] } as never });
  rec.add({ at: at(), frame: { type: 'usb.attach', t: 10, vid: 0x303a, pid: 0x1001, speed: 'FULL', cls: 'CDC', power: 'BUS', manufacturer: 'Espressif', product: 'USB JTAG', serial: 'F4:12:FA:0B:33:21' } as never });
  rec.add({ at: at(), frame: { type: 'net.status', t: 20, link: { up: true, mbps: null, duplex: null }, address: '10.4.7.23', dhcp: 'PASS', gateway: { address: '10.4.7.1', status: 'PASS' }, dns: { address: '10.4.7.1', status: 'PASS' }, internet: 'PASS', latency: 3, loss: 0 } as never });
  rec.add({ at: at(), frame: { type: 'uart.rx', t: 30, data: 'wifi: connect ssid=MaisonSeb password=hunter22 to 10.4.7.1 mac f4:12:fa:0b:33:21' } });
  rec.add({ at: at(), frame: { type: 'uart.rx', t: 40, data: 'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)' } });
  rec.add({ at: at(), frame: { type: 'uart.rx', t: 50, data: 'owner seb@seub.net token 9f86d081884c7d659a2feaa0c55ad015' } });
  rec.add({ at: at(), cmd: { cmd: 'probe', id: 'p1', target: 'nas.maison.lan', tests: ['PING'] } });
  rec.add({ at: at(), frame: { type: 'probe.result', t: 70, id: 'p1', test: 'PING', status: 'PASS', detail: 'nas.maison.lan (10.4.7.50) 4/4 replies' } });
  rec.add({ at: at(), mark: 'Seb: plugged the NAS on 10.4.7.50' });
  return toHdlog(rec);
}

describe('anonymize: who and where are gone', () => {
  it('a real session leaks before, nothing after', () => {
    const text = realSession();
    expect(findLeaks(text).length).toBeGreaterThan(5);
    const { hdlog, summary } = anonymize(text);
    expect(findLeaks(hdlog)).toEqual([]);
    for (const secret of ['7cdfa13a1f2c', 'HD-3A1F2C', '10.4.7', 'hunter22', 'MaisonSeb', 'seb@seub.net', 'f4:12:fa', 'F4:12:FA', '9f86d081', 'nas.maison.lan', '/Users/seb']) {
      expect(hdlog, secret).not.toContain(secret);
    }
    expect(hdlog).toContain('mac 02:00:00:00:00:01');
    // the boot line, which the reset rule reads, is untouched
    expect(hdlog).toContain('rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)');
    // consistent: the gateway and the DNS server were the same host, and still are
    const net = parseHdlog(hdlog).entries.find((e) => 'frame' in e && e.frame.type === 'net.status') as { frame: { gateway: { address: string }; dns: { address: string }; address: string } };
    expect(net.frame.gateway.address).toBe(net.frame.dns.address);
    expect(net.frame.address).not.toBe(net.frame.gateway.address);
    expect(isNeutralIpv4(net.frame.address)).toBe(true);
    expect(summary.replaced['ipv4']).toBe(3);
    expect(summary.textLines).toBeGreaterThanOrEqual(4);
  });

  it('says it was anonymized, and from which file', () => {
    const text = realSession();
    const h = parseHdlog(anonymize(text).hdlog).header as { anonymized?: { from: string; version: number }; recording: string; endpoint: string };
    expect(h.anonymized).toEqual({ from: sha256(text), version: ANONYMIZE_VERSION });
    expect(h.recording).not.toBe('aa'.repeat(16));
    expect(h.endpoint).toBe('WEB SERIAL (anonymized)');
  });

  it('refuses a modified file: no laundering of altered evidence', () => {
    const text = realSession();
    const tampered = realSession().replace('rst:0x1', 'rst:0x8');
    expect(() => anonymize(tampered)).toThrow(/intact/);
    expect(() => anonymize(text)).not.toThrow();
  });
});

/** A session whose console prints secrets the way real boards do (audit 2026-10). */
function leakySession(lines: string[]): string {
  const rec = new SessionRecorder(newHeader({ id: 'HD-20261001-0931', startedAt: T0, source: 'WEB SERIAL', endpoint: 'USB CDC', scenario: null, app: 'test', recording: 'bb'.repeat(16) }));
  let t = 0;
  rec.add({ at: T0, frame: { type: 'hello', t: 0, proto: 1, device: 'HD-3A1F2C', rev: 'A', fw: '0.1.0', caps: ['uart'] } as never });
  for (const data of lines) rec.add({ at: T0 + (t += 10), frame: { type: 'uart.rx', t, data } });
  return toHdlog(rec);
}

describe('anonymize: a secret never survives, wherever and however it is printed', () => {
  const cases: [string, string[], string[]][] = [
    ['a reconnect loop prints the same key twice', ['wifi: password=hunter22 rc=1', 'wifi: password=hunter22 rc=2', 'end password=zzzz9'], ['hunter22', 'zzzz9']],
    ['prefixed and snake_case keys', ['WIFI_PASSWORD=abc12345', 'wifi_pass=hunter23', 'mqtt_password: s3cr3t!x', 'CONFIG_ESP_WIFI_PASSWORD="hunter24"'], ['abc12345', 'hunter23', 's3cr3t!x', 'hunter24']],
    ['a JSON config printed on the console', ['cfg {"ssid":"MaisonSeb","pass":"hunter25"}'], ['MaisonSeb', 'hunter25']],
    ['the value printed before its key line', ['connecting with hunter26...', 'psk=hunter26'], ['hunter26']],
  ];
  for (const [name, lines, secrets] of cases) {
    it(name, () => {
      const text = leakySession(lines);
      expect(findLeaks(text).length).toBeGreaterThan(0);
      const { hdlog } = anonymize(text);
      for (const s of secrets) expect(hdlog, s).not.toContain(s);
      expect(findLeaks(hdlog)).toEqual([]);
    });
  }

  it('a removed secret at the end of a line is not reported as a leak', () => {
    const { hdlog } = anonymize(leakySession(['join password=xyz123']));
    expect(hdlog).toContain('join password=<removed>');
    expect(findLeaks(hdlog)).toEqual([]);
  });
});
