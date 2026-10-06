import { useEffect, useState } from 'preact/hooks';
import { HOST_DEVICE, dogdUsb, type HostUsbDevice } from '../../core/dogd';
import { clock, hex, milliamps, volts } from '../../core/format';
import type { System } from '../../core/system';
import type { Source } from '../../core/types';
import { Empty } from '../components/Empty';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';

interface UsbProps {
  system: System;
  /** dogd's address when the source is dogd: its computer's USB list comes from there. */
  dogdBase: string | null;
  onTrace: (sources: Source[]) => void;
  onExport: () => void;
}

/** VID:PID, hex. */
const usbId = (vid: number, pid: number) => `${hex(vid)}:${hex(pid)}`;

const usbName = (d: HostUsbDevice) =>
  d.product ? (d.manufacturer && !d.product.startsWith(d.manufacturer) ? `${d.manufacturer} ${d.product}` : d.product) : (d.manufacturer ?? usbId(d.vid, d.pid));

/**
 * This computer's USB devices (dogd --source host): every one is on the
 * timeline; the one followed is the target the USB rules judge.
 */
function HostUsb({ system, base }: { system: System; base: string }) {
  const [list, setList] = useState<{ supported: boolean; devices: HostUsbDevice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const read = () =>
      dogdUsb(base).then(
        (l) => !stop && (setList(l), setError(null)),
        (e: unknown) => !stop && setError(e instanceof Error ? e.message : String(e)),
      );
    void read();
    const timer = setInterval(read, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [base]);
  const f = system.usbFollow;
  const followed = (d: HostUsbDevice) => f !== null && f.vid === d.vid && f.pid === d.pid && (f.serial === null || f.serial === d.serial);
  const devices = (list?.devices ?? []).filter((d) => d.cls !== 'HUB');
  return (
    <Panel
      title="USB ON THIS COMPUTER"
      scope="USB"
      aside={list ? `${devices.length} device(s)` : undefined}
      info="Read from the system, nothing opened. Every device plugged in or out is on the timeline. FOLLOW one: it becomes the target, and its disconnects go to the USB rules."
    >
      {error && <p class="note warn">{error}</p>}
      {list && !list.supported && <p class="note warn">This system's USB list is not read yet (Linux for now).</p>}
      {f && list?.supported && !devices.some(followed) && (
        <p class="note warn follow-gone">
          FOLLOWING {usbId(f.vid, f.pid)}
          {f.serial ? ` serial ${f.serial}` : ''}: not plugged in now.{' '}
          <button class="btn" onClick={() => system.followUsb(null)}>
            STOP
          </button>
        </p>
      )}
      {list?.supported && devices.length === 0 && <p class="note">No USB device plugged in (hubs aside). Plug one in: it shows here and on the timeline.</p>}
      {devices.length > 0 && (
        <table class="trace usb-list">
          <thead>
            <tr>
              <th>DEVICE</th>
              <th>ID</th>
              <th>CLASS</th>
              <th>SPEED</th>
              <th>PORT</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={`${d.port}-${d.vid}-${d.pid}`} class={followed(d) ? 'followed' : undefined}>
                <td>{usbName(d)}</td>
                <td>{usbId(d.vid, d.pid)}</td>
                <td>{d.cls}</td>
                <td>{d.speed ?? '--'}</td>
                <td>{d.port}</td>
                <td>
                  {followed(d) ? (
                    <button class="btn" onClick={() => system.followUsb(null)}>
                      STOP
                    </button>
                  ) : (
                    <button class="btn primary" onClick={() => system.followUsb({ vid: d.vid, pid: d.pid, serial: d.serial, port: d.serial ? null : d.port })}>
                      FOLLOW
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function Usb({ system, dogdBase, onTrace, onExport }: UsbProps) {
  const host = dogdBase !== null && system.device.id === HOST_DEVICE && system.observes('usb');
  // A computer's own USB comes without a supply measurement: never imply one.
  const supply = system.observes('power');
  const u = system.usb;
  const d = u.descriptor;
  // Spec 36: when the device is gone, say what Hardware Dog knows.
  const previous =
    u.lastDetachAt !== null
      ? system.trace.lastBefore(u.lastDetachAt, (e) => e.source === 'POWER' && e.severity === 'WARN' && u.lastDetachAt! - e.t < 1000)
      : null;

  return (
    <>
      <h1 class="screen-title">
        USB DEVICE <span class="sub">{host ? 'the USB devices of this computer, one followed' : 'the one port Hardware Dog watches, one target device'}</span>
      </h1>
      {host && <HostUsb system={system} base={dogdBase} />}
      {!u.connected && u.disconnects > 0 && u.lastDetachAt !== null && (
        <Panel title="USB DEVICE LOST" tone="fault" scope="USB">
          <KV
            rows={[
              ['LAST SEEN', clock(u.lastDetachAt)],
              ['PREVIOUS EVENT', previous ? `${previous.message.toUpperCase()} / ${previous.value ?? ''}` : 'none within 1 s'],
              ['DISCONNECTS', String(u.disconnects)],
              ['CORRELATED', supply ? `${u.correlatedDisconnects} of ${u.disconnects} with a voltage drop` : 'supply not observed: neither shown nor ruled out'],
            ]}
          />
        </Panel>
      )}
      {!d ? (
        <Empty
          title={host ? (system.usbFollow ? 'NOT PLUGGED IN' : 'NO DEVICE FOLLOWED') : 'NO SIGNAL'}
          hint={host ? (system.usbFollow ? 'The followed device is not plugged in: plug it in.' : 'FOLLOW a device above to watch it as the target.') : 'Waiting for a USB device on the downstream port.'}
        />
      ) : (
        <div class="grid wide">
          <Panel title="DEVICE" scope="USB" info="The USB device under test: what it says it is, and what it draws.">
            <KV
              rows={[
                ['STATE', <Tag status={u.connected ? 'PASS' : 'WARN'} label={u.connected ? 'CONNECTED' : 'DISCONNECTED'} />],
                ['SPEED', `${d.speed} SPEED`],
                ['VID', hex(d.vid)],
                ['PID', hex(d.pid)],
                ['CLASS', d.deviceClass],
                ['POWER', d.powerSource],
                ...((supply
                  ? [
                      ['CURRENT', milliamps(system.power.current), true],
                      ['VBUS', volts(system.power.voltage), true],
                    ]
                  : [['SUPPLY', 'not observed (a computer does not measure it)']]) as [string, string, boolean?][]),
              ]}
            />
          </Panel>
          <Panel title="DESCRIPTORS" scope="USB" aside={u.lastSeenAt ? `read ${clock(u.lastSeenAt)}` : undefined}>
            <KV
              rows={[
                ['MANUFACTURER', d.manufacturer ?? '--'],
                ['PRODUCT', d.product ?? '--'],
                ['SERIAL', d.serial ?? '--'],
              ]}
            />
          </Panel>
          <Panel title="SESSION" scope="USB">
            <KV
              rows={[
                ['CONNECTIONS', String(u.connections)],
                ['DISCONNECTS', String(u.disconnects)],
                ['CORRELATED', supply ? String(u.correlatedDisconnects) : '--'],
              ]}
            />
          </Panel>
        </div>
      )}
      <div class="actions">
        <button class="btn primary" onClick={() => system.enumerateUsb()} disabled={!system.online}>
          ENUMERATE
        </button>
        <button class="btn" onClick={() => onTrace(['USB', 'POWER', 'RULE'])}>
          WATCH
        </button>
        <button class="btn" onClick={() => onTrace(['USB'])}>
          TRACE EVENTS
        </button>
        <button class="btn" onClick={onExport} disabled={!d}>
          EXPORT DESCRIPTORS
        </button>
      </div>
      <p class="note">
        ENUMERATE is active: the device re-reads descriptors from the target. WATCH opens the trace with USB, POWER and RULE
        events on one clock.
      </p>
    </>
  );
}
