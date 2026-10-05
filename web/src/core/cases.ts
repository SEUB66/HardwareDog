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
    undervoltage: f.drops.length,
    overcurrent: f.spikes.length,
    usbAttaches: f.attaches.length,
    usbDisconnects: f.detaches.length,
    disconnectsAfterDrop: f.detaches.filter((d) => d.dropAt !== null).length,
    targetResets: f.uart.resets.length,
    framingErrors: f.uart.framingAtBaud.length,
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
  if (c.context !== undefined) {
    const x = c.context as unknown as Record<string, unknown>;
    for (const k of ['description', 'hardware'] as const) {
      if (typeof x[k] !== 'string' || (x[k] as string).length > CONTEXT_MAX) throw new Error(`case: context.${k} must be text (${CONTEXT_MAX} characters at most)`);
    }
    for (const k of ['notes', 'expected'] as const) {
      if (x[k] !== undefined && (typeof x[k] !== 'string' || (x[k] as string).length > CONTEXT_MAX)) throw new Error(`case: context.${k} must be text`);
    }
  }
  for (const d of c.expect?.diagnoses ?? []) {
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
  for (const [k, v] of Object.entries(c.expect.facts)) {
    const got = facts[k as keyof FactSummary];
    if (got !== v) out.push(`fact ${k}: expected ${v}, replay gives ${got}`);
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
