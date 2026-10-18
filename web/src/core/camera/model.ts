/**
 * HARDWARE DOG / CAMERA SNIFFER / NETWORK MODEL
 *
 * What the devices of the local network said about themselves, one row per
 * address, every claim kept with the observation it came from. Nothing is
 * merged across addresses, nothing is merged with Bluetooth on its own (a
 * person may link them, and that link is shown as theirs).
 *
 * The classification is explainable and never a percentage: a state, and
 * the reasons for it, each pointing at its evidence. A manufacturer, a
 * name or an open port alone never moves a device toward "camera": they
 * are listed as hints. Only a person's documented verification confirms.
 */

import type { DogdLanObservation } from '../dogd';

export type Origin = 'PHYSICAL' | 'SIMULATED';

/** One observation, as received: the source of every claim on a device. */
export interface Evidence {
  /** `${scan}:${seq}`: unique per source of observations. */
  id: string;
  kind: DogdLanObservation['kind'];
  method: string;
  at: number;
  summary: string;
  service: string | null;
  port: number | null;
  name: string | null;
  fields: Record<string, string>;
  raw: string | null;
  /** The lab event that recorded it, when a lab session was running (#seq). */
  labSeq?: number;
}

export interface NetDevice {
  /** iface|ip */
  key: string;
  ip: string;
  iface: string;
  mac: string | null;
  /** The registered owner of the MAC prefix (an origin, not an identity), and the file it came from. */
  vendor: { name: string; source: string | null } | null;
  /** A locally administered MAC (often random): no manufacturer applies. */
  macLocal: boolean;
  firstSeen: number;
  lastSeen: number;
  methods: string[];
  evidence: Evidence[];
  origin: Origin;
  /** Repeated or minor answers not kept once the evidence list was full. */
  dropped?: number;
}

/** What a person said about a device. Never changes the observations. */
export interface DeviceNote {
  known: boolean;
  label: string;
  /** A documented verification (what was seen, where, how): the only way to CONFIRMED. */
  confirmation: string;
  /** Bluetooth devices this person linked to it, by key. Manual, and shown as such. */
  ble: string[];
}

export const emptyNote = (): DeviceNote => ({ known: false, label: '', confirmation: '', ble: [] });

export const NET_STATES = ['DISCOVERED', 'MEDIA_SERVICE', 'VIDEO_COMPATIBLE', 'MODEL_IDENTIFIED', 'CONFIRMED', 'UNDETERMINED'] as const;
export type NetState = (typeof NET_STATES)[number];

export const STATE_LABEL: Record<NetState, string> = {
  DISCOVERED: 'Device discovered',
  MEDIA_SERVICE: 'Media service observed',
  VIDEO_COMPATIBLE: 'Clues compatible with video equipment',
  // what the device says about itself: not a confirmed (nor a hidden) camera
  MODEL_IDENTIFIED: 'Model reported by the device',
  CONFIRMED: 'Camera confirmed by a documented verification',
  UNDETERMINED: 'Undetermined',
};

export interface Reason {
  text: string;
  /** The evidence it rests on (an Evidence id), or null for a person's own statement. */
  evidence: string | null;
  /** STATE: why the state is what it is. HINT: worth knowing, decides nothing. USER: a person said it. */
  role: 'STATE' | 'HINT' | 'USER';
}

export interface Classification {
  state: NetState;
  reasons: Reason[];
  /** Manufacturer and model as the device itself reported them, when it did. */
  model: string | null;
}

const MAX_EVIDENCE = 60;

/** Answers the classification reads to set a state (not only a hint). */
const decisive = (e: Evidence) => e.kind === 'wsd' || e.kind === 'upnp' || (e.kind === 'service' && !!e.fields['rtsp_status']) || (e.kind === 'mdns' && !!e.service && e.service !== '_services._dns-sd._udp.local');

function summary(o: DogdLanObservation): string {
  const f = o.fields;
  switch (o.kind) {
    case 'neighbor':
      return `in the neighbor table${o.mac ? ` as ${o.mac}` : ''}`;
    case 'mdns':
      return o.service === '_services._dns-sd._udp.local' ? `announces mDNS service types: ${f['types'] ?? ''}` : `announces ${o.service ?? 'a service'}${o.name ? ` "${o.name}"` : ''}${o.port ? ` on port ${o.port}` : ''}`;
    case 'ssdp':
      return `answers SSDP${o.service ? ` (${o.service})` : ''}${f['server'] ? `, server "${f['server']}"` : ''}`;
    case 'upnp':
      return f['note'] ? `UPnP description: ${f['note']}` : `UPnP description: ${o.service ?? '?'}${o.name ? ` "${o.name}"` : ''}${f['manufacturer'] ? `, ${f['manufacturer']}` : ''}${f['model_name'] ? ` ${f['model_name']}` : ''}`;
    case 'wsd':
      return `answers ONVIF WS-Discovery as ${o.service ?? '?'}${o.name ? ` "${o.name}"` : ''}${f['hardware'] ? `, hardware "${f['hardware']}"` : ''}`;
    case 'service':
      return f['rtsp_status'] ? `RTSP answers OPTIONS on port ${o.port}: ${f['rtsp_status']}${f['server'] ? `, server "${f['server']}"` : ''}` : `accepts TCP connections on port ${o.port} (${o.service})`;
    case 'note':
      return f['note'] ?? 'note';
  }
}

/**
 * The devices of a scan, built from observations in order. A repeat of the
 * same claim refreshes the time; it never adds a row or a duplicate claim.
 */
export class NetModel {
  readonly devices = new Map<string, NetDevice>();
  /** Notes about the scan itself (a step that could not run, a limit reached). */
  readonly notes: Evidence[] = [];
  private seen = new Set<string>();

  clear(): void {
    this.devices.clear();
    this.notes.length = 0;
    this.seen.clear();
  }

  /** Add one observation; returns the device it changed, or null (a note, a duplicate). */
  add(o: DogdLanObservation, origin: Origin, labSeq?: number, run = 0): NetDevice | null {
    const id = `${run}:${o.scan}:${o.seq}`;
    if (this.seen.has(id)) return null;
    this.seen.add(id);
    const ev: Evidence = { id, kind: o.kind, method: o.method, at: o.wall_ms, summary: summary(o), service: o.service, port: o.port, name: o.name, fields: { ...o.fields }, raw: o.raw };
    if (labSeq !== undefined) ev.labSeq = labSeq;
    if (o.kind === 'note' || !o.ip) {
      if (this.notes.length < 200) this.notes.push(ev);
      return null;
    }
    const key = `${o.iface}|${o.ip}`;
    let d = this.devices.get(key);
    if (!d) {
      d = { key, ip: o.ip, iface: o.iface, mac: null, vendor: null, macLocal: false, firstSeen: o.wall_ms, lastSeen: o.wall_ms, methods: [], evidence: [], origin };
      this.devices.set(key, d);
    }
    d.lastSeen = Math.max(d.lastSeen, o.wall_ms);
    if (o.mac && !d.mac) {
      d.mac = o.mac;
      d.macLocal = /^.[26ae]/i.test(o.mac);
    }
    if (o.vendor && !d.vendor) d.vendor = { name: o.vendor, source: o.vendor_source };
    if (!d.methods.includes(o.method)) d.methods.push(o.method);
    const same = d.evidence.find((e) => e.kind === ev.kind && e.summary === ev.summary);
    if (same) {
      same.at = Math.max(same.at, ev.at);
      return d;
    }
    // Past the limit, only answers that can change the state are still kept; the rest is counted.
    if (d.evidence.length < MAX_EVIDENCE || (decisive(ev) && d.evidence.length < MAX_EVIDENCE * 2)) d.evidence.push(ev);
    else d.dropped = (d.dropped ?? 0) + 1;
    return d;
  }
}

const has = (s: string | null | undefined, ...words: string[]) => !!s && words.some((w) => s.toLowerCase().includes(w));

/** The names a device announced, each with how. */
export function namesOf(d: NetDevice): { value: string; via: string }[] {
  const out: { value: string; via: string }[] = [];
  for (const e of d.evidence) if (e.name && !out.some((n) => n.value === e.name)) out.push({ value: e.name, via: e.kind });
  return out;
}

/**
 * The state of a device and why. Order of strength:
 * DISCOVERED < MEDIA_SERVICE < VIDEO_COMPATIBLE < MODEL_IDENTIFIED < CONFIRMED.
 * UNDETERMINED: it showed itself only through answers that could not be read.
 */
export function classify(d: NetDevice, note: DeviceNote = emptyNote()): Classification {
  const reasons: Reason[] = [];
  let media = false;
  let video = false;
  let model: string | null = null;

  for (const e of d.evidence) {
    const f = e.fields;
    if (e.kind === 'wsd' && has(e.service, 'networkvideotransmitter')) {
      video = true;
      reasons.push({ text: 'Answers ONVIF discovery as NetworkVideoTransmitter: the type ONVIF video devices announce. A recorder (NVR) or a video encoder announces it too.', evidence: e.id, role: 'STATE' });
      if (f['hardware']) model = `${f['hardware']} (ONVIF hardware scope, as the device reports it)`;
    } else if (e.kind === 'wsd') {
      media = true;
      reasons.push({ text: `Answers ONVIF discovery (${e.service ?? 'type not given'}): an ONVIF device, not necessarily a camera.`, evidence: e.id, role: 'STATE' });
    }
    if (e.kind === 'upnp' && has(e.service, 'camera', 'digitalsecuritycamera')) {
      video = true;
      reasons.push({ text: `Its UPnP description declares the device type ${e.service}.`, evidence: e.id, role: 'STATE' });
    } else if (e.kind === 'upnp' && has(e.service, 'mediaserver', 'mediarenderer')) {
      media = true;
      reasons.push({ text: `Its UPnP description declares ${e.service}: shares or plays media (TVs, speakers, NAS do).`, evidence: e.id, role: 'STATE' });
    }
    if (e.kind === 'upnp' && (f['manufacturer'] || f['model_name'])) {
      const m = [f['manufacturer'], f['model_name'], f['model_number']].filter(Boolean).join(' ');
      if (m && !model) model = `${m} (UPnP description, as the device reports it)`;
    }
    if (e.kind === 'service' && f['rtsp_status']) {
      media = true;
      reasons.push({ text: `Serves RTSP on port ${e.port} (it answered OPTIONS). RTSP streams media: cameras use it, so do media servers, NAS and set-top boxes.`, evidence: e.id, role: 'STATE' });
    } else if (e.kind === 'service' && (e.port === 554 || e.port === 8554)) {
      reasons.push({ text: `Accepts connections on port ${e.port}, the RTSP port, but did not answer as RTSP: a port is not a service.`, evidence: e.id, role: 'HINT' });
    } else if (e.kind === 'service') {
      reasons.push({ text: `Has a web interface on port ${e.port} (TCP connection accepted). Most network devices do.`, evidence: e.id, role: 'HINT' });
    }
    if (e.kind === 'mdns' && has(e.service, '_rtsp._tcp')) {
      media = true;
      reasons.push({ text: 'Announces an RTSP service over mDNS (_rtsp._tcp): a media stream is offered; what it shows is not known.', evidence: e.id, role: 'STATE' });
    } else if (e.kind === 'mdns' && has(e.service, '_googlecast', '_airplay', '_raop', '_spotify')) {
      media = true;
      reasons.push({ text: `Announces ${e.service}: a casting or audio receiver (TV, speaker).`, evidence: e.id, role: 'STATE' });
    }
    if (e.kind === 'ssdp' && has(f['server'], 'camera', 'ipcam', 'webcam')) {
      reasons.push({ text: `Its SSDP server string mentions a camera ("${f['server']}"): the device's own words, a clue to check, not an identification.`, evidence: e.id, role: 'HINT' });
    }
  }
  for (const n of namesOf(d)) {
    if (has(n.value, 'cam', 'ipc', 'nvr', 'dvr', 'video')) reasons.push({ text: `Announces the name "${n.value}" (${n.via}). A name is chosen by whoever set the device up: it identifies nothing.`, evidence: d.evidence.find((e) => e.name === n.value)?.id ?? null, role: 'HINT' });
  }
  if (d.vendor) reasons.push({ text: `MAC prefix registered to ${d.vendor.name}: the origin of its network chip, not what the device is.`, evidence: d.evidence.find((e) => e.kind === 'neighbor')?.id ?? null, role: 'HINT' });
  const macs = [...new Set(d.evidence.filter((e) => e.kind === 'neighbor').map((e) => e.summary.match(/as (\S+)$/)?.[1]).filter(Boolean))];
  if (macs.length > 1) reasons.push({ text: `Several MACs were seen at this address (${macs.join(', ')}): two devices one after the other (addresses are reassigned), or a phone changing its random MAC. The rows are one address, not one device.`, evidence: d.evidence.find((e) => e.kind === 'neighbor')?.id ?? null, role: 'HINT' });
  if (d.macLocal) reasons.push({ text: 'Its MAC is locally administered (often random, as phones do on Wi-Fi): no manufacturer can be read from it.', evidence: d.evidence.find((e) => e.kind === 'neighbor')?.id ?? null, role: 'HINT' });

  const readable = d.evidence.some((e) => !(e.kind === 'upnp' && e.fields['note']));
  let state: NetState = !readable ? 'UNDETERMINED' : video ? (model ? 'MODEL_IDENTIFIED' : 'VIDEO_COMPATIBLE') : media ? 'MEDIA_SERVICE' : 'DISCOVERED';
  if (!readable) reasons.push({ text: 'It showed itself only through answers that could not be read: nothing can be said yet.', evidence: d.evidence[0]?.id ?? null, role: 'STATE' });
  if (state === 'DISCOVERED' && readable) reasons.unshift({ text: 'Seen on the network; nothing it announced points to media or video. That excludes nothing: many devices announce nothing.', evidence: d.evidence[0]?.id ?? null, role: 'STATE' });

  if (note.confirmation.trim()) {
    state = 'CONFIRMED';
    reasons.push({ text: `Confirmed by your documented verification: ${note.confirmation.trim()}`, evidence: null, role: 'USER' });
  }
  if (note.known) reasons.push({ text: `You marked it as known${note.label ? `: ${note.label}` : ''}. The observations are unchanged.`, evidence: null, role: 'USER' });
  if (note.ble.length) reasons.push({ text: `You linked it to ${note.ble.length} Bluetooth device(s). This association is yours, not observed.`, evidence: null, role: 'USER' });
  return { state, reasons, model };
}

/**
 * What a state does NOT establish, said next to it everywhere (device detail,
 * report): a model on the network is not a confirmed hidden camera.
 */
export const NOT_ESTABLISHED: Record<NetState, string> = {
  DISCOVERED: 'What this device is. Nothing it announced points to video; that excludes nothing.',
  MEDIA_SERVICE: 'What the media service carries, or that the device is a camera.',
  VIDEO_COMPATIBLE: 'That it is a camera hidden here, where it is, or what it films: a recorder or a declared camera answers the same way. A visual check decides.',
  MODEL_IDENTIFIED: 'That it is a camera hidden here, where it is, or what it films: the model is what the device says about itself, and a declared camera, a recorder or a doorbell report one too. A visual check decides.',
  CONFIRMED: 'Anything by the scan itself: the confirmation is your documented verification, kept apart from the observations.',
  UNDETERMINED: 'Anything yet: its answers could not be read.',
};

/** The devices that deserve a look first: video clues, then media, then the rest. Never a probability. */
export const STATE_ORDER: Record<NetState, number> = { CONFIRMED: 0, MODEL_IDENTIFIED: 1, VIDEO_COMPATIBLE: 2, MEDIA_SERVICE: 3, UNDETERMINED: 4, DISCOVERED: 5 };
