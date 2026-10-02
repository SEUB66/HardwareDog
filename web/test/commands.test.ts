import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/core/archive';
import { execute, tokenize, type Screen } from '../src/core/commands';
import { newHeader } from '../src/core/session';
import { T0, connectedSystem } from './helpers';

async function ctx() {
  const { sys, transport } = await connectedSystem();
  const nav: Screen[] = [];
  const exports: string[] = [];
  return {
    sys,
    transport,
    nav,
    exports,
    c: { system: sys, navigate: (s: Screen) => nav.push(s), exportReport: (f: string) => exports.push(f) },
  };
}

describe('sim', () => {
  it('lists scenarios and switches through the context', async () => {
    const { sys } = await connectedSystem();
    const switched: string[] = [];
    const c = { system: sys, navigate: () => {}, exportReport: () => {}, simulate: (id: string) => switched.push(id) };
    expect(execute('sim list', c).lines).toHaveLength(11);
    expect(execute('sim hd-t004', c).ok).toBe(true);
    expect(execute('sim HD-T999', c).ok).toBe(false);
    expect(switched).toEqual(['HD-T004']);
  });
});

describe('session', () => {
  const meta = (key: string, scenario: string | null, diagnoses: string[]): SessionMeta => ({
    key,
    header: newHeader({ id: `HD-${key}`, startedAt: T0, source: scenario ? 'SIMULATOR' : 'WEB SERIAL', endpoint: 'x', scenario, app: 'x' }),
    entries: 1200,
    bytes: 90_000,
    lastAt: T0 + 42_000,
    diagnoses,
    closed: 'NORMAL',
    fileSha256: null,
  });

  it('lists, replays and exports recorded sessions through the context', async () => {
    const { sys } = await connectedSystem();
    const replayed: string[] = [];
    let exported = 0;
    const c = {
      system: sys,
      navigate: () => {},
      exportReport: () => {},
      sessions: () => [meta('a', 'HD-T001', ['POWER_INSTABILITY:HIGH']), meta('b', null, [])],
      replaySession: (key: string) => replayed.push(key),
      exportSession: () => exported++,
    };
    const list = execute('session list', c);
    expect(list.lines).toHaveLength(2);
    expect(list.lines[0]).toContain('HD-a');
    expect(list.lines[0]).toContain('SIMULATOR HD-T001');
    expect(list.lines[0]).toContain('00:00:42');
    expect(list.lines[0]).toContain('POWER_INSTABILITY:HIGH');
    expect(list.lines[1]).toContain('no findings');
    expect(execute('session replay 2', c).ok).toBe(true);
    expect(execute('session replay 3', c).ok).toBe(false);
    expect(execute('session replay x', c).ok).toBe(false);
    expect(replayed).toEqual(['b']);
    expect(execute('session export', c).ok).toBe(true);
    expect(exported).toBe(1);
    expect(execute('session', c).ok).toBe(false);
  });

  it('says so when nothing is recorded', async () => {
    const { sys } = await connectedSystem();
    const c = { system: sys, navigate: () => {}, exportReport: () => {} };
    expect(execute('session list', c).lines).toEqual(['no recorded session in this browser']);
    expect(execute('session export', c).ok).toBe(false);
  });
});

describe('tokenize', () => {
  it('honors quotes', () => {
    expect(tokenize(`session mark "device reboot"`)).toEqual(['session', 'mark', 'device reboot']);
    expect(tokenize(`serial send 'AT+RST'`)).toEqual(['serial', 'send', 'AT+RST']);
  });
});

describe('execute', () => {
  it('runs the spec examples', async () => {
    const { c, nav, sys, transport, exports } = await ctx();
    expect(execute('sniff usb', c).ok).toBe(true);
    expect(execute('watch power', c).ok).toBe(true);
    expect(execute('probe net 192.168.1.1', c).ok).toBe(true);
    expect(execute('serial 115200', c).ok).toBe(true);
    expect(execute('trace pause', c).ok).toBe(true);
    expect(sys.trace.paused).toBe(true);
    expect(execute('report export', c).ok).toBe(true);
    expect(execute('report export pdf', c).ok).toBe(true);
    expect(execute('report export HTML', c).ok).toBe(true);
    expect(execute('report export docx', c).ok).toBe(false);
    expect(execute('session mark "device reboot"', c).ok).toBe(true);
    expect(nav).toEqual(['USB', 'POWER', 'PROBE']);
    expect(exports).toEqual(['txt', 'pdf', 'html']);
    expect(transport.sent.map((s) => s.cmd)).toEqual(['probe', 'uart.config']);
    expect(sys.trace.all().some((e) => e.message === 'mark: device reboot')).toBe(true);
  });

  it('defaults probe tests and rejects unknown ones', async () => {
    const { c, transport } = await ctx();
    expect(execute('probe net 10.0.0.1 ping warp', c)).toMatchObject({ ok: false });
    expect(transport.sent).toHaveLength(0);
    execute('probe net 10.0.0.1', c);
    expect(transport.sent[0]).toMatchObject({ tests: ['PING', 'DNS', 'TCP'] });
  });

  it('explains failures instead of failing silently', async () => {
    const { c } = await ctx();
    expect(execute('serial fast', c)).toMatchObject({ ok: false });
    expect(execute('frobnicate', c).lines[0]).toBe('unknown command: frobnicate');
    expect(execute('', c)).toMatchObject({ ok: false });
  });

  it('navigates by bare screen name', async () => {
    const { c, nav } = await ctx();
    execute('report', c);
    execute('go bus', c);
    expect(nav).toEqual(['REPORT', 'BUS']);
  });
});
