/**
 * HARDWARE DOG / ANONYMIZE A RECORDING
 *
 * Before a recording leaves the bench for the incident library, what
 * identifies a person, a network or a device is replaced: the board's
 * factory id, addresses, host names, MACs, e-mails, secrets typed on a
 * console, the port path. The incident stays: every replacement is
 * consistent (the same address is always the same stand-in, two different
 * ones never merge), so the replay gives the same facts, the same
 * diagnosis and the same evidence. That is checked, never assumed.
 *
 * The result is a NEW recording: new seals, a new recording id derived
 * from the original, and a header that says it was anonymized and from
 * which file. The original stays the evidence; this is the copy you share.
 *
 * What it cannot know: a secret written in plain words on a console. The
 * summary lists every console line it changed; read them before sending.
 */

import type { DeviceFrame, HostCommand } from './protocol';
import type { Recording, SessionEntry, SessionHeader } from './session';
import { parseHdlog, toHdlog } from './session';
import { sha256 } from './sha256';

export const ANONYMIZE_VERSION = 1;

/** Addresses for documentation (RFC 5737 / 3849): they never name a real host. */
const IPV4_POOL = (n: number) => `192.0.2.${n}`;
const IPV6_POOL = (n: number) => `2001:db8::${n.toString(16)}`;

export interface AnonymizeSummary {
  /** How many distinct values of each kind were replaced. */
  replaced: Record<string, number>;
  /** Console, log and note lines whose text changed: read them before sharing. */
  textLines: number;
}

/** In free text: patterns that identify something, whatever field they hide in. */
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const SECRET = /\b(pass(?:word|wd|phrase)?|pwd|psk|token|secret|api[_-]?key|key|ssid|user(?:name)?|login)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
/** Hex runs this long are keys, hashes, serials: not boot codes like rst:0x1. */
const LONG_HEX = /\b(?:0x)?[0-9a-f]{16,}\b/gi;
const PATH_USER = /(\/(?:home|Users)\/|[A-Za-z]:\\Users\\)[^/\\\s]+/g;

/** The documentation ranges and the unspecified / loopback addresses say nothing about anyone. */
export const isNeutralIpv4 = (ip: string) => /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(ip) || ip === '0.0.0.0' || ip.startsWith('127.');

class Mapper {
  private readonly maps = new Map<string, Map<string, string>>();
  textLines = 0;

  /** The stand-in for a value of a kind: the same value, the same stand-in. */
  of(kind: string, value: string, make: (n: number) => string): string {
    let m = this.maps.get(kind);
    if (!m) this.maps.set(kind, (m = new Map()));
    let v = m.get(value);
    if (v === undefined) m.set(value, (v = make(m.size + 1)));
    return v;
  }

  ip(value: string): string {
    if (value.includes(':')) return this.of('ipv6', value.toLowerCase(), IPV6_POOL);
    return isNeutralIpv4(value) ? value : this.of('ipv4', value, IPV4_POOL);
  }

  host(value: string): string {
    if (IPV4.test(value) || value.includes(':')) {
      IPV4.lastIndex = 0;
      return this.ip(value);
    }
    IPV4.lastIndex = 0;
    return this.of('host', value.toLowerCase(), (n) => `host-${n}.example`);
  }

  /** Free text: every known value, then every pattern. */
  text(s: string): string {
    let t = s;
    // Values met in structured fields (a device id, a host name) also hide in text.
    for (const [kind, m] of this.maps) {
      if (kind === 'ipv4' || kind === 'ipv6') continue;
      for (const [from, to] of m) if (from.length >= 4) t = t.split(from).join(to);
    }
    t = t.replace(EMAIL, (v) => this.of('email', v.toLowerCase(), (n) => `user-${n}@example.org`));
    t = t.replace(MAC, (v) => this.of('mac', v.toLowerCase(), (n) => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`));
    // A MAC (six groups of two) is not an IPv6 address, stand-in included.
    t = t.replace(IPV6, (v) => (/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(v) ? v : /[a-f]/i.test(v) || v.split(':').length > 3 ? this.ip(v) : v));
    t = t.replace(IPV4, (v) => this.ip(v));
    t = t.replace(SECRET, (_all, k: string, sep: string) => {
      this.of('secret', `${k}${sep}`, () => '');
      return `${k}${sep}<removed>`;
    });
    t = t.replace(LONG_HEX, (v) => this.of('hex', v.toLowerCase(), (n) => `<hex-${n}>`));
    t = t.replace(PATH_USER, (_all, root: string) => `${root}user`);
    if (t !== s) this.textLines++;
    return t;
  }

  summary(): AnonymizeSummary {
    const replaced: Record<string, number> = {};
    for (const [kind, m] of this.maps) replaced[kind] = m.size;
    return { replaced, textLines: this.textLines };
  }
}

function frame(f: DeviceFrame, m: Mapper): DeviceFrame {
  switch (f.type) {
    case 'hello': {
      // The factory id names one board in the world: gone. The 24-bit id is derived from it.
      const { chip: _chip, ...rest } = f as typeof f & { chip?: string };
      return { ...rest, device: m.of('device', f.device, (n) => `HD-ANON${n}`) } as DeviceFrame;
    }
    case 'usb.attach': {
      const a = f as typeof f & { serial?: string | null };
      return (a.serial ? { ...a, serial: m.of('serial', a.serial, (n) => `ANON-${n}`) } : a) as DeviceFrame;
    }
    case 'net.status': {
      const n = f as Extract<DeviceFrame, { type: 'net.status' }>;
      const ip = (v: string | null) => (v === null ? null : m.ip(v));
      return {
        ...n,
        address: ip(n.address),
        gateway: { ...n.gateway, address: ip(n.gateway.address) },
        dns: { ...n.dns, address: ip(n.dns.address) },
      } as DeviceFrame;
    }
    case 'uart.rx':
      return { ...f, data: m.text(f.data) };
    case 'log':
      return { ...f, message: m.text(f.message) };
    case 'i2c.error':
      return { ...f, detail: f.detail === null ? null : m.text(f.detail) } as DeviceFrame;
    case 'probe.result':
      return { ...f, detail: m.text(f.detail) } as DeviceFrame;
    default:
      return anyHops(f, m);
  }
}

/** Frames that carry network hops (a traceroute): their addresses too. */
function anyHops(f: DeviceFrame, m: Mapper): DeviceFrame {
  const x = f as unknown as Record<string, unknown>;
  if (!Array.isArray(x['hops'])) return f;
  return { ...x, hops: (x['hops'] as Record<string, unknown>[]).map((h) => (typeof h['address'] === 'string' ? { ...h, address: m.ip(h['address']) } : h)) } as unknown as DeviceFrame;
}

function command(c: HostCommand, m: Mapper): HostCommand {
  const x = { ...c } as Record<string, unknown>;
  if (typeof x['target'] === 'string') x['target'] = m.host(x['target']);
  if (typeof x['dns'] === 'string') x['dns'] = m.host(x['dns']);
  if (typeof x['upstream'] === 'string') x['upstream'] = m.host(x['upstream']);
  if (typeof x['data'] === 'string') x['data'] = m.text(x['data']);
  return x as unknown as HostCommand;
}

/** Where the data came from, without the port path or the address of the board. */
const endpointOf = (source: string) => `${source} (anonymized)`;

/**
 * The shareable copy of a recording. Refuses a file that is not intact:
 * an anonymized copy of altered evidence would launder it.
 */
export function anonymize(original: string): { hdlog: string; summary: AnonymizeSummary } {
  const r = parseHdlog(original);
  const status = r.integrity?.status;
  if (status !== 'VERIFIED' && status !== 'RECOVERED') throw new Error(`only an intact, finalized recording can be anonymized (this one is ${status ?? 'unknown'})`);
  if (r.header.hdlog < 2) throw new Error('hdlog v1 has no recording id or seals: replay it and save it again first');

  const m = new Mapper();
  // Structured fields first: their values are then also found in free text.
  for (const e of r.entries) {
    if ('cmd' in e) command(e.cmd, m);
    if ('frame' in e && e.frame.type === 'hello') m.of('device', e.frame.device, (n) => `HD-ANON${n}`);
  }
  const entries: SessionEntry[] = r.entries.map((e) => {
    if ('frame' in e) return { ...e, frame: frame(e.frame, m) };
    if ('cmd' in e) return { ...e, cmd: command(e.cmd, m) };
    if ('mark' in e) return { ...e, mark: m.text(e.mark) };
    if ('reject' in e) return 'raw' in e && e.raw !== undefined ? { ...e, reject: m.text(e.reject), raw: m.text(e.raw) } : { ...e, reject: m.text(e.reject) };
    if ('lost' in e) return { ...e, lost: m.text(e.lost) };
    return e;
  });

  const fileSha = r.integrity!.fileSha256;
  const header: SessionHeader & { anonymized: { from: string; version: number } } = {
    ...r.header,
    // Derived, not random: anonymizing the same file twice gives the same bytes.
    recording: sha256(`anonymized:${ANONYMIZE_VERSION}:${r.header.recording}`).slice(0, 32),
    endpoint: endpointOf(r.header.source),
    ...(r.header.dogs ? { dogs: r.header.dogs.map((d) => ({ ...d, endpoint: endpointOf(d.source) })) } : {}),
    anonymized: { from: fileSha, version: ANONYMIZE_VERSION },
  };
  const out: Recording = { header, entries };
  return { hdlog: toHdlog(out), summary: m.summary() };
}

/**
 * What a recording still says about someone. Empty for a file fit to
 * share. Simulated data names no one: there, only e-mails, secrets and
 * user names in paths are looked for (an operator could have typed them).
 */
export function findLeaks(hdlog: string): string[] {
  const leaks: string[] = [];
  const r = parseHdlog(hdlog);
  const say = (where: string, what: string) => leaks.length < 50 && leaks.push(`${where}: ${what}`);
  const scan = (where: string, s: string, physical: boolean) => {
    for (const v of s.match(EMAIL) ?? []) if (!v.endsWith('@example.org')) say(where, `e-mail ${v}`);
    for (const v of s.match(SECRET) ?? []) if (!v.endsWith('<removed>')) say(where, `possible secret "${v.slice(0, 20)}"`);
    for (const v of s.match(PATH_USER) ?? []) if (!/[/\\]user$/.test(v)) say(where, `user name in a path ${v}`);
    if (!physical) return; // invented by the simulator: it names no one
    for (const v of s.match(MAC) ?? []) if (!v.toLowerCase().startsWith('02:00:00:00:00:')) say(where, `MAC address ${v}`);
    for (const v of s.match(LONG_HEX) ?? []) say(where, `long hex value ${v.slice(0, 12)}...`);
    for (const v of s.match(IPV4) ?? []) if (!isNeutralIpv4(v)) say(where, `address ${v}`);
  };
  const physical = r.header.origin === 'PHYSICAL';
  if (physical && !(r.header as { anonymized?: unknown }).anonymized) say('header', 'a recording of real hardware must be anonymized first (hwdog anonymize)');
  scan('header', r.header.endpoint, physical);
  r.entries.forEach((e, k) => {
    const where = `entry ${k + 1}`;
    if ('frame' in e && e.frame.type === 'hello' && (e.frame as { chip?: string }).chip) say(where, 'factory chip id in hello');
    if ('frame' in e && e.frame.type === 'usb.attach' && physical) {
      const serial = (e.frame as { serial?: string | null }).serial;
      if (serial && !/^ANON-\d+$/.test(serial)) say(where, `USB serial number ${serial}`);
    }
    scan(where, JSON.stringify('frame' in e ? e.frame : 'cmd' in e ? e.cmd : e), physical);
  });
  return leaks;
}
