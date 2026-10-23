/**
 * HARDWARE DOG / GATT EXPLORER (Web Bluetooth)
 *
 * After an explicit connect to one device the operator picked: services,
 * characteristics, descriptors, reads, writes, notifications, all on a
 * timestamped history.
 *
 *   - Only services listed before the chooser opened can be reached (a Web
 *     Bluetooth rule): Hardware Dog lists every SIG service it knows plus
 *     the UUIDs the operator adds. Services the browser blocks stay hidden;
 *     what is shown is what the API allowed, not "all the device has".
 *   - A write is shown as bytes before it is sent, with the mode the
 *     characteristic allows. "Accepted by the API" is all a write result
 *     says: it does not prove the device acted.
 *   - After a disconnect nothing is sent again on its own: a reconnect is
 *     a click, and no earlier write is ever replayed.
 */

import { errorInfo, newOp, toBase64, type LabBus } from '../lab/events';
import { BleError, bluetoothApi, bytesOf, type BtCharacteristic, type BtDescriptor, type BtDevice, type BtServer } from './webbt';
import { shortUuid } from './model';

export interface GattDescriptorView {
  /** Unique within its characteristic: a UUID can appear more than once. */
  key: string;
  uuid: string;
  value: Uint8Array | null;
  error: string | null;
  desc: BtDescriptor | null;
}
export interface GattCharView {
  /** Unique within the session: GATT allows several instances of one UUID. */
  key: string;
  uuid: string;
  props: string[];
  descriptors: GattDescriptorView[];
  value: Uint8Array | null;
  notifying: boolean;
  char: BtCharacteristic;
}
export interface GattServiceView {
  key: string;
  uuid: string;
  chars: GattCharView[];
  error: string | null;
}

export interface GattEntry {
  at: number;
  kind: 'read' | 'write' | 'notify' | 'indicate' | 'error' | 'link';
  uuid: string | null;
  bytes: Uint8Array | null;
  text: string;
}

export type WriteMode = 'with-response' | 'without-response';

const PROPS = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'] as const;

export class GattSession {
  state: 'PICKED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' = 'PICKED';
  services: GattServiceView[] = [];
  history: GattEntry[] = [];
  private server: BtServer | null = null;
  private closing = false;
  private disposed = false;
  private listeners = new Set<() => void>();
  private rev = 0;
  private readonly onDisconnect = () => this.dropped();

  private constructor(
    readonly device: BtDevice,
    private readonly bus: LabBus,
  ) {
    device.addEventListener('gattserverdisconnected', this.onDisconnect);
  }

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

  get label(): string {
    return this.device.name ? `${this.device.name} (${this.device.id})` : this.device.id;
  }

  /** The browser chooser: one device, picked by the operator. Must run inside the click. */
  static async pick(bus: LabBus, optionalServices: string[]): Promise<GattSession> {
    const api = bluetoothApi();
    if (!api) throw new BleError('BLE_UNSUPPORTED', 'this browser has no Web Bluetooth');
    const device = await api.requestDevice({ acceptAllDevices: true, optionalServices });
    return new GattSession(device, bus);
  }

  private log(e: Omit<GattEntry, 'at'>): void {
    this.history.push({ ...e, at: this.bus.clock.now() });
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    this.changed();
  }

  private emit(type: 'op.start' | 'op.end' | 'link.state' | 'observe', op: string | undefined, severity: 'INFO' | 'PASS' | 'WARN' | 'FAIL', message: string, extra: object = {}): void {
    this.bus.emit({ source: 'BLE', tool: 'ble.gatt', type, ...(op ? { op } : {}), severity, message, origin: 'PHYSICAL', device: `WEB BLUETOOTH:${this.device.id}`, ...extra });
  }

  private async run<T>(kind: 'connect' | 'read' | 'write' | 'search', message: string, fn: () => Promise<T>): Promise<T> {
    const op = newOp('ble.gatt');
    this.emit('op.start', op, 'INFO', message, { params: { kind } });
    try {
      const r = await fn();
      this.emit('op.end', op, 'PASS', message);
      return r;
    } catch (e) {
      const { message: why, code } = errorInfo(e);
      this.emit('op.end', op, 'FAIL', `${message}: ${why}`, code ? { code } : {});
      this.log({ kind: 'error', uuid: null, bytes: null, text: `${message}: ${code ? `[${code}] ` : ''}${why}` });
      throw e;
    }
  }

  async connect(): Promise<void> {
    if (this.state === 'CONNECTED' || this.state === 'CONNECTING') return;
    if (!this.device.gatt) throw new BleError('BLE_UNSUPPORTED', 'this device has no GATT server in this browser');
    this.state = 'CONNECTING';
    this.closing = false;
    this.changed();
    this.emit('link.state', undefined, 'INFO', `connecting ${this.label}`, { params: { state: 'CONNECTING' } });
    try {
      this.server = await this.run('connect', `GATT connect ${this.label}`, () => this.device.gatt!.connect());
    } catch (e) {
      this.state = 'DISCONNECTED';
      this.changed();
      throw e;
    }
    // Closed (or replaced by another pick) while connecting: let the link go.
    if (this.closing || this.disposed) {
      this.server.disconnect();
      // (a disconnect() during the await may already have marked it)
      if ((this.state as GattSession['state']) !== 'DISCONNECTED') this.dropped();
      return;
    }
    this.state = 'CONNECTED';
    this.log({ kind: 'link', uuid: null, bytes: null, text: 'connected' });
    this.emit('link.state', undefined, 'PASS', `${this.label} connected (GATT)`, { params: { state: 'CONNECTED' } });
    await this.explore().catch(() => {});
  }

  private dropped(): void {
    // Never connected in this session (the same device was picked again and
    // the earlier session let it go): nothing of ours was lost.
    if (this.state === 'PICKED') return;
    const wasConnected = this.state === 'CONNECTED';
    this.state = 'DISCONNECTED';
    // The link is gone, and with it every subscription: no handler is left to log a later value twice.
    for (const s of this.services)
      for (const c of s.chars) {
        const held = c as GattCharView & { handler?: (e: Event) => void };
        if (held.handler) c.char.removeEventListener('characteristicvaluechanged', held.handler);
        held.handler = undefined;
        c.notifying = false;
      }
    this.log({ kind: 'link', uuid: null, bytes: null, text: this.closing ? 'disconnected on request' : 'the device disconnected' });
    if (wasConnected || !this.closing)
      this.emit('link.state', undefined, this.closing ? 'INFO' : 'WARN', this.closing ? `${this.label} disconnected` : `${this.label} disconnected (lost)`, { params: { state: 'DISCONNECTED', reason: this.closing ? 'closed' : 'lost' } });
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    // While CONNECTING there is no server yet: the device's own handle still cancels it.
    (this.server ?? this.device.gatt)?.disconnect();
    if (this.state !== 'DISCONNECTED') this.dropped();
  }

  dispose(): void {
    this.disposed = true;
    void this.disconnect();
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    this.listeners.clear();
  }

  private need(): BtServer {
    if (!this.server || this.state !== 'CONNECTED' || !this.server.connected) throw new BleError('InvalidStateError', 'not connected: connect first (nothing is resent on its own)');
    return this.server;
  }

  /** Every service the browser lets this page see, with characteristics and descriptors. */
  async explore(): Promise<void> {
    const server = this.need();
    await this.run('search', 'GATT discover services', async () => {
      const out: GattServiceView[] = [];
      for (const [si, s] of (await server.getPrimaryServices()).entries()) {
        const view: GattServiceView = { key: `s${si}`, uuid: shortUuid(s.uuid), chars: [], error: null };
        try {
          for (const [ci, c] of (await s.getCharacteristics()).entries()) {
            const cv: GattCharView = { key: `s${si}c${ci}`, uuid: shortUuid(c.uuid), props: PROPS.filter((p) => c.properties[p]), descriptors: [], value: null, notifying: false, char: c };
            try {
              for (const [di, d] of (await c.getDescriptors()).entries()) cv.descriptors.push({ key: `d${di}`, uuid: shortUuid(d.uuid), value: null, error: null, desc: d });
            } catch (e) {
              cv.descriptors.push({ key: 'err', uuid: '--', value: null, error: errorInfo(e).message, desc: null });
            }
            view.chars.push(cv);
          }
        } catch (e) {
          view.error = errorInfo(e).message;
        }
        out.push(view);
      }
      this.services = out;
      this.changed();
    });
  }

  async read(c: GattCharView): Promise<Uint8Array> {
    this.need();
    const bytes = await this.run('read', `GATT read ${c.uuid}`, async () => bytesOf(await c.char.readValue()));
    c.value = bytes;
    this.log({ kind: 'read', uuid: c.uuid, bytes, text: 'read' });
    this.emit('observe', undefined, 'INFO', `read ${c.uuid}: ${bytes.length} byte(s)`, { raw: toBase64(bytes), params: { uuid: c.uuid, op: 'read' } });
    return bytes;
  }

  async readDescriptor(c: GattCharView, view: GattDescriptorView): Promise<void> {
    this.need();
    const d = view.desc;
    const uuid = view.uuid;
    if (!d) return;
    try {
      view.value = await this.run('read', `GATT read descriptor ${uuid}`, async () => bytesOf(await d.readValue()));
      view.error = null;
      this.log({ kind: 'read', uuid, bytes: view.value, text: `descriptor of ${c.uuid}` });
    } catch (e) {
      view.error = errorInfo(e).message;
      this.changed();
    }
  }

  /** The write modes this characteristic declares, and the browser offers. */
  writeModes(c: GattCharView): WriteMode[] {
    const m: WriteMode[] = [];
    if (c.props.includes('write')) m.push('with-response');
    if (c.props.includes('writeWithoutResponse')) m.push('without-response');
    return m;
  }

  /** Send bytes the operator saw first. Once; never repeated on its own. */
  async write(c: GattCharView, bytes: Uint8Array, mode: WriteMode): Promise<void> {
    this.need();
    if (!this.writeModes(c).includes(mode)) throw new BleError('NotSupportedError', `${c.uuid} does not declare a ${mode} write`);
    const buf = bytes.slice().buffer;
    await this.run('write', `GATT write ${c.uuid} (${mode}, ${bytes.length} byte(s))`, async () => {
      if (mode === 'with-response') await (c.char.writeValueWithResponse ?? c.char.writeValue)!.call(c.char, buf);
      else await c.char.writeValueWithoutResponse!.call(c.char, buf);
    });
    this.log({ kind: 'write', uuid: c.uuid, bytes, text: mode === 'with-response' ? 'accepted (the device acknowledged the write; not proof it acted)' : 'handed to the API (no acknowledgment: not proof it arrived)' });
    this.emit('observe', undefined, 'INFO', `write ${c.uuid} (${mode})`, { raw: toBase64(bytes), params: { uuid: c.uuid, op: 'write', mode } });
  }

  async notify(c: GattCharView, on: boolean): Promise<void> {
    this.need();
    const kind = c.props.includes('notify') ? 'notify' : 'indicate';
    const held = c as GattCharView & { handler?: (e: Event) => void };
    if (on) {
      // A second START before the first one answered: one handler is enough.
      if (held.handler) return;
      const handler = (e: Event) => {
        const v = (e.target as BtCharacteristic).value;
        if (!v) return;
        const bytes = bytesOf(v);
        c.value = bytes;
        this.log({ kind, uuid: c.uuid, bytes, text: kind === 'notify' ? 'notification' : 'indication' });
        this.emit('observe', undefined, 'INFO', `${kind} ${c.uuid}: ${bytes.length} byte(s)`, { raw: toBase64(bytes), params: { uuid: c.uuid, op: kind } });
      };
      held.handler = handler;
      c.char.addEventListener('characteristicvaluechanged', handler);
      try {
        await this.run('read', `GATT start ${kind} ${c.uuid}`, () => c.char.startNotifications());
      } catch (e) {
        c.char.removeEventListener('characteristicvaluechanged', handler);
        held.handler = undefined;
        throw e;
      }
      c.notifying = true;
    } else {
      const h = held.handler;
      if (h) c.char.removeEventListener('characteristicvaluechanged', h);
      held.handler = undefined;
      await this.run('read', `GATT stop ${kind} ${c.uuid}`, () => c.char.stopNotifications()).catch(() => {});
      c.notifying = false;
    }
    this.changed();
  }
}
