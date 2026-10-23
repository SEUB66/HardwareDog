/**
 * HARDWARE DOG / BLUETOOTH LAB SERVICE
 *
 * One scanner, one GATT session at a time, for the whole interface. The
 * scan model is updated on every observation, whatever is on screen;
 * PAUSE freezes what the screen shows and never stops the acquisition,
 * STOP ends the acquisition.
 *
 * On the lab bus (and so in a lab session), observations are recorded
 * sampled: a device's observation is written when its payload changed, or
 * at most once a second; the ones in between are counted (params.repeats).
 * The screen sees every one; the session says how it sampled.
 */

import { errorInfo, newOp, type LabBus, type LabEvent } from '../lab/events';
import type { LabSessionData } from '../lab/session';
import { GattSession } from './gatt';
import { BLE_LIMITS, BleScanModel, capList, type BleDevice, type BleObservation, type BleSourceKind } from './model';
import { DemoBleScan, DogdBleScan, WebBluetoothScan, type BleSource } from './sources';
import { toHex } from './values';

export const SAMPLE_MS = 1000;

export type ScanState = 'IDLE' | 'STARTING' | 'SCANNING' | 'STOPPED' | 'ERROR' | 'REPLAY';

const hexToBytes = (h: string) => Uint8Array.from(h.match(/[0-9a-fA-F]{2}/g) ?? [], (b) => parseInt(b, 16));

/** Payload fields as one stable text ("004C=0215..."), for the session file. */
export function payloadParams(o: Pick<BleObservation, 'manufacturer' | 'serviceData'>): { mfr: string; svc: string } {
  const h = (b: Uint8Array) => toHex(b).replace(/ /g, '');
  return {
    mfr: o.manufacturer.map((m) => `${m.company.toString(16).toUpperCase().padStart(4, '0')}=${h(m.data)}`).join(';'),
    svc: o.serviceData.map((s) => `${s.uuid}=${h(s.data)}`).join(';'),
  };
}

/** A recorded observation event back into an observation (replay). */
export function observationOf(e: LabEvent): BleObservation | null {
  if (e.source !== 'BLE' || e.type !== 'observe' || e.tool !== 'ble.scan' || !e.params) return null;
  const p = e.params;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const pairs = (k: string) => (str(k) ?? '').split(';').filter(Boolean).map((x) => x.split('=') as [string, string]);
  const rssi = e.measures?.find((m) => m.name === 'rssi')?.value ?? null;
  const tx = e.measures?.find((m) => m.name === 'txPower')?.value ?? null;
  return {
    at: e.at,
    mono: e.mono,
    source: 'REPLAY',
    adapter: str('adapter') ?? 'replay',
    id: str('id') ?? e.device ?? '?',
    idKind: 'replay',
    address: str('address'),
    addressType: (str('addressType') as BleObservation['addressType']) ?? null,
    advName: str('name'),
    systemName: str('systemName'),
    rssi,
    txPower: tx,
    connectable: typeof p['connectable'] === 'boolean' ? (p['connectable'] as boolean) : null,
    services: (str('services') ?? '').split(' ').filter(Boolean),
    manufacturer: pairs('mfr').map(([c, h]) => ({ company: parseInt(c, 16), data: hexToBytes(h) })),
    serviceData: pairs('svc').map(([u, h]) => ({ uuid: u, data: hexToBytes(h) })),
  };
}

export class BleService {
  readonly model = new BleScanModel();
  state: ScanState = 'IDLE';
  sourceKind: BleSourceKind | null = null;
  origin: 'PHYSICAL' | 'SIMULATED' | 'REPLAY' = 'PHYSICAL';
  error: { code: string; message: string } | null = null;
  /** PAUSE: the screen holds still; capture continues. */
  paused = false;
  gatt: GattSession | null = null;
  replayOf: string | null = null;
  /** The replayed session's integrity, and whether any of it was simulated: said in the scan view. */
  replayIntegrity: string | null = null;
  replaySimulated = false;
  /** When the live scan on screen started (host wall clock); null for a replay or none. */
  scanStartedAt: number | null = null;
  private source: BleSource | null = null;
  private scanOp: string | null = null;
  private sampled = new Map<string, { mono: number; repeats: number }>();
  private listeners = new Set<() => void>();
  private rev = 0;
  /** Recorded observations skipped by sampling (counted in params.repeats). */
  sampledOut = 0;

  constructor(private readonly bus: LabBus) {}

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

  get scanning(): boolean {
    return this.state === 'SCANNING' || this.state === 'STARTING';
  }

  private makeSource(kind: 'WEB BLUETOOTH' | 'DOGD' | 'DEMO', speed?: number): BleSource {
    if (kind === 'WEB BLUETOOTH') return new WebBluetoothScan(this.bus.clock);
    if (kind === 'DOGD') return new DogdBleScan(this.bus.clock);
    return new DemoBleScan(this.bus.clock, speed);
  }

  /** Start a scan. One at a time: a start while scanning starts nothing new. */
  async start(kind: 'WEB BLUETOOTH' | 'DOGD' | 'DEMO', options: { speed?: number } = {}): Promise<void> {
    if (this.scanning) return;
    const source = this.makeSource(kind, options.speed);
    this.model.clear();
    this.sampled.clear();
    this.sampledOut = 0;
    this.replayOf = null;
    this.replayIntegrity = null;
    this.replaySimulated = false;
    this.scanStartedAt = this.bus.clock.now();
    this.source = source;
    this.sourceKind = kind;
    this.origin = source.origin;
    this.state = 'STARTING';
    this.error = null;
    this.paused = false;
    this.changed();
    const op = newOp('ble.scan');
    this.scanOp = op;
    this.bus.emit({ source: 'BLE', tool: 'ble.scan', type: 'op.start', op, severity: 'INFO', message: `BLE scan (${kind})`, params: { kind: 'search', via: kind }, origin: source.origin });
    try {
      await source.start({
        observe: (o) => this.observe(o),
        lost: (n) => {
          this.model.sourceLost += n;
          this.bus.emit({ source: 'BLE', tool: 'ble.scan', type: 'info', severity: 'WARN', message: `${n} report(s) lost by the source`, params: { lost: n }, origin: source.origin });
        },
        failed: (code, message) => void this.fail(code, message),
      });
    } catch (e) {
      const { message, code } = errorInfo(e);
      await this.fail(code ?? 'BLE_ERROR', message);
      throw e;
    }
    if (this.source !== source) return;
    this.state = 'SCANNING';
    this.changed();
  }

  private async fail(code: string, message: string): Promise<void> {
    const source = this.source;
    // a failure after the scan had started (the adapter pulled out) is said differently from a start that failed
    const running = this.state === 'SCANNING';
    this.source = null;
    await source?.stop().catch(() => {});
    this.state = 'ERROR';
    this.error = { code, message };
    if (this.scanOp)
      this.bus.emit({
        source: 'BLE',
        tool: 'ble.scan',
        type: 'op.end',
        op: this.scanOp,
        severity: code === 'NotFoundError' ? 'INFO' : 'FAIL',
        message: `BLE scan: ${message}`,
        code,
        origin: this.origin === 'SIMULATED' ? 'SIMULATED' : 'PHYSICAL',
        ...(running ? { params: { phase: 'running' } } : {}),
      });
    this.scanOp = null;
    this.changed();
  }

  async stop(): Promise<void> {
    const source = this.source;
    if (!source) return;
    this.source = null;
    await source.stop();
    this.state = 'STOPPED';
    this.paused = false;
    if (this.scanOp)
      this.bus.emit({
        source: 'BLE',
        tool: 'ble.scan',
        type: 'op.end',
        op: this.scanOp,
        severity: 'PASS',
        message: `BLE scan stopped: ${this.model.observations} observation(s), ${this.model.devices.size} id(s)`,
        // stopped on request: not a success to celebrate, not an error
        params: { outcome: 'stopped', observations: this.model.observations, devices: this.model.devices.size, lost: this.model.sourceLost, refused: this.model.refused },
        origin: source.origin,
      });
    this.scanOp = null;
    this.changed();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.changed();
  }

  private observe(o: BleObservation): void {
    const r = this.model.add(o);
    if (!r) return;
    // Sampled for the timeline: a change is always written; the same payload, once a second.
    const s = this.sampled.get(r.device.key);
    if (s && !r.changed && o.mono - s.mono < SAMPLE_MS) {
      s.repeats++;
      this.sampledOut++;
      return;
    }
    const repeats = s?.repeats ?? 0;
    this.sampled.set(r.device.key, { mono: o.mono, repeats: 0 });
    const { mfr, svc } = payloadParams(o);
    const name = o.advName ?? o.systemName;
    this.bus.emit({
      source: 'BLE',
      tool: 'ble.scan',
      type: 'observe',
      severity: 'INFO',
      message: `${name ?? o.id} ${o.rssi ?? '--'} dBm${r.changed ? ' (payload changed)' : ''}`,
      origin: o.source === 'DEMO' ? 'SIMULATED' : 'PHYSICAL',
      device: r.device.key,
      at: o.at,
      mono: o.mono,
      params: {
        id: o.id,
        idKind: o.idKind,
        adapter: o.adapter,
        address: o.address,
        addressType: o.addressType,
        name: o.advName,
        systemName: o.systemName,
        connectable: o.connectable,
        services: capList(o.services).join(' '),
        ...(o.services.length > BLE_LIMITS.maxEntries ? { servicesCut: o.services.length - BLE_LIMITS.maxEntries } : {}),
        mfr,
        svc,
        repeats,
        payloadChanged: r.changed,
      },
      measures: [
        ...(o.rssi !== null ? [{ name: 'rssi', value: o.rssi, unit: 'dBm', provenance: 'MEASURED' as const }] : []),
        ...(o.txPower !== null ? [{ name: 'txPower', value: o.txPower, unit: 'dBm', provenance: 'DECODED' as const }] : []),
      ],
    });
  }

  /** Rebuild the scan view from a lab session (read-only: nothing is sent anywhere). */
  async replay(data: LabSessionData): Promise<number> {
    await this.stop();
    this.model.clear();
    this.error = null;
    this.state = 'REPLAY';
    this.sourceKind = 'REPLAY';
    this.origin = 'REPLAY';
    this.replayOf = data.header.name;
    this.replayIntegrity = data.integrity;
    this.replaySimulated = data.events.some((e) => e.origin === 'SIMULATED');
    this.scanStartedAt = null;
    let n = 0;
    for (const e of data.events) {
      const o = observationOf(e);
      if (o) {
        this.model.add(o);
        n++;
      }
    }
    this.changed();
    return n;
  }

  // ------------------------------------------------------------------ GATT

  async pickGatt(optionalServices: string[]): Promise<GattSession> {
    // The device in use stays until another one is actually picked: a
    // cancelled chooser leaves everything as it was.
    const g = await GattSession.pick(this.bus, optionalServices);
    this.gatt?.dispose();
    this.gatt = g;
    g.subscribe(() => this.changed());
    this.changed();
    return g;
  }

  closeGatt(): void {
    this.gatt?.dispose();
    this.gatt = null;
    this.changed();
  }

  device(key: string): BleDevice | undefined {
    return this.model.devices.get(key);
  }
}
