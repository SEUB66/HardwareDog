/**
 * HARDWARE DOG / CAMERA SNIFFER / REPORT
 *
 * What was done and what was found, kept apart:
 *   FACTS           what the tools observed (each with its #event when recorded)
 *   INTERPRETATIONS what the classification reads in them, and why
 *   DECLARATIONS    what the person said (known devices, links, objects examined)
 *   TO VERIFY       what is left
 *   LIMITS          what these methods cannot see
 *
 * Its strongest conclusion is "no clue identified with the methods used".
 * It never says a room has no camera, nor that a place is safe.
 *
 * Export: a preview of exactly what leaves, with network identifiers
 * (addresses, MACs, announced names) replaced by stable aliases, and
 * personal notes hidden, when asked. Photos stay in this browser.
 */

import type { Lang } from '../lab/rules';
import { family } from './catalog';
import type { BleDevice } from '../ble/model';
import { bleClues, bleLabel, type BleClue, type UsbClue } from './clues';
import { ITEM_STATUSES, priorityWhy, STATUS_LABEL, type Inspection } from './inspection';
import { classify, namesOf, NOT_ESTABLISHED, STATE_LABEL, STATE_ORDER, type DeviceNote, type NetDevice, type NetState } from './model';

export interface ReportInput {
  inspection: Inspection;
  devices: NetDevice[];
  notes: Map<string, DeviceNote>;
  network: { iface: string | null; network: string | null; methods: string[]; state: string; detail: string; origin: 'PHYSICAL' | 'SIMULATED'; ran: boolean; lost: number; scanNotes: string[] };
  /** ran: a live scan started during this inspection. note: what is on screen but not counted (a replay, an older scan). */
  ble: { ran: boolean; source: string | null; origin: string; clues: BleClue[]; note?: string };
  usb: { ran: boolean; supported: boolean; clues: UsbClue[] };
  generated: number;
  lang: Lang;
}

export interface ReportOptions {
  /** Replace addresses, MACs and announced names with aliases. */
  maskNetwork: boolean;
  /** Hide the place, free-text observations and labels. */
  hidePersonal: boolean;
}

export const CONCLUSION: Record<'none' | 'some' | 'nothing', Record<Lang, string>> = {
  none: { en: 'No clue identified with the methods used.', fr: 'Aucun indice identifié avec les méthodes utilisées.' },
  nothing: { en: 'Nothing was examined: no conclusion.', fr: 'Rien n’a été examiné : aucune conclusion.' },
  some: { en: 'Clues to examine were found with the methods used (see FACTS and TO VERIFY).', fr: 'Des indices à examiner ont été relevés avec les méthodes utilisées (voir FAITS et À VÉRIFIER).' },
};

/** No clue yet, but devices or objects are still unidentified: the strongest conclusion would say too much. */
export const conclusionOpen = (n: number, lang: Lang): string =>
  lang === 'fr'
    ? `Aucun indice identifié pour l’instant avec les méthodes utilisées ; ${n} élément(s) restent à vérifier (voir À VÉRIFIER).`
    : `No clue identified so far with the methods used; ${n} item(s) remain to verify (see TO VERIFY).`;

export const LIMITS = [
  'A camera that records to a memory card, without a network, or that is switched off, can escape every scan.',
  'Network discovery only sees what devices announce on the chosen network: another network (guest Wi-Fi isolation, a mobile connection) is invisible. No answer excludes nothing.',
  'Service discovery is not traffic capture: nothing here observed what devices send.',
  'An unidentified Bluetooth device, or a tracker signature, is not counted as a camera clue; it is not excluded either (an offline iPhone sends the same Apple signature as an AirTag).',
  'An empty USB result excludes nothing: a camera charger declares no data interface.',
  'A visual inspection depends on what can be seen safely: mains devices, fixed equipment and safety detectors were not opened.',
];

const CLUE_STATES: NetState[] = ['VIDEO_COMPATIBLE', 'MODEL_IDENTIFIED', 'CONFIRMED'];

/**
 * Text from a device or a person, made inert in Markdown: one line (a
 * device cannot add a line, a heading or a RESULT of its own), no HTML (a
 * "<!--" cannot hide what follows), no link or image (nothing is loaded
 * when the file is opened in a viewer).
 */
export const md = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\\`<]/g, (c) => `\\${c}`)
    .replace(/\]\(/g, ']\\(');

/** Stable aliases for identifiers, in order of first use. */
class Masker {
  private maps = new Map<string, Map<string, string>>();
  constructor(private readonly on: boolean) {}
  alias(kind: string, value: string | null | undefined): string {
    if (!value) return '';
    if (!this.on) return md(value);
    let m = this.maps.get(kind);
    if (!m) this.maps.set(kind, (m = new Map()));
    if (!m.has(value)) m.set(value, `${kind}-${m.size + 1}`);
    return m.get(value)!;
  }
  /** Identifiers inside free text (a summary, a note someone typed): known values replaced. */
  scrub(text: string): string {
    if (!text) return text;
    if (!this.on) return md(text);
    // longest first: "Camera Bedroom" is replaced whole before "Camera" could cut it
    const known = [...this.maps.values()].flatMap((m) => [...m]).sort((a, b) => b[0].length - a[0].length);
    let t = text;
    for (const [v, a] of known) t = t.split(v).join(a);
    for (const [v, a] of known) if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(v)) t = t.replace(new RegExp(v.split(':').join('[-:.]?'), 'gi'), a);
    // anything that still looks like an identifier
    return md(t)
      .replace(/\b(urn:)?(uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
      .replace(/\buuid:[^\s,;)"]+/gi, 'uuid:[id]')
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '[address]')
      .replace(/\b[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){4}\b/gi, '[mac]')
      .replace(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, '[mac]')
      .replace(/\b[0-9a-f]{12}\b/gi, '[mac]');
  }
}

const ref = (seq: number | undefined) => (seq ? ` [#${seq}]` : '');

export interface Report {
  conclusion: string;
  clues: number;
  text: string;
}

/** What Bluetooth Lab holds, as far as a report needs it. */
export interface BleView {
  sourceKind: string | null;
  scanStartedAt: number | null;
  origin: string;
  state: string;
  replayOf: string | null;
  replayIntegrity: string | null;
  replaySimulated: boolean;
  model: { devices: Map<string, BleDevice> };
}

/**
 * Bluetooth facts are an inspection's only from a live scan started
 * during it: a replay, or an older scan still on screen, is said and never
 * counted as observed here.
 */
export function bleForReport(ble: BleView, inspectionStarted: number): ReportInput['ble'] {
  if (ble.sourceKind !== 'REPLAY' && ble.scanStartedAt !== null && ble.scanStartedAt >= inspectionStarted) {
    return { ran: true, source: ble.sourceKind, origin: ble.origin, clues: bleClues(ble.model.devices.values()) };
  }
  const note =
    ble.state === 'REPLAY' && ble.replayOf
      ? `Bluetooth Lab shows a replay of ${ble.replayOf} (${ble.replayIntegrity ?? 'integrity unknown'}${ble.replaySimulated ? ', SIMULATED' : ''}): not observed during this inspection, not counted.`
      : ble.model.devices.size
        ? 'Bluetooth Lab shows a scan started before this inspection: not counted.'
        : null;
  return { ran: false, source: null, origin: 'PHYSICAL', clues: [], ...(note ? { note } : {}) };
}

export function buildReport(input: ReportInput, options: ReportOptions): Report {
  const m = new Masker(options.maskNetwork);
  // What a person typed can hold an address or a name too: scrubbed like the rest.
  const personal = (s: string) => (options.hidePersonal && s ? '(hidden)' : m.scrub(s));
  const L: string[] = [];
  const insp = input.inspection;
  const simulated = input.network.origin === 'SIMULATED' || input.ble.origin === 'SIMULATED' || input.devices.some((d) => d.origin === 'SIMULATED');

  // pre-register identifiers so the summaries can be scrubbed
  for (const d of input.devices) {
    m.alias('host', d.ip);
    if (d.mac) m.alias('mac', d.mac);
    for (const e of d.evidence) {
      const mac = e.kind === 'neighbor' ? e.summary.match(/as (\S+)$/)?.[1] : undefined;
      if (mac) m.alias('mac', mac);
    }
    for (const n of namesOf(d)) m.alias('name', n.value);
  }

  const devices = input.devices.map((d) => ({ d, c: classify(d, input.notes.get(d.key)) })).sort((a, b) => STATE_ORDER[a.c.state] - STATE_ORDER[b.c.state] || a.d.ip.localeCompare(b.d.ip, undefined, { numeric: true }));
  const items = insp.rooms.flatMap((room) => room.items.map((item) => ({ room, item })));
  const clueDevices = devices.filter(({ c }) => CLUE_STATES.includes(c.state));
  const clueItems = items.filter(({ item }) => item.status === 'NEEDS_CHECK' || item.status === 'CONFIRMED_DOCUMENTED');
  const usbVideo = input.usb.clues.filter((u) => u.video);
  const clues = clueDevices.length + clueItems.length + usbVideo.length;
  const todoItems = items.filter(({ item }) => item.status === 'TO_EXAMINE' || item.status === 'NEEDS_CHECK' || item.status === 'NOT_VERIFIED');
  // A device that announced nothing is still to identify: most cloud cameras announce nothing.
  const todoDevices = devices.filter(({ d, c }) => ['VIDEO_COMPATIBLE', 'MODEL_IDENTIFIED', 'MEDIA_SERVICE', 'UNDETERMINED', 'DISCOVERED'].includes(c.state) && !input.notes.get(d.key)?.known);
  const examined = input.network.ran || input.ble.ran || input.usb.ran || items.some(({ item }) => item.status !== 'TO_EXAMINE');
  const conclusion = clues
    ? CONCLUSION.some[input.lang]
    : todoItems.length + todoDevices.length
      ? conclusionOpen(todoItems.length + todoDevices.length, input.lang)
      : examined
        ? CONCLUSION.none[input.lang]
        : CONCLUSION.nothing[input.lang];

  L.push('# HARDWARE DOG · CAMERA SNIFFER · REPORT', '');
  L.push(`Generated: ${new Date(input.generated).toISOString()}`);
  L.push(`Inspection started: ${new Date(insp.created).toISOString()}${insp.finished ? ` · finished: ${new Date(insp.finished).toISOString()}` : ' · not finished'}`);
  L.push(`Place: ${personal(insp.place) || '(not given)'}`);
  if (simulated) L.push('', '**SIMULATED DATA: this report contains demo devices. It describes no real place.**');
  L.push('', `RESULT: ${conclusion}`, '');

  L.push('## SCOPE AND METHODS', '');
  L.push(
    input.network.ran
      ? `- Network: ${md(input.network.iface ?? '?')} ${m.scrub(input.network.network ?? '')} · methods: ${input.network.methods.join(', ')} · ${input.network.state} · ${m.scrub(input.network.detail)}${input.network.origin === 'SIMULATED' ? ' (SIMULATED)' : ''}`
      : '- Network: not scanned',
  );
  if (input.network.lost) L.push(`  - ${input.network.lost} observation(s) were dropped by the engine (buffer full).`);
  for (const n of input.network.scanNotes) L.push(`  - ${m.scrub(n)}`);
  L.push(input.ble.ran ? `- Bluetooth: ${md(input.ble.source ?? '?')} · ${input.ble.clues.length} device(s) observed${input.ble.origin === 'SIMULATED' ? ' (SIMULATED)' : ''}` : '- Bluetooth: not scanned during this inspection');
  if (input.ble.note) L.push(`  - ${md(input.ble.note)}`);
  L.push(input.usb.ran ? (input.usb.supported ? `- USB: ${input.usb.clues.length} device(s) read` : '- USB: not readable on this system') : '- USB: not read');
  L.push(`- Physical inspection: ${insp.rooms.length} room(s), ${items.length} object(s), ${items.filter(({ item }) => item.status !== 'TO_EXAMINE').length} examined`);
  L.push('');

  L.push('## FACTS (observed by the tools)', '');
  if (!devices.length && !input.ble.clues.length && !input.usb.clues.length) L.push('- Nothing was observed by the tools.');
  for (const { d, c } of devices) {
    L.push(`- ${m.alias('host', d.ip)}${d.mac ? ` · ${m.alias('mac', d.mac)}` : ''}${d.vendor ? ` · MAC prefix registered to ${d.vendor.name}` : ''}${d.origin === 'SIMULATED' ? ' · SIMULATED' : ''}`);
    // every answer an interpretation cites, then the others up to 12; the rest is counted, not hidden
    const cited = new Set(c.reasons.map((r) => r.evidence));
    const shown = d.evidence.filter((e) => cited.has(e.id));
    for (const e of d.evidence) if (shown.length < 12 && !cited.has(e.id)) shown.push(e);
    for (const e of d.evidence.filter((x) => shown.includes(x))) L.push(`  - ${m.scrub(e.summary)} (${e.method})${ref(e.labSeq)}`);
    const more = d.evidence.length - shown.length + (d.dropped ?? 0);
    if (more > 0) L.push(`  - ${more} more answer(s) of the same kinds, not listed (all on the lab timeline)`);
  }
  const trackers = input.ble.clues.filter((c) => c.signature);
  for (const c of trackers) L.push(`- Bluetooth ${m.alias('ble', c.id)}: ${bleLabel(c)} (${c.signature!.source})`);
  const unknownBle = input.ble.clues.length - trackers.length;
  if (unknownBle) L.push(`- Bluetooth: ${unknownBle} device(s) not identified (no reliable signature: not counted as a camera clue, not excluded either).`);
  for (const u of input.usb.clues) L.push(`- USB ${md(u.id)} ${md(u.name)} at ${md(u.port)}: interfaces ${md(u.interfaces.join(', '))}`);
  L.push('');

  L.push('## INTERPRETATIONS (how the classification reads the facts)', '');
  L.push('A state is what the answers support. None of them, alone, confirms a hidden camera: a model reported on the network is what a device says about itself.', '');
  if (!devices.length) L.push('- No network device to interpret.');
  for (const { d, c } of devices) {
    L.push(`- ${m.alias('host', d.ip)}: ${STATE_LABEL[c.state]}${c.model ? ` · model: ${m.scrub(c.model)}` : ''}`);
    for (const r of c.reasons.filter((r) => r.role !== 'USER')) {
      const ev = d.evidence.find((e) => e.id === r.evidence);
      L.push(`  - ${r.role === 'HINT' ? 'hint: ' : ''}${m.scrub(r.text)}${ref(ev?.labSeq)}`);
    }
    L.push(`  - not established: ${NOT_ESTABLISHED[c.state]}`);
  }
  for (const u of usbVideo) L.push(`- USB ${md(u.id)}: ${md(u.reading)}`);
  L.push('');

  L.push('## DECLARATIONS (what you stated)', '');
  let declared = 0;
  for (const { d } of devices) {
    const n = input.notes.get(d.key);
    if (!n) continue;
    if (n.known) {
      L.push(`- ${m.alias('host', d.ip)} marked known${n.label ? `: ${personal(n.label)}` : ''}`);
      declared++;
    }
    if (n.confirmation.trim()) {
      L.push(`- ${m.alias('host', d.ip)} camera confirmed by your verification: ${personal(n.confirmation.trim())}`);
      declared++;
    }
    if (n.ble.length) {
      L.push(`- ${m.alias('host', d.ip)} linked by hand to Bluetooth ${n.ble.map((k) => m.alias('ble', k.split('|').pop())).join(', ')} (your association, not observed)`);
      declared++;
    }
  }
  for (const { room, item } of items) {
    if (item.status === 'TO_EXAMINE' && !item.observations) continue;
    const f = family(item.familyId);
    L.push(`- ${personal(item.label)}${f ? ` (${f.name})` : ''} · ${room.label ? personal(room.label) : room.kind}${item.where ? ` · ${personal(item.where)}` : ''}: ${STATUS_LABEL[item.status]}`);
    if (item.observations) L.push(`  - seen: ${personal(item.observations)}`);
    if (item.checksDone.length) L.push(`  - checks done: ${m.scrub(item.checksDone.join('; '))}`);
    if (item.photos.length) L.push(`  - ${item.photos.length} photo(s) kept in the browser (not in this file)`);
    declared++;
  }
  if (!declared) L.push('- Nothing declared.');
  L.push('');

  L.push('## TO VERIFY', '');
  const todo = todoItems.length + todoDevices.length;
  for (const { room, item } of todoItems) {
    const why = priorityWhy(room, item);
    L.push(`- ${personal(item.label)} · ${room.label ? personal(room.label) : room.kind}: ${STATUS_LABEL[item.status]}${item.nextCheck ? ` · next: ${personal(item.nextCheck)}` : ''}${why.length ? ` · organisation priority: ${why.join(', ')}` : ''}`);
  }
  for (const { d, c } of todoDevices) {
    L.push(`- ${m.alias('host', d.ip)} (${STATE_LABEL[c.state]}): identify it (ask the owner, find it physically); a visual inspection decides, not the scan.`);
  }
  if (!input.network.ran) L.push('- The network was not scanned.');
  if (!input.ble.ran) L.push('- Bluetooth was not scanned.');
  if (!todo && input.network.ran && input.ble.ran) L.push('- Nothing left in the list. The limits below still apply.');
  L.push('');

  L.push('## LIMITS', '');
  for (const l of LIMITS) L.push(`- ${l}`);
  L.push('', `RESULT: ${conclusion}`, '');
  L.push(`Statuses used: ${ITEM_STATUSES.map((s) => STATUS_LABEL[s]).join(' · ')}`);
  L.push('Hardware Dog · local, no cloud: this file was made on this device and sent nowhere.');

  return { conclusion, clues, text: L.join('\n') };
}
