/**
 * HARDWARE DOG / CAMERA SNIFFER / NETWORK DISCOVERY
 *
 * The browser cannot list a network: dogd does it, on this computer
 * (dogd/src/lan). This service picks the interface the person chose,
 * starts and stops dogd's scan, reads what devices said, and records it
 * on the lab timeline. Without dogd it says how to start it; the catalog
 * and the guided inspection keep working.
 *
 * A demo network (DEMO, SIMULATED everywhere) speaks the same records:
 * ordinary devices that expose media services, an NVR answering ONVIF, a
 * description that cannot be read. It is never a test on a real camera.
 */

import {
  dogdLanInterfaces,
  dogdLanObservations,
  dogdLanScan,
  dogdLanStatus,
  type DogdLanIface,
  type DogdLanObservation,
  type DogdLanStatus,
} from '../dogd';
import { errorInfo, newOp, type LabBus } from '../lab/events';
import { classify, NetModel, type DeviceNote, type Origin } from './model';

export const LAN_METHODS = ['neighbors', 'mdns', 'ssdp', 'wsd', 'services'] as const;
export type LanMethod = (typeof LAN_METHODS)[number];

export const METHOD_LABEL: Record<LanMethod, string> = {
  neighbors: 'Neighbor table (nothing sent)',
  mdns: 'mDNS / DNS-SD',
  ssdp: 'SSDP / UPnP',
  wsd: 'ONVIF WS-Discovery',
  services: 'Service check on seen hosts (web ports, RTSP OPTIONS)',
};

/** What dogd offers; the demo implements the same, so the service cannot tell them apart. */
export interface LanApi {
  interfaces(): Promise<{ supported: boolean; interfaces: DogdLanIface[]; detail?: string }>;
  status(): Promise<DogdLanStatus>;
  scan(req: { action: 'start'; iface: string; methods: string[] } | { action: 'stop' }): Promise<DogdLanStatus>;
  observations(since: number): Promise<{ next: number; lost: number; observations: DogdLanObservation[] }>;
}

export const dogdLanApi: LanApi = {
  interfaces: () => dogdLanInterfaces(),
  status: () => dogdLanStatus(),
  scan: (r) => dogdLanScan(r),
  observations: (s) => dogdLanObservations(s),
};

export type NetState = 'IDLE' | 'SCANNING' | 'DONE' | 'CANCELLED' | 'ERROR';

export const DOGD_HOWTO = 'Network discovery runs in dogd, the local engine, on this computer (Linux for now): start it with `dogd serve`, then reload the interfaces. docs/DOGD.md. The catalog and the guided inspection work without it.';

const POLL_MS = 700;
/** Polls that fail in a row before the link to dogd is called lost. */
const POLL_FAILS = 4;

export class CameraNet {
  readonly model = new NetModel();
  state: NetState = 'IDLE';
  source: 'DOGD' | 'DEMO' = 'DOGD';
  interfaces: DogdLanIface[] = [];
  /** null: never asked; false: dogd answered it does not scan here; true: available. */
  available: boolean | null = null;
  detail = '';
  error: { code: string; message: string } | null = null;
  status: DogdLanStatus | null = null;
  iface: string | null = null;
  methods: LanMethod[] = [...LAN_METHODS];
  notes = new Map<string, DeviceNote>();
  lost = 0;
  private api: LanApi = dogdLanApi;
  private since = 0;
  private op: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fails = 0;
  private listeners = new Set<() => void>();
  private rev = 0;

  constructor(
    private readonly bus: LabBus,
    private readonly demoApi: () => LanApi,
  ) {}

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get revision(): number {
    return this.rev;
  }
  private changed(): void {
    this.rev++;
    for (const l of [...this.listeners]) l();
  }

  get origin(): Origin {
    return this.source === 'DEMO' ? 'SIMULATED' : 'PHYSICAL';
  }
  get scanning(): boolean {
    return this.state === 'SCANNING';
  }

  /** Ask the engine which networks this computer is on (demo: the simulated one). */
  async refresh(source: 'DOGD' | 'DEMO' = this.source): Promise<void> {
    if (this.scanning) return;
    this.source = source;
    this.api = source === 'DEMO' ? this.demoApi() : dogdLanApi;
    try {
      const r = await this.api.interfaces();
      this.available = r.supported;
      this.interfaces = r.interfaces;
      this.detail = r.supported ? '' : (r.detail ?? 'dogd does not discover networks on this system');
      this.error = null;
      const usable = this.interfaces.filter((i) => !i.refused);
      if (!this.iface || !usable.some((i) => i.name === this.iface)) this.iface = usable[0]?.name ?? null;
    } catch (e) {
      this.available = null;
      this.interfaces = [];
      this.iface = null;
      this.error = { code: 'DOGD_ABSENT', message: errorInfo(e).message };
    }
    this.changed();
  }

  /** Start a scan of the chosen interface. One at a time. */
  async start(): Promise<void> {
    if (this.scanning) return;
    const iface = this.interfaces.find((i) => i.name === this.iface);
    if (!iface || iface.refused) {
      this.error = { code: 'NO_IFACE', message: iface?.refused ?? 'Choose a network first.' };
      this.changed();
      return;
    }
    if (!this.methods.length) {
      this.error = { code: 'NO_METHOD', message: 'Choose at least one method.' };
      this.changed();
      return;
    }
    this.error = null;
    this.op = newOp('camera.net');
    this.bus.emit({ source: 'CAMERA', tool: 'camera.net', type: 'op.start', op: this.op, severity: 'INFO', message: `network discovery on ${iface.name} ${iface.network}`, origin: this.origin, params: { kind: 'search', iface: iface.name, network: iface.network, methods: this.methods.join(' '), say: 'cam.searching' } });
    try {
      // a new reader starts after what is already there
      this.since = (await this.api.observations(Number.MAX_SAFE_INTEGER)).next;
      this.status = await this.api.scan({ action: 'start', iface: iface.name, methods: [...this.methods] });
    } catch (e) {
      const { message } = errorInfo(e);
      this.fail('SCAN_REFUSED', message);
      return;
    }
    this.state = 'SCANNING';
    this.fails = 0;
    this.changed();
    this.poll();
  }

  /** Stop now: what was observed stays. */
  async stop(): Promise<void> {
    if (!this.scanning) return;
    this.clearTimer();
    try {
      this.status = await this.api.scan({ action: 'stop' });
    } catch {
      // the engine is gone: the scan is over anyway
    }
    await this.drain();
    this.state = 'CANCELLED';
    this.end('WARN', 'network discovery stopped: what was observed is kept', 'CANCELLED');
  }

  /** The network to scan (an allowed one only). */
  choose(iface: string): void {
    if (this.scanning || !this.interfaces.some((i) => i.name === iface && !i.refused)) return;
    this.iface = iface;
    this.changed();
  }

  /** The methods to use, kept in their running order. */
  setMethods(methods: LanMethod[]): void {
    if (this.scanning) return;
    this.methods = LAN_METHODS.filter((m) => methods.includes(m));
    this.changed();
  }

  note(key: string): DeviceNote {
    return this.notes.get(key) ?? { known: false, label: '', confirmation: '', ble: [] };
  }

  /** What a person says about a device: kept apart from the observations, and on the timeline. */
  setNote(key: string, patch: Partial<DeviceNote>): void {
    const n = { ...this.note(key), ...patch };
    this.notes.set(key, n);
    const d = this.model.devices.get(key);
    this.bus.emit({ source: 'USER', tool: 'camera.net', type: 'note', severity: 'INFO', message: `${d?.ip ?? key}: ${n.known ? `known (${n.label || 'no label'})` : 'not marked known'}${n.confirmation ? ` · confirmed: ${n.confirmation}` : ''}${n.ble.length ? ` · linked to ${n.ble.length} BLE device(s) by hand` : ''}`, origin: this.origin, device: d?.ip ?? key, params: { declared: true } });
    this.changed();
  }

  clear(): void {
    if (this.scanning) return;
    this.model.clear();
    this.status = null;
    this.state = 'IDLE';
    this.changed();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private poll(): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.tick(), POLL_MS);
  }

  private async tick(): Promise<void> {
    if (!this.scanning) return;
    try {
      await this.drain();
      const s = await this.api.status();
      this.status = s;
      this.fails = 0;
      if (this.op && s.total) this.bus.emit({ source: 'CAMERA', tool: 'camera.net', type: 'op.progress', op: this.op, severity: 'INFO', message: `${s.step ?? ''}`, origin: this.origin, progress: { done: s.done, total: s.total, unit: 'checks' } });
      if (s.state === 'scanning') {
        this.changed();
        this.poll();
        return;
      }
      await this.drain();
      if (s.state === 'done') {
        this.state = 'DONE';
        const video = [...this.model.devices.values()].some((d) => ['VIDEO_COMPATIBLE', 'MODEL_IDENTIFIED'].includes(classify(d, this.note(d.key)).state));
        this.end('PASS', s.detail, undefined, video ? 'cam.video' : 'cam.netdone');
        const unknown = [...this.model.devices.values()].filter((d) => !this.note(d.key).known && ['DISCOVERED', 'MEDIA_SERVICE', 'UNDETERMINED'].includes(classify(d, this.note(d.key)).state)).length;
        if (unknown) this.bus.emit({ source: 'CAMERA', tool: 'camera.net', type: 'info', severity: 'INFO', message: `${unknown} device(s) not identified yet`, origin: this.origin, params: { say: 'cam.unidentified', count: unknown } });
      } else if (s.state === 'cancelled') {
        this.state = 'CANCELLED';
        this.end('WARN', s.detail, 'CANCELLED');
      } else {
        this.fail('SCAN_ERROR', s.detail);
      }
    } catch (e) {
      // dogd may be busy for a moment; a few misses in a row is a lost link
      if (++this.fails >= POLL_FAILS) {
        this.fail('DOGD_LOST', `lost contact with dogd: ${errorInfo(e).message}. What was observed is kept.`);
        return;
      }
      this.poll();
    }
  }

  /** Read every observation dogd has after `since`. */
  private async drain(): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      const page = await this.api.observations(this.since);
      this.lost += page.lost;
      for (const o of page.observations) {
        const ev = this.bus.emit({
          source: 'CAMERA',
          tool: 'camera.net',
          type: 'observe',
          ...(this.op ? { op: this.op } : {}),
          severity: 'INFO',
          message: `${o.ip ?? o.iface} ${o.kind}: ${o.service ?? o.fields['note'] ?? ''}`.trim(),
          origin: this.origin,
          ...(o.ip ? { device: o.ip } : {}),
          params: { kind: o.kind, method: o.method, ip: o.ip, mac: o.mac, port: o.port, service: o.service, name: o.name, vendor: o.vendor },
          ...(o.raw ? { decoded: { decoder: `dogd.lan.${o.kind}`, version: '1', fields: { ...o.fields } } } : {}),
        });
        this.model.add(o, this.origin, ev.seq);
      }
      const done = page.observations.length === 0 || page.next === this.since;
      this.since = page.next;
      if (done) break;
    }
    this.changed();
  }

  private end(severity: 'PASS' | 'WARN', message: string, code?: string, say?: string): void {
    if (this.op) {
      this.bus.emit({ source: 'CAMERA', tool: 'camera.net', type: 'op.end', op: this.op, severity, message, origin: this.origin, ...(code ? { code } : {}), params: { devices: this.model.devices.size, ...(say ? { say } : {}) } });
    }
    this.op = null;
    this.changed();
  }

  private fail(code: string, message: string): void {
    this.clearTimer();
    this.state = 'ERROR';
    this.error = { code, message };
    if (this.op) this.bus.emit({ source: 'CAMERA', tool: 'camera.net', type: 'op.end', op: this.op, severity: 'FAIL', message, origin: this.origin, code });
    this.op = null;
    this.changed();
  }
}
