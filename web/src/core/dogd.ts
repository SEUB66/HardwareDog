/**
 * HARDWARE DOG / DOGD TRANSPORT
 *
 * dogd is the local daemon (dogd/). It owns the device link; this
 * transport receives the device bytes through it, unchanged, and feeds
 * them to the same line decoder as Web Serial. After open(), nothing in
 * the System can tell it apart from any other transport.
 *
 * Local only: dogd listens on this machine (127.0.0.1). No account, no
 * cloud. docs/LAWS.md.
 */

import type { HostCommand } from './protocol';
import { encodeCommand, PROTOCOL_VERSION } from './protocol';
import type { Origin } from './session';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';

/** The only place dogd is: this machine. */
export const DOGD_URL = 'http://127.0.0.1:4782';

export interface DogdLink {
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
    throw new Error(`no dogd at ${new URL(url).host} (start it with: dogd)`);
  }
  if (!res.ok) throw new Error(`dogd: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const dogdLink = (base = DOGD_URL): Promise<DogdLink> => getJson<DogdLink>(`${base}/v1/link`);

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

  private constructor(readonly base: string) {}

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
    const link = await dogdLink(this.base);
    if (link.state !== 'ONLINE') throw new Error(`dogd has no device online (${link.reason ?? link.state})`);
    if (link.origin !== this.origin) throw new Error(`dogd source changed to ${link.origin} since the session started`);

    const socket = new WebSocket(`${this.base.replace(/^http/, 'ws')}/v1/hdp`);
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
