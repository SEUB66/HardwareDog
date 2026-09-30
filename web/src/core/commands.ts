import type { System } from './system';
import { SCENARIOS, SCENARIO_IDS, isScenarioId, type ScenarioId } from './scenarios';
import type { ProbeTest } from './types';
import { PROBE_TESTS } from './types';

export const SCREENS = ['STATUS', 'TRACE', 'POWER', 'USB', 'SERIAL', 'BUS', 'NET', 'PROBE', 'REPORT', 'SETUP'] as const;
export type Screen = (typeof SCREENS)[number] | 'HELP';

export interface CommandContext {
  system: System;
  navigate(screen: Screen): void;
  exportReport(format: 'txt' | 'json'): void;
  /** Restart the simulator on a fault scenario (new session). */
  simulate?(scenario: ScenarioId): void;
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
  { usage: 'usb enumerate', summary: 'ACTIVE: re-read USB descriptors' },
  { usage: 'serial <baud>', summary: 'set UART baud rate' },
  { usage: 'serial send "<text>"', summary: 'ACTIVE: write a line to the target UART' },
  { usage: 'trace <pause|resume|clear>', summary: 'control the trace view' },
  { usage: 'report export [txt|json]', summary: 'save the diagnostic report locally' },
  { usage: 'session mark "<text>"', summary: 'add a marker to the timeline' },
  { usage: 'sound <on|off>', summary: 'startup beep' },
  { usage: 'field <on|off>', summary: 'high-contrast field mode' },
  { usage: 'go <screen>', summary: 'open a screen by name' },
  { usage: 'sim list', summary: 'list simulator fault scenarios' },
  { usage: 'sim <HD-T000..HD-T010>', summary: 'restart the simulator on a scenario (new session)' },
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

    case 'usb':
      if (a0 !== 'enumerate') return fail('usage: usb enumerate');
      return result(sys.enumerateUsb(), 'enumeration requested');

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
      if (a0 !== 'export') return fail('usage: report export [txt|json]');
      const fmt = (args[1]?.toLowerCase() ?? 'txt') as 'txt' | 'json';
      if (fmt !== 'txt' && fmt !== 'json') return fail('format must be txt or json');
      ctx.exportReport(fmt);
      return ok(`report exported (${fmt}), saved locally`);
    }

    case 'session': {
      if (a0 !== 'mark') return fail('usage: session mark "<text>"');
      const text = args.slice(1).join(' ');
      if (!text) return fail('usage: session mark "<text>"');
      sys.mark(text);
      return ok(`marked: ${text}`);
    }

    case 'sim': {
      if (!a0 || a0 === 'list') return ok(...SCENARIO_IDS.map((id) => `${id}  ${SCENARIOS[id].title.padEnd(30)}${SCENARIOS[id].fault}`));
      const id = a0.toUpperCase();
      if (!isScenarioId(id)) return fail(`unknown scenario: ${args[0]}`, 'type sim list');
      if (!ctx.simulate) return fail('scenario switching is not available here');
      ctx.simulate(id);
      return ok(`simulator -> ${id} ${SCENARIOS[id].title}, new session`);
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
