/*
 * HARDWARE DOG / COMMAND LINE
 *
 *   hwdog test <dir>                          replay every case in <dir> (and its shelves)
 *   hwdog report <file.hdlog> [--format txt|json|html|pdf] [--out <file>]
 *   hwdog anonymize <file.hdlog> --out <file.hdlog>
 *   hwdog index <dir> [--write]               the library's INDEX.md
 *   hwdog version
 *
 * The same decoder, rules and report code as the interface, run by Node
 * on a recording file. No network, no account: a file in, a verdict out.
 * Build: npm run cli (web/dist-cli/hwdog.mjs).
 */
import { BUILD } from '../core/ascii';
import { anonymize } from '../core/anonymize';
import { checkCase, parseCase, replayRecording, type CaseFile } from '../core/cases';
import { CATEGORIES, libraryIndex, libraryProblems } from '../core/library';
import { RULESET_VERSION } from '../core/diagnostics';
import { buildReport, reportToText } from '../core/report';
import { reportToHtml, reportToPdf } from '../core/reportFormats';
import { parseHdlog } from '../core/session';

interface Fs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string | Uint8Array): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
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

  hwdog test <dir>                          replay every case in <dir> (and its shelves)
  hwdog report <file.hdlog> [--format txt|json|html|pdf] [--out <file>]
  hwdog anonymize <file.hdlog> --out <file.hdlog>
  hwdog index <dir> [--write]               the library's INDEX.md
  hwdog version`;

/** Every case file of a directory and of its category shelves: [shelf or '', file name]. */
function caseFiles(fs: Fs, dir: string): [string, string][] {
  const found: [string, string][] = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.case.json'))
    .map((f): [string, string] => ['', f]);
  for (const shelf of fs.readdirSync(dir).sort()) {
    if (!fs.statSync(`${dir}/${shelf}`).isDirectory()) continue;
    for (const f of fs.readdirSync(`${dir}/${shelf}`)) if (f.endsWith('.case.json')) found.push([shelf, f]);
  }
  return found.sort((a, b) => a[1].localeCompare(b[1]));
}

/** Replay every case of a directory; exit 1 when one does not hold. */
async function testCases(dir: string): Promise<number> {
  const fs = await node<Fs>('fs');
  const files = caseFiles(fs, dir);
  if (files.length === 0) {
    err(`no *.case.json in ${dir}`);
    return 2;
  }
  // A library (cases sorted on shelves) also holds each case to the library rules.
  const library = files.some(([shelf]) => shelf !== '');
  const ids = new Map<string, string>();
  let failed = 0;
  out(`CASES ${dir}   ruleset v${RULESET_VERSION}`);
  out();
  for (const [shelf, f] of files) {
    const at = shelf ? `${dir}/${shelf}` : dir;
    let problems: string[];
    let title = '';
    let origin = '';
    let expected = '';
    try {
      const c = parseCase(fs.readFileSync(`${at}/${f}`, 'utf8'));
      title = c.title;
      origin = c.recording.origin;
      expected = c.expect.diagnoses.map((d) => `${d.id} ${d.confidence}`).join(', ') || 'no finding';
      const hdlog = fs.readFileSync(`${at}/${c.recording.file}`, 'utf8');
      problems = await checkCase(c, hdlog);
      if (library) problems.push(...libraryProblems(c, hdlog, shelf));
      if (ids.has(c.id)) problems.push(`id ${c.id} is already ${ids.get(c.id)}`);
      ids.set(c.id, `${shelf}/${f}`);
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    const id = f.replace(/\.case\.json$/, '');
    out(`${problems.length ? 'FAIL' : 'PASS'}  ${id.padEnd(9)} ${(shelf || '-').padEnd(9)} ${origin.padEnd(10)} ${title}`);
    out(`      -> ${expected}`);
    for (const p of problems) out(`      !! ${p}`);
    if (problems.length) failed++;
  }
  out();
  out(failed ? `${failed} of ${files.length} case(s) FAILED` : `${files.length} case(s) PASS`);
  if (library && fs.existsSync(`${dir}/INDEX.md`)) {
    const index = libraryIndex(files.map(([shelf, f]) => parseCase(fs.readFileSync(`${shelf ? `${dir}/${shelf}` : dir}/${f}`, 'utf8'))));
    if (fs.readFileSync(`${dir}/INDEX.md`, 'utf8') !== index) {
      out(`!! ${dir}/INDEX.md is out of date: hwdog index ${dir} --write`);
      return 1;
    }
  }
  return failed ? 1 : 0;
}

/** The shareable copy of a recording: same incident, nobody named. */
async function anonymizeFile(file: string, args: string[]): Promise<number> {
  const fs = await node<Fs>('fs');
  const k = args.indexOf('--out');
  const target = k >= 0 ? args[k + 1] : undefined;
  if (!target) {
    err('hwdog anonymize <file.hdlog> --out <file.hdlog>');
    return 2;
  }
  const original = fs.readFileSync(file, 'utf8');
  const { hdlog, summary } = anonymize(original);
  // Checked, never assumed: the copy must tell the same incident.
  const [a, b] = await Promise.all([replayRecording(parseHdlog(original)), replayRecording(parseHdlog(hdlog))]);
  const say = (s: typeof a) => JSON.stringify(s.diagnoses.map((d) => [d.id, d.confidence, d.evidence]));
  if (say(a) !== say(b)) {
    err('!! the anonymized copy does not replay to the same diagnosis: not written. Please report this file.');
    return 1;
  }
  fs.writeFileSync(target, hdlog);
  out(`ANONYMIZED ${file} -> ${target}`);
  const kinds = Object.entries(summary.replaced).map(([kind, n]) => `${n} ${kind}`);
  out(`  replaced    ${kinds.join(', ') || 'nothing'}`);
  out(`  diagnosis   unchanged (${b.diagnoses.map((d) => `${d.id} ${d.confidence}`).join(', ') || 'no finding'})`);
  if (summary.textLines) out(`  read them   ${summary.textLines} console / log / note line(s) changed: a secret in plain words cannot be detected`);
  return 0;
}

/** The library's table of contents, from the case files. */
async function index(dir: string, args: string[]): Promise<number> {
  const fs = await node<Fs>('fs');
  const cases: CaseFile[] = [];
  for (const shelf of CATEGORIES) {
    if (!fs.existsSync(`${dir}/${shelf}`)) continue;
    for (const f of fs.readdirSync(`${dir}/${shelf}`)) if (f.endsWith('.case.json')) cases.push(parseCase(fs.readFileSync(`${dir}/${shelf}/${f}`, 'utf8')));
  }
  const text = libraryIndex(cases);
  if (args.includes('--write')) {
    fs.writeFileSync(`${dir}/INDEX.md`, text);
    err(`${dir}/INDEX.md: ${cases.length} case(s)`);
  } else proc.stdout.write(text);
  return 0;
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
  if (cmd === 'anonymize' && arg) return anonymizeFile(arg, rest);
  if (cmd === 'index' && arg) return index(arg.replace(/\/+$/, ''), rest);
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
