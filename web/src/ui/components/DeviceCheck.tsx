/**
 * HARDWARE DOG / WHAT WORKS ON THIS DEVICE, ON SCREEN
 *
 * The browser, the system, the kind of device, and for each tool: works
 * here, partly, or not, with what to use instead (core/device.ts). Checked
 * in this browser when shown; nothing is sent anywhere.
 */

import { useEffect, useState } from 'preact/hooks';
import { storagePersisted } from '../../core/archive';
import { dogdHealth } from '../../core/dogd';
import { deviceCapabilities, deviceInfo, readFunctions, type DeviceCapability, type DeviceFunctions, type Support } from '../../core/device';
import { Pwa, pwa } from '../../core/pwa';
import { useRev } from '../lab/useRev';
import { Tag } from './Tag';

const TAG: Record<Support, { status: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'; label: string }> = {
  YES: { status: 'PASS', label: 'YES' },
  PARTIAL: { status: 'WARN', label: 'PARTLY' },
  NO: { status: 'FAIL', label: 'NO' },
  CHECKING: { status: 'UNKNOWN', label: '…' },
};

/** The checks, with dogd asked here unless the page already knows. */
export function useDeviceCheck(dogd?: DeviceFunctions['dogd']) {
  useRev(pwa);
  const [own, setOwn] = useState<DeviceFunctions['dogd']>('checking');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    void storagePersisted().then(setPersisted, () => setPersisted(null));
    if (dogd !== undefined) return;
    dogdHealth().then(
      () => setOwn('running'),
      () => setOwn('absent'),
    );
  }, []);
  const info = deviceInfo(navigator, Pwa.standalone());
  const caps = deviceCapabilities(info, readFunctions(dogd ?? own, persisted, pwa.install === 'available'));
  return { info, caps, working: caps.filter((c) => c.state === 'YES').length };
}

export function DeviceTable({ caps }: { caps: DeviceCapability[] }) {
  return (
    <table class="trace device-table">
      <thead>
        <tr>
          <th scope="col">TOOL</th>
          <th scope="col">HERE</th>
          <th scope="col">WHY · INSTEAD</th>
        </tr>
      </thead>
      <tbody>
        {caps.map((c) => (
          <tr key={c.id}>
            <td>{c.tool}</td>
            <td>
              <Tag status={TAG[c.state].status} label={TAG[c.state].label} />
            </td>
            <td>
              {c.detail}
              {c.instead && (
                <>
                  <br />
                  <span class="dim">instead: {c.instead}</span>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One line naming the device, for a heading or a summary. */
export const deviceLine = (i: ReturnType<typeof deviceInfo>) => `${i.browser} on ${i.os} (${i.form}${i.installed ? ', installed' : ''})`;
