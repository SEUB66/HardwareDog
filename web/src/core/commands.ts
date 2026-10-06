import type { SessionMeta } from './archive';
import type { System } from './system';
import { bytes, clockShort, duration } from './format';
import { METROLOGY, measurementLines } from './report';
import { SCENARIOS, SCENARIO_IDS, isScenarioId, type ScenarioId } from './scenarios';
import type { ProbeTest } from './types';
import { PROBE_TESTS } from './types';

export const SCREENS = ['STATUS', 'TRACE', 'POWER', 'USB', 'SERIAL', 'BUS', 'NET', 'PROBE', 'REPORT', 'SETUP'] as const;
export type Screen = (typeof SCREENS)[number] | 'HELP';

/** TXT for any terminal, JSON for machines, HTML and PDF for a ticket. */
export const REPORT_FORMATS = ['txt', 'json', 'html', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface CommandContext {
  system: System;
  navigate(screen: Screen): void;
  exportReport(format: ReportFormat): void;
  /** Restart the simulator on a fault scenario (new session). */
  simulate?(scenario: ScenarioId): void;
  /** Archived sessions, newest first. */
  sessions?(): readonly SessionMeta[];
  /** Save the current session as an .hdlog file. */
  exportSession?(): void;
  /** Replay an archived session (new, read-only session). */
  replaySession?(key: string): void;
}

export interface CommandOutput {
  ok: boolean;
  lines: string[];
}

export interface CommandSpec {
  usage: string;
  summary: string;
}

/** Shown by `help` and used for completion in the command palette. */
export const COMMANDS: CommandSpec[] = [
  { usage: 'help', summary: 'list commands' },
  { usage: 'sniff <usb|power|serial|bus|net>', summary: 'open a passive view' },
  { usage: 'watch <power|usb|serial|bus|net>', summary: 'open a view and resume the trace' },
  { usage: 'probe net <target> [ping dns tcp http]', summary: 'ACTIVE: run network tests' },
  { usage: 'probe i2c', summary: 'ACTIVE: scan the I2C bus' },
  { usage: 'i2c watch <seconds|off>', summary: 'ACTIVE: scan the I2C bus periodically, log what changes' },
  { usage: 'net watch <seconds|off> [dns-name] [upstream-host]', summary: 'ACTIVE: ping gateway, resolve, reach upstream, periodically' },
  { usage: 'usb enumerate', summary: 'ACTIVE: re-read USB descriptors' },
  { usage: 'usb follow <VID:PID [serial]|off>', summary: "this computer: the USB device to follow as the target" },
  { usage: 'serial <baud>', summary: 'set UART baud rate' },
  { usage: 'meter', summary: 'what the power numbers are worth: sensor, range, accuracy' },
  { usage: 'meter point <V> <mA>', summary: 'calibration: what the reference instrument reads now' },
  { usage: 'meter cal "<reference>"', summary: 'ACTIVE: fit the points, store the calibration on the device' },
  { usage: 'meter clear', summary: 'ACTIVE: remove the calibration (datasheet accuracy)' },
  { usage: 'serial send "<text>"', summary: 'ACTIVE: write a line to the target UART' },
  { usage: 'trace <pause|resume|clear>', summary: 'control the trace view' },
  { usage: 'report export [txt|json|html|pdf]', summary: 'save the diagnostic report locally' },
  { usage: 'session mark "<text>"', summary: 'add a marker to the timeline' },
  { usage: 'session export', summary: 'save this session as .hdlog, replayable anywhere' },
  { usage: 'session list', summary: 'sessions recorded in this browser' },
  { usage: 'session replay <n>', summary: 'replay a recorded session (read-only, new session)' },
  { usage: 'sound <on|off>', summary: 'startup beep' },
  { usage: 'theme <dark|light>', summary: 'dark, or light pale grey' },
  { usage: 'field <on|off>', summary: 'high-contrast field mode' },
  { usage: 'go <screen>', summary: 'open a screen by name' },
  { usage: 'sim list', summary: 'list simulator fault scenarios' },
  { usage: 'sim <HD-T000..HD-T013>', summary: 'restart the simulator on a scenario (new session)' },
];

/** Split on whitespace, honoring "double" and 'single' quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  return tokens;
}

const ok = (...lines: string[]): CommandOutput => ({ ok: true, lines });
const fail = (...lines: string[]): CommandOutput => ({ ok: false, lines });

const VIEW_ALIASES: Record<string, Screen> = {
  usb: 'USB',
  power: 'POWER',
  serial: 'SERIAL',
  uart: 'SERIAL',
  bus: 'BUS',
  i2c: 'BUS',
  net: 'NET',
  network: 'NET',
};

function screenFor(name: string | undefined): Screen | null {
  if (!name) return null;
  const upper = name.toUpperCase();
  if ((SCREENS as readonly string[]).includes(upper)) return upper as Screen;
  if (upper === 'HELP') return 'HELP';
  return VIEW_ALIASES[name.toLowerCase()] ?? null;
}

function onOff(arg: string | undefined): boolean | null {
  if (arg === 'on') return true;
  if (arg === 'off') return false;
  return null;
}

/** One line per archived session: id, source, length, size, findings. */
export function describeSession(m: SessionMeta): string {
  const h = m.header;
  const source = `${h.source}${h.scenario ? ` ${h.scenario}` : ''}`;
  const found = m.diagnoses.length ? m.diagnoses.join(' ') : 'no findings';
  return `${h.id}  ${clockShort(h.startedAt)}  ${source.padEnd(18)}${duration(m.lastAt - h.startedAt).padStart(8)}  ${bytes(m.bytes).padStart(8)}  ${found}`;
}

/** YYYY-MM-DD in the operator's time zone: the day the calibration was done. */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What the power numbers are worth, in plain lines (same wording as the report). */
function describeMeter(sys: System): CommandOutput {
  const lines = measurementLines(sys.meter).map(([k, v]) => `${k.padEnd(14)}${v}`);
  if (sys.calPoints.length) lines.push(`${'POINTS'.padEnd(14)}${sys.calPoints.length} waiting: meter cal "<reference>"`);
  return ok(...lines, METROLOGY);
}

/**
 * Run one command line. The command layer calls exactly the same System
 * methods as the buttons in the interface.
 */
export function execute(input: string, ctx: CommandContext): CommandOutput {
  const [rawVerb, ...args] = tokenize(input.trim());
  if (!rawVerb) return fail('empty command');
  const verb = rawVerb.toLowerCase();
  const a0 = args[0]?.toLowerCase();
  const sys = ctx.system;
  const result = (err: string | null, success: string) => (err ? fail(err) : ok(success));

  // A screen name alone opens that screen, even when it is also a verb.
  const bare = screenFor(verb);
  if (bare && bare !== 'HELP' && args.length === 0) {
    ctx.navigate(bare);
    return ok(`-> ${bare}`);
  }

  switch (verb) {
    case 'help':
    case '?':
      return ok(...COMMANDS.map((c) => `${c.usage.padEnd(40)}${c.summary}`));

    case 'go': {
      const s = screenFor(a0);
      if (!s) return fail(`unknown screen: ${args[0] ?? ''}`, `screens: ${SCREENS.join(' ')}`);
      ctx.navigate(s);
      return ok(`-> ${s}`);
    }

    case 'sniff':
    case 'watch': {
      const s = screenFor(a0);
      if (!s || !Object.values(VIEW_ALIASES).includes(s)) return fail(`usage: ${verb} <usb|power|serial|bus|net>`);
      ctx.navigate(s);
      if (verb === 'watch' && sys.trace.paused) sys.resumeTrace();
      return ok(`${verb === 'sniff' ? 'sniffing' : 'watching'} ${s} (passive)`);
    }

    case 'probe': {
      if (a0 === 'i2c' || a0 === 'bus') return result(sys.scanI2c(), 'i2c scan started: address probe 0x08-0x77');
      if (a0 !== 'net') return fail('usage: probe net <target> [ping dns tcp http] | probe i2c');
      const target = args[1];
      if (!target) return fail('usage: probe net <target> [ping dns tcp http]');
      const requested = args.slice(2).map((x) => x.toUpperCase());
      const unknown = requested.filter((x) => !(PROBE_TESTS as readonly string[]).includes(x));
      if (unknown.length) return fail(`unknown test(s): ${unknown.join(' ')}`, `tests: ${PROBE_TESTS.join(' ')}`);
      const tests = (requested.length ? requested : ['PING', 'DNS', 'TCP']) as ProbeTest[];
      const run = sys.probe(target, tests);
      if (typeof run === 'string') return fail(run);
      ctx.navigate('PROBE');
      return ok(`probe ${run.id} -> ${run.target}: ${run.tests.join(' ')}`);
    }

    case 'i2c': {
      if (a0 !== 'watch' || !args[1]) return fail('usage: i2c watch <seconds|off>');
      const sec = args[1].toLowerCase() === 'off' ? 0 : Number(args[1]);
      return result(sys.watchI2c(sec), sec ? `i2c watch every ${sec} s (ACTIVE)` : 'i2c watch off');
    }

    case 'net': {
      if (a0 !== 'watch' || !args[1]) return fail('usage: net watch <seconds|off> [dns-name] [upstream-host]');
      const sec = args[1].toLowerCase() === 'off' ? 0 : Number(args[1]);
      return result(sys.watchNet(sec, args[2], args[3]), sec ? `net watch every ${sec} s (ACTIVE)` : 'net watch off');
    }

    case 'usb': {
      if (a0 === 'enumerate') return result(sys.enumerateUsb(), 'enumeration requested');
      if (a0 !== 'follow' || !args[1]) return fail('usage: usb enumerate | usb follow <VID:PID [serial]|off>');
      if (args[1].toLowerCase() === 'off') return result(sys.followUsb(null), 'usb follow off');
      const m = /^([0-9a-f]{4}):([0-9a-f]{4})$/i.exec(args[1]);
      if (!m) return fail('usage: usb follow <VID:PID [serial]|off>', 'VID and PID in hex, e.g. 046D:C52B');
      const target = { vid: parseInt(m[1]!, 16), pid: parseInt(m[2]!, 16), serial: args[2] ?? null };
      return result(sys.followUsb(target), `usb follow ${args[1].toUpperCase()}`);
    }

    case 'serial': {
      if (a0 === 'send') {
        const text = args.slice(1).join(' ');
        if (!text) return fail('usage: serial send "<text>"');
        return result(sys.sendSerial(text), `tx: ${text}`);
      }
      const baud = Number(args[0]);
      if (!args[0] || !Number.isFinite(baud)) return fail('usage: serial <baud> | serial send "<text>"');
      return result(sys.setBaud(baud), `baud -> ${baud}`);
    }

    case 'meter': {
      if (!a0) return describeMeter(sys);
      if (a0 === 'point') {
        const v = Number(args[1]);
        const ma = Number(args[2]);
        if (!args[2] || !Number.isFinite(v) || !Number.isFinite(ma)) return fail('usage: meter point <V> <mA>   (what the reference reads now)');
        return result(sys.addCalPoint(v, ma / 1000), `point ${sys.calPoints.length + 1}: reference ${v} V ${ma} mA`);
      }
      if (a0 === 'cal') {
        const ref = args.slice(1).join(' ');
        if (!ref) return fail('usage: meter cal "<reference instrument>"');
        const n = sys.calPoints.length;
        return result(sys.applyCalibration(ref, localDate(new Date())), `calibration from ${n} points against ${ref} sent to the device`);
      }
      if (a0 === 'clear') return result(sys.clearCalibration(), 'calibration removed: datasheet accuracy');
      return fail('usage: meter | meter point <V> <mA> | meter cal "<reference>" | meter clear');
    }

    case 'trace':
      if (a0 === 'pause') {
        sys.pauseTrace();
        return ok('trace view paused, recording continues');
      }
      if (a0 === 'resume') {
        sys.resumeTrace();
        return ok('trace view live');
      }
      if (a0 === 'clear') {
        sys.clearTrace();
        return ok('trace cleared');
      }
      return fail('usage: trace <pause|resume|clear>');

    case 'report': {
      if (a0 !== 'export') return fail('usage: report export [txt|json|html|pdf]');
      const fmt = (args[1]?.toLowerCase() ?? 'txt') as ReportFormat;
      if (!REPORT_FORMATS.includes(fmt)) return fail('format must be txt, json, html or pdf');
      ctx.exportReport(fmt);
      return ok(`report exported (${fmt}), saved locally`);
    }

    case 'session': {
      const usage = 'usage: session mark "<text>" | session export | session list | session replay <n>';
      if (a0 === 'mark') {
        const text = args.slice(1).join(' ');
        if (!text) return fail('usage: session mark "<text>"');
        sys.mark(text);
        return ok(`marked: ${text}`);
      }
      if (a0 === 'export') {
        if (!ctx.exportSession) return fail('session export is not available here');
        ctx.exportSession();
        return ok('session saved as .hdlog, locally');
      }
      const list = ctx.sessions?.() ?? [];
      if (a0 === 'list') {
        if (list.length === 0) return ok('no recorded session in this browser');
        return ok(...list.map((m, n) => `${String(n + 1).padStart(2)}  ${describeSession(m)}`));
      }
      if (a0 === 'replay') {
        const n = Number(args[1]);
        const m = Number.isInteger(n) ? list[n - 1] : undefined;
        if (!m) return fail('usage: session replay <n>', 'type session list');
        if (!ctx.replaySession) return fail('replay is not available here');
        ctx.replaySession(m.key);
        return ok(`replaying ${m.header.id}, read-only, new session`);
      }
      return fail(usage);
    }

    case 'sim': {
      if (!a0 || a0 === 'list') return ok(...SCENARIO_IDS.map((id) => `${id}  ${SCENARIOS[id].title.padEnd(30)}${SCENARIOS[id].fault}`));
      const id = a0.toUpperCase();
      if (!isScenarioId(id)) return fail(`unknown scenario: ${args[0]}`, 'type sim list');
      if (!ctx.simulate) return fail('scenario switching is not available here');
      ctx.simulate(id);
      return ok(`simulator -> ${id} ${SCENARIOS[id].title}, new session`);
    }

    case 'theme': {
      if (a0 !== 'dark' && a0 !== 'light') return fail('usage: theme <dark|light>');
      sys.updateSettings({ theme: a0 });
      return ok(`theme ${a0}`);
    }

    case 'sound':
    case 'field': {
      const v = onOff(a0);
      if (v === null) return fail(`usage: ${verb} <on|off>`);
      sys.updateSettings(verb === 'sound' ? { sound: v } : { fieldMode: v });
      return ok(`${verb} ${v ? 'on' : 'off'}`);
    }

    default:
      return fail(`unknown command: ${rawVerb}`, 'type help for the command list');
  }
}
