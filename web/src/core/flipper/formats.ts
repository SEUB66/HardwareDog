/**
 * HARDWARE DOG / FLIPPER FILE FORMATS
 *
 * Reads the text files a Flipper Zero saves (the "Flipper File Format":
 * `Key: value` lines, `#` comments), as documented in the firmware's
 * documentation/file_formats (pinned in docs/FLIPPER_LAB.md):
 *
 *   .ir     IR signals file / IR library file   parsed signals, raw timings
 *   .sub    Flipper SubGhz Key File / RAW File  key, RAW timings, BinRAW
 *   .nfc    Flipper NFC device                  UID, ATQA, SAK, pages, blocks
 *   .rfid   Flipper RFID key                    key type, data
 *   .ibtn   Flipper iButton key                 protocol, ROM / SRAM / EEPROM
 *
 * What a file says is kept apart from what it is:
 *   DECODED   the Flipper decoded a protocol and saved its parameters:
 *             there is no waveform in the file, and none is drawn
 *   MEASURED  raw timings the Flipper's receiver recorded: they can be drawn,
 *             because they are the recording
 *
 * Every parser is bounded and refuses what does not fit; a file it cannot
 * read is said to be unreadable, with the line, never half-guessed.
 */

export const FORMAT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxLines: 100_000,
  maxIrTimings: 1024,
  maxTimings: 500_000,
} as const;

export type FileKind = 'ir' | 'subghz' | 'nfc' | 'rfid' | 'ibutton' | 'unknown';

export interface FffEntry {
  line: number;
  key: string;
  value: string;
}

export interface IrParsed {
  name: string;
  type: 'parsed';
  protocol: string;
  address: number[];
  command: number[];
}
export interface IrRaw {
  name: string;
  type: 'raw';
  frequency: number;
  dutyCycle: number;
  /** Microseconds between level changes, as recorded (mark, space, mark...). */
  timings: number[];
}
export type IrSignal = IrParsed | IrRaw;

export interface SubGhz {
  frequency: number;
  preset: string;
  protocol: string;
  /** RAW: microseconds, positive = carrier on, negative = off, as recorded. */
  timings: number[] | null;
  /** Key files: protocol fields (Bit, Key, TE...) as written. */
  key: Record<string, string>;
  binRaw: { te: number; blocks: { bits: number; data: number[] }[] } | null;
}

export interface NfcData {
  deviceType: string;
  uid: number[];
  atqa: number[] | null;
  sak: number[] | null;
  /** Page or block number -> bytes; null bytes are "??" (not read). */
  memory: Map<number, (number | null)[]>;
  memoryUnit: 'page' | 'block' | null;
}

export interface ParsedFile {
  kind: FileKind;
  filetype: string;
  version: number | null;
  entries: FffEntry[];
  warnings: string[];
  ir?: IrSignal[];
  subghz?: SubGhz;
  nfc?: NfcData;
  /** RFID / iButton: the key fields, bytes parsed. */
  key?: { type: string; fields: Record<string, number[] | string> };
}

export class FormatError extends Error {
  readonly code = 'FORMAT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** "EE 87 00 00" -> bytes. "??" -> null where allowed. */
export function hexBytes(value: string, line: number, allowUnknown = false): (number | null)[] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => {
    if (allowUnknown && p === '??') return null;
    if (!/^[0-9A-Fa-f]{2}$/.test(p)) throw new FormatError(`line ${line}: "${p}" is not a hex byte`);
    return parseInt(p, 16);
  });
}

const strictHex = (value: string, line: number) => hexBytes(value, line) as number[];

/** Split a Flipper File Format text into entries. Lines without "key: value" are refused. */
export function readFff(text: string): FffEntry[] {
  if (text.length > FORMAT_LIMITS.maxBytes) throw new FormatError(`larger than ${FORMAT_LIMITS.maxBytes / 1024 / 1024} MiB`);
  const lines = text.split(/\r?\n/);
  if (lines.length > FORMAT_LIMITS.maxLines) throw new FormatError('too many lines');
  const out: FffEntry[] = [];
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (l === '' || l.startsWith('#')) return;
    const at = l.indexOf(':');
    if (at <= 0) throw new FormatError(`line ${i + 1}: expected "Key: value"`);
    out.push({ line: i + 1, key: l.slice(0, at).trim(), value: l.slice(at + 1).trim() });
  });
  return out;
}

function int(e: FffEntry, min = -Infinity, max = Infinity): number {
  if (!/^-?\d+$/.test(e.value)) throw new FormatError(`line ${e.line}: ${e.key} is not an integer`);
  const n = Number(e.value);
  if (n < min || n > max) throw new FormatError(`line ${e.line}: ${e.key} out of range`);
  return n;
}

function kindOf(filetype: string): FileKind {
  if (/^IR (signals|library) file$/i.test(filetype)) return 'ir';
  if (/^Flipper SubGhz (Key|RAW) File$/i.test(filetype)) return 'subghz';
  if (/^Flipper NFC device$/i.test(filetype)) return 'nfc';
  if (/^Flipper RFID key$/i.test(filetype)) return 'rfid';
  if (/^Flipper iButton key$/i.test(filetype)) return 'ibutton';
  return 'unknown';
}

function parseIr(entries: FffEntry[], warnings: string[]): IrSignal[] {
  const signals: IrSignal[] = [];
  let cur: Record<string, FffEntry> | null = null;
  const flush = () => {
    if (!cur) return;
    const name = cur['name']!.value;
    const type = cur['type']?.value;
    if (type === 'parsed') {
      for (const k of ['protocol', 'address', 'command']) if (!cur[k]) throw new FormatError(`signal "${name}": missing ${k}`);
      const address = strictHex(cur['address']!.value, cur['address']!.line);
      const command = strictHex(cur['command']!.value, cur['command']!.line);
      if (address.length !== 4 || command.length !== 4) warnings.push(`signal "${name}": address and command should be 4 bytes`);
      signals.push({ name, type, protocol: cur['protocol']!.value, address, command });
    } else if (type === 'raw') {
      for (const k of ['frequency', 'duty_cycle', 'data']) if (!cur[k]) throw new FormatError(`signal "${name}": missing ${k}`);
      const data = cur['data']!;
      const timings = data.value.split(/\s+/).filter(Boolean).map((v) => {
        if (!/^\d+$/.test(v)) throw new FormatError(`line ${data.line}: timing "${v}" is not a positive integer`);
        return Number(v);
      });
      if (timings.length > FORMAT_LIMITS.maxIrTimings) warnings.push(`signal "${name}": ${timings.length} timings, more than the documented ${FORMAT_LIMITS.maxIrTimings}`);
      const duty = Number(cur['duty_cycle']!.value);
      if (!Number.isFinite(duty) || duty <= 0 || duty > 1) throw new FormatError(`line ${cur['duty_cycle']!.line}: duty_cycle must be in (0, 1]`);
      signals.push({ name, type, frequency: int(cur['frequency']!, 1, 1_000_000), dutyCycle: duty, timings });
    } else {
      throw new FormatError(`signal "${name}": type must be parsed or raw`);
    }
    cur = null;
  };
  for (const e of entries) {
    if (e.key === 'Filetype' || e.key === 'Version') continue;
    if (e.key === 'name') {
      flush();
      cur = { name: e };
      continue;
    }
    if (!cur) throw new FormatError(`line ${e.line}: ${e.key} before any "name:"`);
    cur[e.key] = e;
  }
  flush();
  return signals;
}

function parseSubGhz(entries: FffEntry[], warnings: string[]): SubGhz {
  const get = (k: string) => entries.find((e) => e.key === k);
  const freq = get('Frequency');
  const protocol = get('Protocol');
  if (!freq || !protocol) throw new FormatError('Frequency and Protocol are required');
  const out: SubGhz = { frequency: int(freq, 1, 3_000_000_000), preset: get('Preset')?.value ?? '', protocol: protocol.value, timings: null, key: {}, binRaw: null };
  if (protocol.value === 'RAW') {
    const timings: number[] = [];
    for (const e of entries.filter((x) => x.key === 'RAW_Data')) {
      for (const v of e.value.split(/\s+/).filter(Boolean)) {
        if (!/^-?\d+$/.test(v) || v === '0' || v === '-0') throw new FormatError(`line ${e.line}: "${v}" is not a non-zero integer timing`);
        timings.push(Number(v));
        if (timings.length > FORMAT_LIMITS.maxTimings) throw new FormatError('too many RAW timings');
      }
    }
    for (let i = 1; i < timings.length; i++) {
      if (Math.sign(timings[i]!) === Math.sign(timings[i - 1]!)) {
        warnings.push(`RAW timings ${i - 1} and ${i} have the same sign (the format expects alternating levels)`);
        break;
      }
    }
    out.timings = timings;
  } else if (protocol.value === 'BinRAW') {
    const te = get('TE');
    if (!te) throw new FormatError('BinRAW needs TE');
    const blocks: { bits: number; data: number[] }[] = [];
    let bits: number | null = null;
    for (const e of entries) {
      if (e.key === 'Bit_RAW') bits = int(e, 1, 4096);
      else if (e.key === 'Data_RAW') {
        if (bits === null) throw new FormatError(`line ${e.line}: Data_RAW without Bit_RAW`);
        blocks.push({ bits, data: strictHex(e.value, e.line) });
        bits = null;
      }
    }
    out.binRaw = { te: int(te, 1), blocks };
  } else {
    const skip = new Set(['Filetype', 'Version', 'Frequency', 'Preset', 'Protocol', 'Custom_preset_module', 'Custom_preset_data']);
    for (const e of entries) if (!skip.has(e.key)) out.key[e.key] = e.value;
  }
  return out;
}

function parseNfc(entries: FffEntry[]): NfcData {
  const get = (k: string) => entries.find((e) => e.key === k);
  const type = get('Device type');
  const uid = get('UID');
  if (!type || !uid) throw new FormatError('Device type and UID are required');
  const memory = new Map<number, (number | null)[]>();
  let unit: NfcData['memoryUnit'] = null;
  for (const e of entries) {
    const m = /^(Page|Block) (\d+)$/.exec(e.key);
    if (!m) continue;
    unit = m[1] === 'Page' ? 'page' : 'block';
    memory.set(Number(m[2]), hexBytes(e.value, e.line, true));
  }
  const atqa = get('ATQA');
  const sak = get('SAK');
  return {
    deviceType: type.value,
    uid: strictHex(uid.value, uid.line),
    atqa: atqa ? strictHex(atqa.value, atqa.line) : null,
    sak: sak ? strictHex(sak.value, sak.line) : null,
    memory,
    memoryUnit: unit,
  };
}

function parseKey(entries: FffEntry[], typeKey: string): { type: string; fields: Record<string, number[] | string> } {
  const type = entries.find((e) => e.key === typeKey);
  if (!type) throw new FormatError(`${typeKey} is required`);
  const fields: Record<string, number[] | string> = {};
  for (const e of entries) {
    if (e.key === 'Filetype' || e.key === 'Version' || e.key === typeKey) continue;
    fields[e.key] = /Data$/.test(e.key) ? strictHex(e.value, e.line) : e.value;
  }
  return { type: type.value, fields };
}

/** Parse a Flipper file. Bytes that are not text, or not this format, throw FormatError. */
export function parseFlipperFile(input: string | Uint8Array): ParsedFile {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    if (input.length > FORMAT_LIMITS.maxBytes) throw new FormatError(`larger than ${FORMAT_LIMITS.maxBytes / 1024 / 1024} MiB`);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      throw new FormatError('not UTF-8 text');
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new FormatError('binary content, not a Flipper text file');
  const entries = readFff(text);
  const ft = entries[0];
  if (!ft || ft.key !== 'Filetype') throw new FormatError('the first entry must be "Filetype:"');
  const v = entries[1]?.key === 'Version' ? entries[1] : null;
  const version = v ? int(v, 0) : null;
  const kind = kindOf(ft.value);
  const warnings: string[] = [];
  const out: ParsedFile = { kind, filetype: ft.value, version, entries, warnings };
  if (kind === 'ir') out.ir = parseIr(entries, warnings);
  else if (kind === 'subghz') out.subghz = parseSubGhz(entries, warnings);
  else if (kind === 'nfc') out.nfc = parseNfc(entries);
  else if (kind === 'rfid') out.key = parseKey(entries, 'Key type');
  else if (kind === 'ibutton') out.key = parseKey(entries, version === 1 ? 'Key type' : 'Protocol');
  return out;
}

/** The kind from a path alone, before reading it. */
export function kindFromPath(path: string): FileKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return ({ ir: 'ir', sub: 'subghz', nfc: 'nfc', rfid: 'rfid', ibtn: 'ibutton' } as Record<string, FileKind>)[ext] ?? 'unknown';
}

/** Statistics of recorded timings. Measured by the Flipper, summed here. */
export function timingStats(timings: readonly number[]): { count: number; totalUs: number; minUs: number; maxUs: number } | null {
  if (timings.length === 0) return null;
  let total = 0;
  let min = Infinity;
  let max = 0;
  for (const t of timings) {
    const a = Math.abs(t);
    total += a;
    if (a < min) min = a;
    if (a > max) max = a;
  }
  return { count: timings.length, totalUs: total, minUs: min, maxUs: max };
}

// ------------------------------------------------------------ comparison

export interface FieldDiff {
  where: string;
  a: string;
  b: string;
}

const hex = (bs: readonly (number | null)[]) => bs.map((b) => (b === null ? '??' : b.toString(16).toUpperCase().padStart(2, '0'))).join(' ');

/** Differences between two captures of the same kind. Different kinds are not comparable, and are said to be. */
export function compareParsed(a: ParsedFile, b: ParsedFile): { comparable: boolean; reason?: string; diffs: FieldDiff[] } {
  if (a.kind !== b.kind || a.kind === 'unknown') return { comparable: false, reason: `${a.kind} and ${b.kind} cannot be compared`, diffs: [] };
  const diffs: FieldDiff[] = [];
  const push = (where: string, x: unknown, y: unknown) => {
    const sx = typeof x === 'string' ? x : JSON.stringify(x ?? null);
    const sy = typeof y === 'string' ? y : JSON.stringify(y ?? null);
    if (sx !== sy) diffs.push({ where, a: sx, b: sy });
  };
  /** Two timing lists: the first value that differs, or their sizes when they do not line up. */
  const timings = (where: string, x: readonly number[], y: readonly number[]) => {
    const sx = timingStats(x);
    const sy = timingStats(y);
    const first = x.length === y.length ? x.findIndex((t, k) => t !== y[k]) : -1;
    if (first >= 0) push(`${where} value ${first + 1}`, `${x[first]} us`, `${y[first]} us`);
    else push(where, `${sx?.count ?? 0} values, ${sx?.totalUs ?? 0} us`, `${sy?.count ?? 0} values, ${sy?.totalUs ?? 0} us`);
  };
  if (a.kind === 'ir') {
    // IR files often name several signals alike (POWER twice): paired by name and rank, never the first one only.
    const byName = (list: readonly IrSignal[]) => {
      const m = new Map<string, IrSignal[]>();
      for (const s of list) m.set(s.name, [...(m.get(s.name) ?? []), s]);
      return m;
    };
    const as = byName(a.ir ?? []);
    const bs = byName(b.ir ?? []);
    for (const n of new Set([...as.keys(), ...bs.keys()])) {
      const xs = as.get(n) ?? [];
      const ys = bs.get(n) ?? [];
      const several = xs.length > 1 || ys.length > 1;
      if (several) push(`signals named ${n}`, String(xs.length), String(ys.length));
      for (let k = 0; k < Math.max(xs.length, ys.length); k++) {
        const label = several ? `${n} #${k + 1}` : n;
        const x = xs[k];
        const y = ys[k];
        if (!x || !y) {
          push(`signal ${label}`, x ? 'present' : 'absent', y ? 'present' : 'absent');
          continue;
        }
        if (x.type !== y.type) push(`signal ${label} type`, x.type, y.type);
        else if (x.type === 'parsed' && y.type === 'parsed') {
          push(`signal ${label} protocol`, x.protocol, y.protocol);
          push(`signal ${label} address`, hex(x.address), hex(y.address));
          push(`signal ${label} command`, hex(x.command), hex(y.command));
        } else if (x.type === 'raw' && y.type === 'raw') {
          push(`signal ${label} frequency`, String(x.frequency), String(y.frequency));
          timings(`signal ${label} timings`, x.timings, y.timings);
        }
      }
    }
  } else if (a.kind === 'subghz') {
    const x = a.subghz!;
    const y = b.subghz!;
    push('frequency', String(x.frequency), String(y.frequency));
    push('preset', x.preset, y.preset);
    push('protocol', x.protocol, y.protocol);
    for (const k of [...new Set([...Object.keys(x.key), ...Object.keys(y.key)])]) push(k, x.key[k] ?? '', y.key[k] ?? '');
    if (x.timings || y.timings) timings('RAW timings', x.timings ?? [], y.timings ?? []);
  } else if (a.kind === 'nfc') {
    const x = a.nfc!;
    const y = b.nfc!;
    push('device type', x.deviceType, y.deviceType);
    push('UID', hex(x.uid), hex(y.uid));
    push('ATQA', hex(x.atqa ?? []), hex(y.atqa ?? []));
    push('SAK', hex(x.sak ?? []), hex(y.sak ?? []));
    const keys = [...new Set([...x.memory.keys(), ...y.memory.keys()])].sort((p, q) => p - q);
    for (const k of keys) push(`${x.memoryUnit ?? y.memoryUnit ?? 'block'} ${k}`, hex(x.memory.get(k) ?? []), hex(y.memory.get(k) ?? []));
  } else {
    push('type', a.key!.type, b.key!.type);
    for (const k of [...new Set([...Object.keys(a.key!.fields), ...Object.keys(b.key!.fields)])]) {
      const fx = a.key!.fields[k];
      const fy = b.key!.fields[k];
      push(k, Array.isArray(fx) ? hex(fx) : (fx ?? ''), Array.isArray(fy) ? hex(fy) : (fy ?? ''));
    }
  }
  return { comparable: true, diffs };
}

export { hex as hexString };
