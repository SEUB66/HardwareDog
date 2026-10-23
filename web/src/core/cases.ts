/**
 * HARDWARE DOG / CASES
 *
 * A case is a recorded incident turned into a regression test:
 *
 *   cases/power/HD-C002.hdlog       the recording, untouched
 *   cases/power/HD-C002.case.json   what replaying it must produce
 *
 * The case names the file by its SHA-256 and states the facts and the
 * diagnosis the replay must reach. Every interesting real fault can
 * become a case without one line of special code: the engine either
 * still explains it the same way, or the test says what changed.
 */

import type { Confidence, DiagnosisId } from './diagnostics';
import { DIAGNOSIS_IDS, RULESET_VERSION } from './diagnostics';
import type { Origin, Recording } from './session';
import { ReplayTransport, parseHdlog } from './session';
import { System, memoryStore } from './system';
import type { Category } from './library';

export const CASE_VERSION = 1;

/** Countable facts a replay must reproduce. Stable names: they live in case files. */
export interface FactSummary {
  undervoltage: number;
  overcurrent: number;
  usbAttaches: number;
  usbDisconnects: number;
  disconnectsAfterDrop: number;
  targetResets: number;
  framingErrors: number;
  rejectedLines: number;
}

/** Every fact a case states: none may be left out, or the case would quietly check less. */
export const FACT_KEYS: readonly (keyof FactSummary)[] = ['undervoltage', 'overcurrent', 'usbAttaches', 'usbDisconnects', 'disconnectsAfterDrop', 'targetResets', 'framingErrors', 'rejectedLines'];

export interface CaseFile {
  case: typeof CASE_VERSION;
  id: string;
  title: string;
  /** Library shelf (core/library.ts): the directory the case sits in. */
  category?: Category;
  recording: { file: string; sha256: string; recording: string; origin: Origin };
  /** What happened, on what hardware, in words. Optional; never affects the check. */
  context?: CaseContext;
  /** Ruleset that produced the expectation. */
  ruleset: number;
  expect: {
    facts: FactSummary;
    /** evidence: the HDP frame sequence numbers each diagnosis must cite. */
    diagnoses: { id: DiagnosisId; confidence: Confidence; evidence?: number[] }[];
  };
}

export interface CaseContext {
  /** What went wrong, as the technician saw it. */
  description: string;
  /** Board, target, supply, cable, network: what a reader needs to reproduce it. */
  hardware: string;
  /** What the hardware should have done. */
  expected?: string;
  notes?: string;
}

const CONTEXT_MAX = 4000;

export function factSummary(sys: System): FactSummary {
  const f = sys.facts;
  return {
    undervoltage: Math.max(f.seen.drops, f.drops.length),
    overcurrent: f.spikes.length,
    usbAttaches: f.attaches.length,
    usbDisconnects: Math.max(f.seen.detaches, f.detaches.length),
    disconnectsAfterDrop: f.detaches.filter((d) => d.dropAt !== null).length,
    targetResets: f.uart.resets.length,
    framingErrors: Math.max(f.uart.errorsAtBaud, f.uart.framingAtBaud.length),
    rejectedLines: sys.frameErrors,
  };
}

/** Replay a recording through the real decoder and rules, as fast as possible. */
export async function replayRecording(recording: Recording): Promise<System> {
  const r = new ReplayTransport(recording);
  const sys = new System(memoryStore(), () => r.clock);
  await sys.boot(r, () => {}, 0);
  return sys;
}

/** The case a replayed recording supports, as the engine sees it now. */
export function caseFrom(
  sys: System,
  recording: Recording,
  fields: { id: string; title: string; file: string; context?: CaseContext; category?: Category },
): CaseFile {
  const integrity = recording.integrity;
  if (!integrity || (integrity.status !== 'VERIFIED' && integrity.status !== 'RECOVERED')) {
    throw new Error(`a case needs a finalized, intact recording (this one is ${integrity?.status ?? 'not from a file'})`);
  }
  return {
    case: CASE_VERSION,
    id: fields.id,
    title: fields.title,
    ...(fields.category ? { category: fields.category } : {}),
    recording: { file: fields.file, sha256: integrity.fileSha256, recording: recording.header.recording, origin: recording.header.origin },
    ...(fields.context ? { context: fields.context } : {}),
    ruleset: RULESET_VERSION,
    expect: {
      facts: factSummary(sys),
      diagnoses: sys.diagnoses.map((d) => ({ id: d.id, confidence: d.confidence, evidence: d.evidence })),
    },
  };
}

export function parseCase(text: string): CaseFile {
  const c = JSON.parse(text) as CaseFile;
  if (c.case !== CASE_VERSION) throw new Error(`not a case v${CASE_VERSION} file`);
  if (!/^[0-9a-f]{64}$/.test(c.recording?.sha256 ?? '')) throw new Error('case: recording.sha256 missing');
  // A file name next to the case, never a path: a case cannot make a reader open anything else.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.hdlog$/.test(c.recording?.file ?? '')) throw new Error('case: recording.file must be a file name next to the case (letters, digits, . _ -, ending .hdlog)');
  if (c.context !== undefined) {
    const x = c.context as unknown as Record<string, unknown>;
    for (const k of ['description', 'hardware'] as const) {
      if (typeof x[k] !== 'string' || (x[k] as string).length > CONTEXT_MAX) throw new Error(`case: context.${k} must be text (${CONTEXT_MAX} characters at most)`);
    }
    for (const k of ['notes', 'expected'] as const) {
      if (x[k] !== undefined && (typeof x[k] !== 'string' || (x[k] as string).length > CONTEXT_MAX)) throw new Error(`case: context.${k} must be text`);
    }
  }
  const facts = c.expect?.facts as unknown as Record<string, unknown> | undefined;
  if (!facts || typeof facts !== 'object') throw new Error('case: expect.facts missing');
  for (const k of FACT_KEYS) if (!Number.isInteger(facts[k]) || (facts[k] as number) < 0) throw new Error(`case: expect.facts.${k} must be a count`);
  for (const k of Object.keys(facts)) if (!(FACT_KEYS as readonly string[]).includes(k)) throw new Error(`case: unknown fact ${k}`);
  if (!Array.isArray(c.expect.diagnoses)) throw new Error('case: expect.diagnoses must be a list (empty: none expected)');
  for (const d of c.expect.diagnoses) {
    if (!(DIAGNOSIS_IDS as readonly string[]).includes(d.id)) throw new Error(`case: unknown diagnosis ${d.id}`);
  }
  return c;
}

/**
 * Check a recording against its case. Returns what differs; empty means
 * the engine still explains the incident exactly as the case says.
 */
export async function checkCase(c: CaseFile, hdlog: string): Promise<string[]> {
  const out: string[] = [];
  const recording = parseHdlog(hdlog);
  const i = recording.integrity!;
  if (i.fileSha256 !== c.recording.sha256) out.push(`file sha256 ${i.fileSha256} is not the one the case names (${c.recording.sha256})`);
  if (i.status !== 'VERIFIED' && i.status !== 'RECOVERED') out.push(`recording integrity is ${i.status}`);
  if (recording.header.recording !== c.recording.recording) out.push('recording id differs');
  if (recording.header.origin !== c.recording.origin) out.push(`origin ${recording.header.origin}, case says ${c.recording.origin}`);
  const sys = await replayRecording(recording);
  const facts = factSummary(sys);
  // every fact of the engine, not only those the file happens to state
  for (const k of FACT_KEYS) {
    const want = (c.expect.facts as Partial<FactSummary>)[k];
    if (want === undefined) out.push(`fact ${k}: the case does not state it`);
    else if (facts[k] !== want) out.push(`fact ${k}: expected ${want}, replay gives ${facts[k]}`);
  }
  const want = c.expect.diagnoses.map((d) => `${d.id}:${d.confidence}`).join(' ') || 'none';
  const got = sys.diagnoses.map((d) => `${d.id}:${d.confidence}`).join(' ') || 'none';
  if (want !== got) out.push(`diagnosis: expected ${want}, replay gives ${got}`);
  for (const d of c.expect.diagnoses) {
    const replayed = sys.diagnoses.find((x) => x.id === d.id);
    if (d.evidence && replayed && d.evidence.join(',') !== replayed.evidence.join(',')) {
      out.push(`evidence of ${d.id}: expected frames ${d.evidence.join(' ')}, replay cites ${replayed.evidence.join(' ')}`);
    }
  }
  return out;
}
