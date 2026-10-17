/**
 * HARDWARE DOG / THE LAB
 *
 * Everything the lab tools share, created once for the whole interface:
 * one bus, one companion, one command registry, one Flipper session, one
 * Bluetooth scanner, one lab session recorder. Screens, the floating TV
 * and a detached window all receive this object; none creates its own.
 */

import { BleService } from '../ble/service';
import { FlipperLibrary, type LibraryItem } from '../flipper/library';
import { FlipperService } from '../flipper/service';
import { Companion } from './companion';
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
}

export async function createLab(app: string, reducedMotion: () => boolean): Promise<Lab> {
  const bus = new LabBus();
  const companion = new Companion(bus, { lang: browserLang(), reducedMotion });
  const registry = new CommandRegistry();
  const library = new FlipperLibrary(await openLabStore<LibraryItem>('library'));
  const flipper = new FlipperService(bus, library);
  const ble = new BleService(bus);
  const sessions = new LabSessions(bus, await openLabStore<StoredLabSession>('sessions'), app);
  void sessions.refresh().catch(() => {});
  return { bus, companion, registry, flipper, ble, sessions };
}
