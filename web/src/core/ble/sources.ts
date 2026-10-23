/**
 * HARDWARE DOG / BLE SCAN SOURCES
 *
 *   WEB BLUETOOTH  requestLEScan, where the browser has it (experimental)
 *   DOGD           BlueZ discovery through the local daemon (Linux)
 *   DEMO           simulated advertisers, labeled DEMO everywhere
 *
 * Each one delivers observations as they come; none of them merges ids,
 * invents a field, or keeps scanning after stop().
 */

import { dogdBleObservations, dogdBleScan, dogdBleStatus, type DogdBleObservation } from '../dogd';
import type { LabClock } from '../lab/events';
import { capList, shortUuid, type BleObservation, type BleSourceKind } from './model';
import { BleError, bluetoothApi, fromAdvertisement, type BtAdvertisingEvent, type BtScan } from './webbt';

export interface BleSink {
  observe(o: BleObservation): void;
  /** Reports the source says it lost. */
  lost(n: number): void;
  /** The source stopped on its own (error, adapter gone). */
  failed(code: string, message: string): void;
}

export interface BleSource {
  readonly kind: BleSourceKind;
  readonly origin: 'PHYSICAL' | 'SIMULATED';
  start(sink: BleSink): Promise<void>;
  stop(): Promise<void>;
}

export class WebBluetoothScan implements BleSource {
  readonly kind = 'WEB BLUETOOTH' as const;
  readonly origin = 'PHYSICAL' as const;
  private scan: BtScan | null = null;
  private onAdv: ((e: Event) => void) | null = null;
  /** Bumped by every start and stop: a start that resolves after a stop gives up. */
  private gen = 0;

  constructor(private readonly clock: LabClock) {}

  async start(sink: BleSink): Promise<void> {
    const api = bluetoothApi();
    if (!api) throw new BleError('BLE_UNSUPPORTED', 'this browser has no Web Bluetooth');
    if (!api.requestLEScan) throw new BleError('BLE_UNSUPPORTED', 'requestLEScan is not enabled in this browser (experimental flag)');
    const gen = ++this.gen;
    // Must be called from the click: the permission prompt needs the gesture.
    const scan = await api.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    if (gen !== this.gen) {
      // STOP was pressed while the prompt was open.
      scan.stop();
      return;
    }
    this.scan = scan;
    this.onAdv = (e) => sink.observe(fromAdvertisement(e as BtAdvertisingEvent, this.clock.now(), this.clock.mono()));
    api.addEventListener('advertisementreceived', this.onAdv);
  }

  async stop(): Promise<void> {
    this.gen++;
    const api = bluetoothApi();
    if (api && this.onAdv) api.removeEventListener('advertisementreceived', this.onAdv);
    this.onAdv = null;
    this.scan?.stop();
    this.scan = null;
  }
}

const fromHex = (h: string): Uint8Array => {
  const clean = /^[0-9a-fA-F]*$/.test(h) && h.length % 2 === 0 ? h : '';
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/** A dogd report as an observation; its time mapped to this page's monotonic clock. */
export function fromDogd(o: DogdBleObservation, dogdNowMono: number, clock: LabClock): BleObservation {
  const age = Math.max(0, dogdNowMono - o.mono_ms);
  return {
    at: o.wall_ms,
    // Same computer, two monotonic clocks: the offset is known to within the request's latency.
    mono: clock.mono() - age,
    source: 'DOGD',
    adapter: o.adapter,
    id: o.address,
    idKind: 'bluez-address',
    address: o.address,
    addressType: o.address_type,
    advName: o.name,
    systemName: o.alias && o.alias !== o.name && o.alias.replace(/-/g, ':') !== o.address ? o.alias : null,
    rssi: o.rssi,
    txPower: o.tx_power,
    connectable: null,
    services: capList(o.uuids).map((u) => shortUuid(u)),
    manufacturer: capList(Object.entries(o.manufacturer)).map(([c, h]) => ({ company: Number(c), data: fromHex(h) })),
    serviceData: capList(Object.entries(o.service_data)).map(([u, h]) => ({ uuid: shortUuid(u), data: fromHex(h) })),
  };
}

export class DogdBleScan implements BleSource {
  readonly kind = 'DOGD' as const;
  readonly origin = 'PHYSICAL' as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private since = 0;
  private running = false;
  /** Bumped by every start and stop: a start that resolves after a stop gives up. */
  private gen = 0;
  /** What the last button asked for: true after start(), false after stop(). */
  private wanted = false;

  constructor(private readonly clock: LabClock) {}

  async start(sink: BleSink): Promise<void> {
    const gen = ++this.gen;
    this.wanted = true;
    const s = await dogdBleScan(true);
    // STOP was pressed while dogd was starting discovery: its stop may have
    // reached dogd first, so say it again rather than leave BlueZ scanning.
    if (gen !== this.gen) {
      if (s.state === 'scanning' && !this.wanted) await dogdBleScan(false).catch(() => {});
      return;
    }
    if (!s.supported) throw new BleError('BLE_UNSUPPORTED', s.detail || 'dogd has no Bluetooth scanner on this system');
    if (s.state === 'no_adapter') throw new BleError('BLE_NO_ADAPTER', s.detail || 'no Bluetooth adapter');
    if (s.state === 'permission') throw new BleError('NotAllowedError', s.detail || 'BlueZ refused discovery');
    if (s.state !== 'scanning') throw new BleError('BLE_ERROR', s.detail || s.state);
    this.running = true;
    // Only what arrives from now on: older reports belong to another session.
    const first = await dogdBleObservations(Number.MAX_SAFE_INTEGER).catch(() => null);
    if (gen !== this.gen) return;
    this.since = first?.next ?? 0;
    let polls = 0;
    const poll = async () => {
      if (!this.running || gen !== this.gen) return;
      try {
        // Every 2 s: is dogd still discovering? (adapter powered off, unplugged, bluetoothd gone)
        if (++polls % 5 === 0) {
          const st = await dogdBleStatus();
          if (gen !== this.gen) return;
          if (st.state !== 'scanning') {
            this.running = false;
            sink.failed(st.state === 'no_adapter' ? 'BLE_NO_ADAPTER' : 'BLE_ERROR', `dogd: ${st.detail || st.state}`);
            return;
          }
        }
        const r = await dogdBleObservations(this.since);
        if (gen !== this.gen) return;
        this.since = r.next;
        if (r.lost) sink.lost(r.lost);
        for (const o of r.observations) sink.observe(fromDogd(o, r.now_mono_ms, this.clock));
      } catch (e) {
        if (this.running && gen === this.gen) {
          this.running = false;
          sink.failed('TEMPORARY_ERROR', `dogd: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
      if (this.running && gen === this.gen) this.timer = setTimeout(() => void poll(), 400);
    };
    void poll();
  }

  async stop(): Promise<void> {
    this.gen++;
    this.wanted = false;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await dogdBleScan(false).catch(() => {});
  }
}

interface DemoAdvertiser {
  id: string;
  name: string | null;
  every: number;
  rssi: number;
  txPower: number | null;
  services: string[];
  payload(n: number): Pick<BleObservation, 'manufacturer' | 'serviceData'>;
}

/** Demo advertisers. Their names say DEMO; company 0xFFFF is the SIG's id reserved for tests. */
const DEMO_ADVERTISERS: DemoAdvertiser[] = [
  {
    id: 'DEMO-01',
    name: 'DEMO Sensor',
    every: 700,
    rssi: -58,
    txPower: 4,
    services: ['180F'],
    payload: (n) => ({ manufacturer: [], serviceData: [{ uuid: '180F', data: Uint8Array.of(Math.max(5, 97 - Math.floor(n / 40))) }] }),
  },
  {
    id: 'DEMO-02',
    name: 'DEMO Beacon',
    every: 500,
    rssi: -71,
    txPower: null,
    services: [],
    payload: () => ({
      manufacturer: [{ company: 0x004c, data: Uint8Array.of(0x02, 0x15, 0xde, 0x40, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x07, 0x00, 0x2a, 0xc5) }],
      serviceData: [],
    }),
  },
  {
    id: 'DEMO-03',
    name: null,
    every: 1000,
    rssi: -80,
    txPower: null,
    services: ['FEAA'],
    payload: (n) => {
      const adv = 1000 + n;
      const sec = 36000 + n * 10;
      return { manufacturer: [], serviceData: [{ uuid: 'FEAA', data: Uint8Array.of(0x20, 0x00, 0x0b, 0xb8, 0x16, 0x80, (adv >>> 24) & 255, (adv >>> 16) & 255, (adv >>> 8) & 255, adv & 255, (sec >>> 24) & 255, (sec >>> 16) & 255, (sec >>> 8) & 255, sec & 255) }] };
    },
  },
  {
    id: 'DEMO-04',
    name: 'DEMO Tag',
    every: 900,
    rssi: -66,
    txPower: null,
    services: [],
    payload: (n) => ({ manufacturer: [{ company: 0xffff, data: Uint8Array.of(0x48, 0x44, n % 4 === 0 ? 0x01 : 0x00, (n >> 2) & 255) }], serviceData: [] }),
  },
];

/** Simulated advertisers, for DEMO MODE and tests. Labeled SIMULATED, ids DEMO-xx. */
export class DemoBleScan implements BleSource {
  readonly kind = 'DEMO' as const;
  readonly origin = 'SIMULATED' as const;
  private timers: ReturnType<typeof setInterval>[] = [];
  private rotating = 0;

  constructor(
    private readonly clock: LabClock,
    private readonly speed = 1,
  ) {}

  async start(sink: BleSink): Promise<void> {
    const walk = new Map<string, number>();
    for (const a of DEMO_ADVERTISERS) {
      let n = 0;
      this.timers.push(
        setInterval(() => {
          const r = Math.max(-100, Math.min(-30, (walk.get(a.id) ?? a.rssi) + Math.round((Math.random() - 0.5) * 6)));
          walk.set(a.id, r);
          sink.observe({
            at: this.clock.now(),
            mono: this.clock.mono(),
            source: 'DEMO',
            adapter: 'demo',
            id: a.id,
            idKind: 'demo-id',
            address: null,
            addressType: null,
            advName: a.name,
            systemName: null,
            rssi: r,
            txPower: a.txPower,
            connectable: a.id === 'DEMO-01' ? true : null,
            services: a.services,
            ...a.payload(n++),
          });
        }, a.every / this.speed),
      );
    }
    // A device whose random address changes every 30 s: it shows as a new row each time, on purpose.
    this.timers.push(
      setInterval(() => {
        const id = `DEMO-RND-${Math.floor(this.rotating++ / 30)}`;
        sink.observe({ at: this.clock.now(), mono: this.clock.mono(), source: 'DEMO', adapter: 'demo', id, idKind: 'demo-id', address: null, addressType: 'random', advName: null, systemName: null, rssi: -75, txPower: null, connectable: null, services: [], manufacturer: [{ company: 0xffff, data: Uint8Array.of(0x52, 0x4e, 0x44) }], serviceData: [] });
      }, 1000 / this.speed),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
