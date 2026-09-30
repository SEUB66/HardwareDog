import { clock, hex, milliamps, volts } from '../../core/format';
import type { System } from '../../core/system';
import type { Source } from '../../core/types';
import { Empty } from '../components/Empty';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';

interface UsbProps {
  system: System;
  onTrace: (sources: Source[]) => void;
  onExport: () => void;
}

export function Usb({ system, onTrace, onExport }: UsbProps) {
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
        USB DEVICE <span class="sub">downstream port</span>
      </h1>
      {!u.connected && u.disconnects > 0 && u.lastDetachAt !== null && (
        <Panel title="USB DEVICE LOST" tone="fault">
          <KV
            rows={[
              ['LAST SEEN', clock(u.lastDetachAt)],
              ['PREVIOUS EVENT', previous ? `${previous.message.toUpperCase()} / ${previous.value ?? ''}` : 'none within 1 s'],
              ['DISCONNECTS', String(u.disconnects)],
              ['CORRELATED', `${u.correlatedDisconnects} of ${u.disconnects} with a voltage drop`],
            ]}
          />
        </Panel>
      )}
      {!d ? (
        <Empty title="NO SIGNAL" hint="Waiting for a USB device on the downstream port." />
      ) : (
        <div class="grid wide">
          <Panel title="DEVICE">
            <KV
              rows={[
                ['STATE', <Tag status={u.connected ? 'PASS' : 'WARN'} label={u.connected ? 'CONNECTED' : 'DISCONNECTED'} />],
                ['SPEED', `${d.speed} SPEED`],
                ['VID', hex(d.vid)],
                ['PID', hex(d.pid)],
                ['CLASS', d.deviceClass],
                ['POWER', d.powerSource],
                ['CURRENT', milliamps(system.power.current), true],
                ['VBUS', volts(system.power.voltage), true],
              ]}
            />
          </Panel>
          <Panel title="DESCRIPTORS" aside={u.lastSeenAt ? `read ${clock(u.lastSeenAt)}` : undefined}>
            <KV
              rows={[
                ['MANUFACTURER', d.manufacturer ?? '--'],
                ['PRODUCT', d.product ?? '--'],
                ['SERIAL', d.serial ?? '--'],
              ]}
            />
          </Panel>
          <Panel title="SESSION">
            <KV
              rows={[
                ['CONNECTIONS', String(u.connections)],
                ['DISCONNECTS', String(u.disconnects)],
                ['CORRELATED', String(u.correlatedDisconnects)],
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
