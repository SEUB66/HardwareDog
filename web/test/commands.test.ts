import { describe, expect, it } from 'vitest';
import { execute, tokenize, type Screen } from '../src/core/commands';
import { connectedSystem } from './helpers';

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
    expect(execute('session mark "device reboot"', c).ok).toBe(true);
    expect(nav).toEqual(['USB', 'POWER', 'PROBE']);
    expect(exports).toEqual(['txt']);
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
