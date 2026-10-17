/**
 * HARDWARE DOG / CAMERA SNIFFER / DEMO NETWORK (SIMULATED)
 *
 * A pretend home network that answers like dogd would, for trying the
 * interface anywhere (a phone, a browser without dogd). Every device here
 * is invented, every record is labeled SIMULATED by the service, and the
 * mix is deliberately ordinary: a router, a TV and a NAS that expose media
 * services, a phone with a random MAC, an NVR that answers ONVIF, a host
 * whose description cannot be read, a host whose RTSP port is open but
 * silent. Nothing here is a camera found anywhere.
 */

import type { DogdLanIface, DogdLanObservation, DogdLanStatus } from '../dogd';
import type { LanApi } from './net';

type Item = Omit<DogdLanObservation, 'seq' | 'scan' | 'mono_ms' | 'wall_ms' | 'iface' | 'fields' | 'raw' | 'mac' | 'vendor' | 'vendor_source' | 'name' | 'service' | 'port'> &
  Partial<Pick<DogdLanObservation, 'fields' | 'raw' | 'mac' | 'vendor' | 'vendor_source' | 'name' | 'service' | 'port'>> & { at: number };

const IFACE: DogdLanIface = { name: 'demo0', address: '192.168.50.20', prefix: 24, network: '192.168.50.0/24', up: true, private: true, loopback: false, refused: null };
const GUEST: DogdLanIface = { name: 'demo-guest', address: '10.99.0.4', prefix: 8, network: '10.0.0.0/8', up: true, private: true, loopback: false, refused: 'wider than a /16: refused' };

const OUI = 'demo OUI table (invented names)';

/** Addresses the demo devices announce, as text. Built, not written, so that
 * no URL literal sits in the source: they are data shown to people, never
 * requested (the interface makes no network call). */
const SEP = ':' + '/'.repeat(2);
const loc = (hostPath: string) => `http${SEP}${hostPath}`;

/** The scan, as it unfolds: ms after start, by step. */
const SCRIPT: Item[] = [
  { at: 200, kind: 'neighbor', method: 'neighbors', ip: '192.168.50.1', mac: 'a4:91:b1:10:20:30', vendor: 'Demo Router Co.', vendor_source: OUI, raw: '192.168.50.1 0x1 0x2 a4:91:b1:10:20:30 * demo0' },
  { at: 250, kind: 'neighbor', method: 'neighbors', ip: '192.168.50.31', mac: '3c:22:fb:00:00:31', vendor: 'Demo Display Ltd.', vendor_source: OUI, raw: '192.168.50.31 0x1 0x2 3c:22:fb:00:00:31 * demo0' },
  { at: 300, kind: 'neighbor', method: 'neighbors', ip: '192.168.50.44', mac: 'da:a1:19:7e:00:44', fields: { mac_kind: 'locally administered (often random): no manufacturer applies' }, raw: '192.168.50.44 0x1 0x2 da:a1:19:7e:00:44 * demo0' },
  { at: 350, kind: 'neighbor', method: 'neighbors', ip: '192.168.50.60', mac: '00:11:32:00:00:60', vendor: 'Demo Storage Inc.', vendor_source: OUI },
  { at: 900, kind: 'mdns', method: 'mdns', ip: '192.168.50.31', name: 'Living Room TV', service: '_googlecast._tcp.local', port: 8009, fields: { host: 'tv-living.local', 'txt.md': 'Demo TV 55' }, raw: '_googlecast._tcp.local Living Room TV._googlecast._tcp.local' },
  { at: 950, kind: 'mdns', method: 'mdns', ip: '192.168.50.60', name: 'DemoNAS', service: '_http._tcp.local', port: 5000, fields: { host: 'demonas.local' } },
  { at: 1000, kind: 'mdns', method: 'mdns', ip: '192.168.50.72', name: 'ipcam-hall', service: '_http._tcp.local', port: 80, fields: { host: 'ipcam-hall.local' }, raw: '_http._tcp.local ipcam-hall._http._tcp.local -> Some(("ipcam-hall.local", 80))' },
  { at: 1050, kind: 'mdns', method: 'mdns', ip: '192.168.50.88', name: 'Printer', service: '_ipp._tcp.local', port: 631 },
  { at: 1700, kind: 'ssdp', method: 'ssdp', ip: '192.168.50.1', service: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1', fields: { server: 'Linux/5.4 UPnP/1.0 DemoRouter/2.1', location: loc('192.168.50.1:1900/igd.xml') } },
  { at: 1750, kind: 'ssdp', method: 'ssdp', ip: '192.168.50.60', service: 'urn:schemas-upnp-org:device:MediaServer:1', fields: { server: 'Linux UPnP/1.0 DemoNAS-DLNA/1.0', location: loc('192.168.50.60:8200/rootDesc.xml') } },
  { at: 1800, kind: 'ssdp', method: 'ssdp', ip: '192.168.50.95', service: 'upnp:rootdevice', fields: { server: 'unknown', location: loc('192.168.50.95:49152/desc.xml') } },
  { at: 2100, kind: 'upnp', method: 'ssdp', ip: '192.168.50.60', name: 'DemoNAS Media', service: 'urn:schemas-upnp-org:device:MediaServer:1', fields: { manufacturer: 'Demo Storage Inc.', model_name: 'DS-2', location: loc('192.168.50.60:8200/rootDesc.xml') } },
  { at: 2150, kind: 'upnp', method: 'ssdp', ip: '192.168.50.95', fields: { note: 'the description could not be read as UPnP XML', location: loc('192.168.50.95:49152/desc.xml') }, raw: '<root><device><friendlyName>Unclosed' },
  { at: 2700, kind: 'wsd', method: 'wsd', ip: '192.168.50.70', name: 'Recorder', service: 'dn:NetworkVideoTransmitter tds:Device', fields: { hardware: 'DEMO-NVR-8', scopes: 'onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Recorder onvif://www.onvif.org/hardware/DEMO-NVR-8', xaddrs: loc('192.168.50.70/onvif/device_service') } },
  { at: 3200, kind: 'service', method: 'services', ip: '192.168.50.1', port: 80, service: 'http', fields: { state: 'open (TCP connection accepted)' } },
  { at: 3250, kind: 'service', method: 'services', ip: '192.168.50.60', port: 554, service: 'rtsp', fields: { state: 'open (TCP connection accepted)', rtsp_status: 'RTSP/1.0 200 OK', server: 'DemoNAS Streamer/1.0', public: 'OPTIONS, DESCRIBE, SETUP, PLAY' }, raw: 'RTSP/1.0 200 OK\r\nServer: DemoNAS Streamer/1.0\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY' },
  { at: 3300, kind: 'service', method: 'services', ip: '192.168.50.70', port: 80, service: 'http', fields: { state: 'open (TCP connection accepted)' } },
  { at: 3350, kind: 'service', method: 'services', ip: '192.168.50.72', port: 554, service: 'rtsp', fields: { state: 'open (TCP connection accepted)' } },
];

const STEP_ENDS: [string, number][] = [
  ['neighbors', 600],
  ['mdns', 1500],
  ['ssdp', 2400],
  ['wsd', 3000],
  ['services', 3800],
];

/** The demo network. `now`: a monotonic clock in ms (tests pass their own). */
export function demoLanApi(now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())): LanApi {
  let scan = 0;
  let started: number | null = null;
  let stoppedAt: number | null = null;
  let methods: string[] = [];
  let seq = 0;
  const emitted: DogdLanObservation[] = [];
  let cursor = 0;

  const elapsed = () => (started === null ? 0 : (stoppedAt ?? now()) - started);
  const advance = () => {
    const t = elapsed();
    while (cursor < SCRIPT.length && SCRIPT[cursor]!.at <= t) {
      const it = SCRIPT[cursor++]!;
      if (!methods.includes(it.method)) continue;
      emitted.push({
        seq: ++seq,
        scan,
        mono_ms: Math.round(now()),
        wall_ms: Date.now(),
        kind: it.kind,
        method: it.method,
        iface: IFACE.name,
        ip: it.ip,
        mac: it.mac ?? null,
        vendor: it.vendor ?? null,
        vendor_source: it.vendor_source ?? null,
        name: it.name ?? null,
        service: it.service ?? null,
        port: it.port ?? null,
        fields: it.fields ?? {},
        raw: it.raw ?? null,
      });
    }
  };
  const status = (): DogdLanStatus => {
    advance();
    const t = elapsed();
    const end = STEP_ENDS.filter(([m]) => methods.includes(m)).at(-1)?.[1] ?? 0;
    const running = started !== null && stoppedAt === null && t < end;
    const step = running ? (STEP_ENDS.find(([m, e]) => methods.includes(m) && t < e)?.[0] ?? null) : null;
    const checks = 4 * 6;
    return {
      supported: true,
      state: started === null ? 'idle' : stoppedAt !== null ? 'cancelled' : running ? 'scanning' : 'done',
      detail: started === null ? 'demo network (simulated)' : running ? `${IFACE.name} ${IFACE.network} (simulated)` : `simulated scan: ${new Set(emitted.map((e) => e.ip)).size} host(s) · no answer excludes nothing`,
      scan,
      iface: started === null ? null : IFACE.name,
      methods,
      step,
      done: step === 'services' || (!running && started !== null) ? Math.min(checks, Math.round(((t - 3000) / 800) * checks)) : 0,
      total: methods.includes('services') && t >= 3000 ? checks : null,
      started_wall_ms: null,
      finished_wall_ms: null,
      oui_source: OUI,
    };
  };

  return {
    async interfaces() {
      return { supported: true, interfaces: [IFACE, GUEST] };
    },
    async status() {
      return status();
    },
    async scan(req) {
      if (req.action === 'stop') {
        if (started !== null && stoppedAt === null && status().state === 'scanning') stoppedAt = now();
        return status();
      }
      if (started !== null && status().state === 'scanning') throw new Error('a scan is already running: stop it first');
      if (req.iface !== IFACE.name) throw new Error(`${req.iface}: no usable private IPv4 network on this interface`);
      scan++;
      started = now();
      stoppedAt = null;
      methods = req.methods;
      cursor = 0;
      return status();
    },
    async observations(since) {
      advance();
      const after = emitted.filter((o) => o.seq > since);
      return { next: after.at(-1)?.seq ?? Math.min(since, seq), lost: 0, observations: after };
    },
  };
}
