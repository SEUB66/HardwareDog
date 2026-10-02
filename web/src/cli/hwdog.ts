/*
 * HARDWARE DOG / COMMAND LINE
 *
 *   hwdog test <dir>                          replay every case in <dir>
 *   hwdog report <file.hdlog> [--format txt|json|html|pdf] [--out <file>]
 *   hwdog version
 *
 * The same decoder, rules and report code as the interface, run by Node
 * on a recording file. No network, no account: a file in, a verdict out.
 * Build: npm run cli (web/dist-cli/hwdog.mjs).
 */
import { BUILD } from '../core/ascii';
import { checkCase, parseCase, replayRecording } from '../core/cases';
import { RULESET_VERSION } from '../core/diagnostics';
import { buildReport, reportToText } from '../core/report';
import { reportToHtml, reportToPdf } from '../core/reportFormats';
import { parseHdlog } from '../core/session';

interface Fs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string | Uint8Array): void;
  readdirSync(path: string): string[];
}
interface Proc {
  argv: string[];
  exitCode?: number;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
}

const proc = (globalThis as unknown as { process: Proc }).process;
const out = (s = '') => proc.stdout.write(s + '\n');
const err = (s: string) => proc.stderr.write(s + '\n');
// Kept out of the bundle's static imports: the interface never loads node modules.
const node = async <T>(name: string) => (await import(/* @vite-ignore */ ['node', name].join(':'))) as T;

const USAGE = `hwdog ${BUILD}  ruleset v${RULESET_VERSION}

  hwdog test <dir>                          replay every case in <dir>
  hwdog report <file.hdlog> [--format txt|json|html|pdf] [--out <file>]
  hwdog version`;

/** Replay every case of a directory; exit 1 when one does not hold. */
async function testCases(dir: string): Promise<number> {
  const fs = await node<Fs>('fs');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.case.json')).sort();
  if (files.length === 0) {
    err(`no *.case.json in ${dir}`);
    return 2;
  }
  let failed = 0;
  out(`CASES ${dir}   ruleset v${RULESET_VERSION}`);
  out();
  for (const f of files) {
    let problems: string[];
    let title = '';
    let origin = '';
    let expected = '';
    try {
      const c = parseCase(fs.readFileSync(`${dir}/${f}`, 'utf8'));
      title = c.title;
      origin = c.recording.origin;
      expected = c.expect.diagnoses.map((d) => `${d.id} ${d.confidence}`).join(', ') || 'no finding';
      problems = await checkCase(c, fs.readFileSync(`${dir}/${c.recording.file}`, 'utf8'));
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    const id = f.replace(/\.case\.json$/, '');
    out(`${problems.length ? 'FAIL' : 'PASS'}  ${id.padEnd(9)} ${origin.padEnd(10)} ${title}`);
    out(`      -> ${expected}`);
    for (const p of problems) out(`      !! ${p}`);
    if (problems.length) failed++;
  }
  out();
  out(failed ? `${failed} of ${files.length} case(s) FAILED` : `${files.length} case(s) PASS`);
  return failed ? 1 : 0;
}

/** A report from a recording, offline, in any format. */
async function report(file: string, args: string[]): Promise<number> {
  const fs = await node<Fs>('fs');
  const opt = (name: string) => {
    const k = args.indexOf(name);
    return k >= 0 ? args[k + 1] : undefined;
  };
  const format = (opt('--format') ?? 'txt').toLowerCase();
  if (!['txt', 'json', 'html', 'pdf'].includes(format)) {
    err('--format must be txt, json, html or pdf');
    return 2;
  }
  const recording = parseHdlog(fs.readFileSync(file, 'utf8'));
  const sys = await replayRecording(recording);
  const r = buildReport(sys);
  const content =
    format === 'pdf'
      ? reportToPdf(r)
      : format === 'html'
        ? reportToHtml(r)
        : format === 'json'
          ? JSON.stringify({ report: r, trace: sys.trace.all() }, null, 2)
          : reportToText(r);
  const target = opt('--out');
  if (target) {
    fs.writeFileSync(target, content);
    err(`${format.toUpperCase()} report of ${file} -> ${target} (integrity ${recording.integrity?.status ?? 'unknown'})`);
  } else if (typeof content === 'string') {
    proc.stdout.write(content);
  } else {
    err('a PDF goes to a file: --out <file.pdf>');
    return 2;
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg, ...rest] = argv;
  if (cmd === 'version') {
    out(`hwdog ${BUILD} ruleset v${RULESET_VERSION}`);
    return 0;
  }
  if (cmd === 'test' && arg) return testCases(arg.replace(/\/+$/, ''));
  if (cmd === 'report' && arg) return report(arg, rest);
  err(USAGE);
  return 2;
}

main(proc.argv.slice(2)).then(
  (code) => (proc.exitCode = code),
  (e: unknown) => {
    err(`hwdog: ${e instanceof Error ? e.message : String(e)}`);
    proc.exitCode = 1;
  },
);
