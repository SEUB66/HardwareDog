/**
 * HARDWARE DOG / THE LAB
 *
 * Everything the lab tools share, created once for the whole interface:
 * one bus, one companion, one command registry, one Flipper session, one
 * Bluetooth scanner, one Camera Sniffer, one lab session recorder, and the
 * bridge that puts the Hardware Dog session on the bus. Screens, the TV
 * (docked, floating or detached) all receive this object; none creates
 * its own.
 */

import { BleService } from '../ble/service';
import { demoLanApi } from '../camera/demo';
import { Inspections, type Inspection, type PhotoRecord } from '../camera/inspection';
import { CameraNet } from '../camera/net';
import { FlipperLibrary, type LibraryEntry } from '../flipper/library';
import { FlipperService } from '../flipper/service';
import { Companion } from './companion';
import { DeviceBridge } from './device';
import { LabBus } from './events';
import { LabSessions, type StoredLabSession } from './manager';
import { CommandRegistry } from './registry';
import { browserLang } from './rules';
import { openLabStore } from './store';

export interface Lab {
  bus: LabBus;
  companion: Companion;
  registry: CommandRegistry;
  flipper: FlipperService;
  ble: BleService;
  sessions: LabSessions;
  /** Camera Sniffer: network discovery (through dogd) and the guided inspection. */
  camera: { net: CameraNet; inspections: Inspections };
  /** The Hardware Dog session's link and operations, said on the bus. */
  device: DeviceBridge;
}

export async function createLab(app: string, reducedMotion: () => boolean): Promise<Lab> {
  const bus = new LabBus();
  // The interface opens on STATUS: the dog, following the session's own link, until a section says otherwise.
  const companion = new Companion(bus, { lang: browserLang(), reducedMotion, watch: 'DEVICE', profile: 'hwdog' });
  const registry = new CommandRegistry();
  const library = new FlipperLibrary(await openLabStore<LibraryEntry>('library'), await openLabStore<Uint8Array>('library-data'));
  const flipper = new FlipperService(bus, library);
  const ble = new BleService(bus);
  const sessions = new LabSessions(bus, await openLabStore<StoredLabSession>('sessions'), app);
  void sessions.refresh().catch(() => {});
  const camera = { net: new CameraNet(bus, () => demoLanApi()), inspections: new Inspections(bus, await openLabStore<Inspection>('camera'), await openLabStore<PhotoRecord>('photos')) };
  void camera.inspections.restore();
  return { bus, companion, registry, flipper, ble, sessions, camera, device: new DeviceBridge(bus) };
}
