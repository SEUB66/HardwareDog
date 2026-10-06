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

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error(`no dogd at ${new URL(url).host}. Start it on this computer: dogd serve --source host (its network), or --source serial:PORT (a probe). docs/DOGD.md`);
  }
  if (!res.ok) throw new Error(`dogd: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const dogdLink = (base = DOGD_URL): Promise<DogdLink> => getJson<DogdLink>(`${base}/v1/link`);

/** Every link dogd holds, D1 first. A dogd older than packs has one: /v1/link. */
export async function dogdLinks(base = DOGD_URL): Promise<DogdLink[]> {
  try {
    return (await getJson<{ links: DogdLink[] }>(`${base}/v1/links`)).links;
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

    const path = this.dog === undefined ? '/v1/hdp' : `/v1/hdp/${this.dog}`;
    const socket = new WebSocket(`${this.base.replace(/^http/, 'ws')}${path}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    const decoder = new TextDecoder();
    const lines = createLineDecoder(sink);

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onclose = (e) => reject(new Error(e.reason || `dogd closed the HDP socket (${e.code})`));
      socket.onerror = () => reject(new Error('dogd HDP socket failed'));
    });
    socket.onmessage = (e) => {
      lines.push(typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true }));
    };
    socket.onclose = (e) => {
      this.socket = null;
      if (!this.closing) sink.lost(e.reason || `dogd closed the HDP socket (${e.code})`);
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
}

/** The USB devices of dogd's computer. supported false: not read on that system. */
export async function dogdUsb(base = DOGD_URL): Promise<{ supported: boolean; devices: HostUsbDevice[] }> {
  const res = await fetch(`${base}/v1/usb`);
  if (!res.ok) throw new Error(`dogd usb: ${res.status}`);
  return (await res.json()) as { supported: boolean; devices: HostUsbDevice[] };
}
