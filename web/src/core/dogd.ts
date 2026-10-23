/**
 * HARDWARE DOG / DOGD TRANSPORT
 *
 * dogd is the local daemon (dogd/). It owns the device link; this
 * transport receives the device bytes through it, unchanged, and feeds
 * them to the same line decoder as Web Serial. After open(), nothing in
 * the System can tell it apart from any other transport.
 *
 * Several sources (dogd serve --source A --source B) are several links,
 * D1, D2...: each is opened as its own DogdTransport, and together they
 * are a pack (docs/PACK.md). dogd never merges them: the one timeline and
 * the one clock are the engine's.
 *
 * Local only: dogd listens on this machine (127.0.0.1). No account, no
 * cloud. docs/LAWS.md.
 */

import type { HostCommand } from './protocol';
import { encodeCommand, PROTOCOL_VERSION } from './protocol';
import type { Origin } from './session';
import type { Transport, TransportSink } from './transport';
import { PackTransport, createLineDecoder } from './transport';

/** The only place dogd is: this machine. */
export const DOGD_URL = 'http://127.0.0.1:4782';

/** The device id of dogd --source host: this computer, for the network. */
export const HOST_DEVICE = 'HOST';

export interface DogdLink {
  /** Its place among dogd's links: D1, D2... (older dogd: absent, one link). */
  dog?: string;
  state: 'NONE' | 'CONNECTING' | 'ONLINE' | 'LOST';
  source: string;
  origin: Origin;
  label: string;
  device: { device: string; rev: string; fw: string; proto: number } | null;
  epoch: number;
  reason: string | null;
}

/** dogd answers on this machine in milliseconds: past this, it is hung, and that is said. */
const DOGD_ANSWER_MS = 4000;

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(DOGD_ANSWER_MS) });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new Error(`dogd at ${new URL(url).host} did not answer within ${DOGD_ANSWER_MS / 1000} s: it is starting, or hung. Restart it: docs/DOGD.md`);
    throw new Error(`no dogd at ${new URL(url).host}. Start it on this computer: dogd serve --source host (its network), or --source serial:PORT (a probe). docs/DOGD.md`);
  }
  if (!res.ok) throw new Error(`dogd: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const LINK_STATES = ['NONE', 'CONNECTING', 'ONLINE', 'LOST'] as const;

/**
 * A link as dogd describes it, checked: what goes into a recording's
 * header must be what the reader accepts later (origin PHYSICAL or
 * SIMULATED, a Dog id D1..D99, a label of 256 characters at most). A dogd
 * of another version, or another service on its port, is refused here.
 */
export function checkLink(v: unknown): DogdLink {
  const bad = (why: string) => new Error(`dogd answered something that is not a link (${why}): another version, or another program on port 4782?`);
  if (typeof v !== 'object' || v === null) throw bad('not an object');
  const l = v as Record<string, unknown>;
  if (!LINK_STATES.includes(l['state'] as (typeof LINK_STATES)[number])) throw bad('state');
  if (l['origin'] !== 'PHYSICAL' && l['origin'] !== 'SIMULATED') throw bad(`origin ${String(l['origin'])}`);
  if (l['dog'] !== undefined && (typeof l['dog'] !== 'string' || !/^D[1-9][0-9]?$/.test(l['dog']))) throw bad('dog');
  if (typeof l['source'] !== 'string' || typeof l['label'] !== 'string') throw bad('source / label');
  return { ...(l as unknown as DogdLink), label: (l['label'] as string).slice(0, 256), source: (l['source'] as string).slice(0, 256) };
}

export const dogdLink = async (base = DOGD_URL): Promise<DogdLink> => checkLink(await getJson<unknown>(`${base}/v1/link`));

/** Is dogd running on this computer? Its version when it answers (nothing is started by asking). */
export const dogdHealth = (base = DOGD_URL): Promise<{ dogd: string; hdp: number; status: string }> => getJson(`${base}/v1/health`);

/** Every link dogd holds, D1 first. A dogd older than packs has one: /v1/link. */
export async function dogdLinks(base = DOGD_URL): Promise<DogdLink[]> {
  try {
    const links = (await getJson<{ links?: unknown }>(`${base}/v1/links`)).links;
    if (!Array.isArray(links)) throw new Error('dogd answered something that is not its links: another version, or another program on port 4782?');
    return links.map(checkLink);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('dogd: 404')) return [{ ...(await dogdLink(base)), dog: 'D1' }];
    throw e;
  }
}

const notOnline = (l: DogdLink) => `dogd ${l.dog ?? 'D1'} ${l.source} is not online (${l.reason ?? l.state})`;

/**
 * Whatever dogd holds, as one transport: one link is one device; two or
 * more are a pack, every Dog on its own stream. A pack starts with every
 * Dog online: one missing at the start would be a hole nobody sees.
 */
export async function connectDogd(base = DOGD_URL): Promise<Transport> {
  const links = (await dogdLinks(base)).filter((l) => l.state !== 'NONE');
  if (links.length === 0) throw new Error('dogd has no device online (no source: dogd serve --source ...)');
  const offline = links.find((l) => l.state !== 'ONLINE');
  if (offline) throw new Error(notOnline(offline));
  if (links.length === 1) return DogdTransport.prepare(base);
  return new PackTransport(links.map((l) => ({ dog: l.dog!, link: DogdTransport.of(base, l) })));
}

/** Whether a session's evidence came through dogd (its store then keeps the file). */
export const viaDogd = (t: Transport | null): boolean =>
  t instanceof DogdTransport || (t instanceof PackTransport && t.links.every((l) => l.kind === 'DOGD'));

/**
 * Why the HDP socket closed, in words that name who dropped: dogd gives a
 * reason when it closes on purpose (the device behind it was lost, the
 * client was too slow); with none and code 1006, dogd itself went away.
 */
export function dogdClosed(code: number, reason: string): string {
  if (reason) return reason;
  if (code === 1006) return 'dogd stopped answering: it quit or was stopped, or the connection to it dropped';
  return `dogd closed the HDP socket (${code})`;
}

/** Hand a finished .hdlog to dogd's local store. The file is the evidence; dogd indexes it. */
export async function dogdStore(recording: string, hdlog: string, base = DOGD_URL): Promise<void> {
  const res = await fetch(`${base}/v1/sessions/${recording}/hdlog`, {
    method: 'PUT',
    headers: { 'content-type': 'application/x-ndjson' },
    body: hdlog,
  });
  if (!res.ok) throw new Error(`dogd store: ${res.status} ${await res.text()}`);
}

export class DogdTransport implements Transport {
  readonly kind = 'DOGD' as const;
  label = 'DOGD';
  /** Told by dogd: a serial port is PHYSICAL; a TCP source is what the operator declared. */
  origin: Origin = 'PHYSICAL';

  private socket: WebSocket | null = null;
  private closing = false;

  /** undefined: dogd's first link, on /v1/hdp, as before packs. */
  private constructor(
    readonly base: string,
    readonly dog?: string,
  ) {}

  /** One Dog of a pack: its own link, its own stream. */
  static of(base: string, link: DogdLink): DogdTransport {
    const t = new DogdTransport(base, link.dog);
    t.label = link.label;
    t.origin = link.origin;
    return t;
  }

  private async link(): Promise<DogdLink> {
    if (this.dog === undefined) return dogdLink(this.base);
    const link = (await dogdLinks(this.base)).find((l) => l.dog === this.dog);
    if (!link) throw new Error(`dogd has no link ${this.dog} any more`);
    return link;
  }

  /**
   * Ask dogd which device it holds before the session starts: the session
   * header records where its evidence comes from, before the first frame.
   */
  static async prepare(base = DOGD_URL): Promise<DogdTransport> {
    const t = new DogdTransport(base);
    const link = await dogdLink(base);
    if (link.state !== 'ONLINE') throw new Error(`dogd has no device online (${link.reason ?? link.state})`);
    t.label = link.label;
    t.origin = link.origin;
    return t;
  }

  async open(sink: TransportSink): Promise<void> {
    const link = await this.link();
    if (link.state !== 'ONLINE') throw new Error(this.dog === undefined ? `dogd has no device online (${link.reason ?? link.state})` : notOnline(link));
    if (link.origin !== this.origin) throw new Error(`dogd source changed to ${link.origin} since the session started`);

    const path = this.dog === undefined ? '/v1/hdp' : `/v1/hdp/${encodeURIComponent(this.dog)}`;
    const socket = new WebSocket(`${this.base.replace(/^http/, 'ws')}${path}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    const decoder = new TextDecoder();
    const lines = createLineDecoder(sink);

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onclose = (e) => reject(new Error(dogdClosed(e.code, e.reason)));
      socket.onerror = () => reject(new Error('dogd HDP socket failed'));
    });
    socket.onmessage = (e) => {
      lines.push(typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true }));
    };
    socket.onclose = (e) => {
      this.socket = null;
      if (!this.closing) sink.lost(dogdClosed(e.code, e.reason));
    };
    socket.onerror = null;
    this.send({ cmd: 'hello', proto: PROTOCOL_VERSION });
  }

  send(cmd: HostCommand): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeCommand(cmd));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.socket?.close(1000, 'session closed');
    this.socket = null;
  }
}


/** A USB device plugged into the computer dogd runs on (GET /v1/usb). */
export interface HostUsbDevice {
  port: string;
  vid: number;
  pid: number;
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
  speed: string | null;
  cls: string;
  power: string | null;
  max_ma: number | null;
  /** Every interface of its configuration by class (VIDEO, MSC, CDC...). Absent from an older dogd. */
  interfaces?: string[];
}

/** The USB devices of dogd's computer. supported false: not read on that system. */
export async function dogdUsb(base = DOGD_URL): Promise<{ supported: boolean; devices: HostUsbDevice[] }> {
  const res = await fetch(`${base}/v1/usb`);
  if (!res.ok) throw new Error(`dogd usb: ${res.status}`);
  return (await res.json()) as { supported: boolean; devices: HostUsbDevice[] };
}

// ------------------------------------------------------------------ BLE

/** dogd's Bluetooth scanner (Linux, BlueZ). supported false: not on this system. */
export interface DogdBleStatus {
  supported: boolean;
  state: 'unsupported' | 'no_adapter' | 'permission' | 'ready' | 'scanning' | 'error';
  adapter: string | null;
  detail: string;
}

/** One advertisement report, as BlueZ gave it to dogd. Times are dogd's (same computer). */
export interface DogdBleObservation {
  seq: number;
  mono_ms: number;
  wall_ms: number;
  adapter: string;
  address: string;
  address_type: 'public' | 'random' | null;
  name: string | null;
  alias: string | null;
  rssi: number | null;
  tx_power: number | null;
  uuids: string[];
  /** company id (decimal) -> hex bytes */
  manufacturer: Record<string, string>;
  /** service UUID -> hex bytes */
  service_data: Record<string, string>;
}

export const dogdBleStatus = (base = DOGD_URL): Promise<DogdBleStatus> => getJson<DogdBleStatus>(`${base}/v1/ble/status`);

/** Start or stop dogd's scan. Discovery on the adapter: nothing is sent to any device. */
export async function dogdBleScan(on: boolean, base = DOGD_URL): Promise<DogdBleStatus> {
  let res: Response;
  try {
    res = await fetch(`${base}/v1/ble/scan`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: on ? 'start' : 'stop' });
  } catch {
    throw new Error('no dogd on this computer: dogd serve (Linux, BlueZ). docs/DOGD.md');
  }
  if (!res.ok) throw new Error(`dogd ble: ${res.status} ${await res.text()}`);
  return (await res.json()) as DogdBleStatus;
}

/** Reports after `since`, oldest first; `lost`: reports dogd had to drop (its buffer was full). */
export const dogdBleObservations = (since: number, base = DOGD_URL): Promise<{ now_mono_ms: number; next: number; lost: number; observations: DogdBleObservation[] }> =>
  getJson(`${base}/v1/ble/observations?since=${since}`);

// ------------------------------------------------------------------ LAN (Camera Sniffer)

/** One IPv4 network of dogd's computer, and why a scan of it would be refused (null: allowed). */
export interface DogdLanIface {
  name: string;
  address: string;
  prefix: number;
  network: string;
  up: boolean;
  private: boolean;
  loopback: boolean;
  refused: string | null;
}

export interface DogdLanStatus {
  supported: boolean;
  state: 'unsupported' | 'idle' | 'scanning' | 'done' | 'cancelled' | 'error';
  detail: string;
  scan: number;
  iface: string | null;
  methods: string[];
  step: string | null;
  done: number;
  total: number | null;
  started_wall_ms: number | null;
  finished_wall_ms: number | null;
  oui_source: string | null;
}

/** What a device said about itself, as dogd received it. */
export interface DogdLanObservation {
  seq: number;
  scan: number;
  mono_ms: number;
  wall_ms: number;
  kind: 'neighbor' | 'mdns' | 'ssdp' | 'upnp' | 'wsd' | 'service' | 'note';
  method: string;
  iface: string;
  ip: string | null;
  mac: string | null;
  vendor: string | null;
  vendor_source: string | null;
  name: string | null;
  service: string | null;
  port: number | null;
  fields: Record<string, string>;
  raw: string | null;
}

export const dogdLanInterfaces = (base = DOGD_URL): Promise<{ supported: boolean; interfaces: DogdLanIface[]; detail?: string }> => getJson(`${base}/v1/lan/interfaces`);

export const dogdLanStatus = (base = DOGD_URL): Promise<DogdLanStatus> => getJson<DogdLanStatus>(`${base}/v1/lan/status`);

/** Start a scan of one interface with the chosen methods, or stop the running one. */
export async function dogdLanScan(req: { action: 'start'; iface: string; methods: string[] } | { action: 'stop' }, base = DOGD_URL): Promise<DogdLanStatus> {
  let res: Response;
  try {
    res = await fetch(`${base}/v1/lan/scan`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  } catch {
    throw new Error('no dogd on this computer: dogd serve (Linux). docs/DOGD.md');
  }
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as DogdLanStatus;
}

export const dogdLanObservations = (since: number, base = DOGD_URL): Promise<{ now_mono_ms: number; next: number; lost: number; observations: DogdLanObservation[] }> =>
  getJson(`${base}/v1/lan/observations?since=${since}`);
