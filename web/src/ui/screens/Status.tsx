import { clock, duration, hex, milliamps, ms, volts } from '../../core/format';
import type { System } from '../../core/system';
import { Empty } from '../components/Empty';
import { ErrorBlock } from '../components/ErrorBlock';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';
import { useClock } from '../hooks';

/** What is happening right now? (spec 12) */
export function Status({ system }: { system: System }) {
  const now = useClock(system);
  const { device, power, usb, net, serial, bus } = system;
  const recent = system.trace.all().slice(-8).reverse();
  const powerTag =
    power.condition === 'STABLE' ? <Tag status="PASS" label="STABLE" /> : power.condition === 'NO SIGNAL' ? <Tag status="UNKNOWN" label="NO SIGNAL" /> : <Tag status="WARN" label={power.condition} />;

  return (
    <>
      <h1 class="screen-title">
        STATUS <span class="sub">what is happening right now</span>
      </h1>
      {system.lastError && system.link !== 'ONLINE' && <ErrorBlock error={system.lastError} />}
      <div class="grid even">
        <Panel title="DEVICE">
          <KV
            rows={[
              ['ID', device.id],
              ['REV', device.rev],
              ['FIRMWARE', device.firmware],
              ['UPTIME', device.bootedAt === null ? '--' : duration(now - device.bootedAt)],
              [
                'STATE',
                system.replayOf ? (
                  <Tag status="UNKNOWN" label={system.link === 'LOST' ? 'RECORDED, LINK LOST' : 'RECORDED'} />
                ) : (
                  <Tag status={system.link === 'ONLINE' ? 'PASS' : system.link === 'LOST' ? 'FAIL' : 'UNKNOWN'} label={system.link} />
                ),
              ],
            ]}
          />
        </Panel>

        <Panel title="POWER">
          <KV
            rows={[
              ['VOLTAGE', volts(power.voltage), true],
              ['CURRENT', milliamps(power.current), true],
              ['PEAK', milliamps(power.peakCurrent)],
              ['MIN V', volts(power.minVoltage)],
              ['STATE', powerTag],
            ]}
          />
        </Panel>

        <Panel title="USB">
          <KV
            rows={[
              ['DEVICE', <Tag status={usb.connected ? 'PASS' : usb.connections ? 'WARN' : 'UNKNOWN'} label={usb.connected ? 'CONNECTED' : 'DISCONNECTED'} />],
              ['SPEED', usb.descriptor ? `${usb.descriptor.speed} SPEED` : '--'],
              ['VID', hex(usb.descriptor?.vid ?? null)],
              ['PID', hex(usb.descriptor?.pid ?? null)],
              ['DISCONNECTS', String(usb.disconnects)],
            ]}
          />
        </Panel>

        <Panel title="NETWORK">
          <KV
            rows={[
              ['LINK', net.link ? <Tag status={net.link.up ? 'PASS' : 'FAIL'} label={net.link.up ? 'UP' : 'DOWN'} /> : <Tag status="UNKNOWN" />],
              ['DHCP', <Tag status={net.dhcp} />],
              ['DNS', <Tag status={net.dns.status} />],
              ['LATENCY', ms(net.latencyMs), true],
            ]}
          />
        </Panel>

        <Panel title="SERIAL">
          <KV
            rows={[
              ['PORT', serial.active ? serial.port : '--'],
              ['CONFIG', serial.active ? `${serial.baud} ${serial.dataBits}${serial.parity[0]}${serial.stopBits}` : '--'],
              ['RX LINES', String(serial.lines.filter((l) => l.dir === 'RX').length)],
              ['ERRORS', serial.errors ? <Tag status="WARN" label={String(serial.errors)} /> : '0'],
            ]}
          />
        </Panel>

        <Panel title="LOCAL">
          <KV
            rows={[
              ['MODE', 'LOCAL'],
              ['CLOUD', 'DISABLED'],
              ['DEVICE DATA', 'LOCAL ONLY'],
              [
                'SOURCE',
                system.replayOf ? (
                  <Tag status={system.replayOf.source === 'SIMULATOR' ? 'WARN' : 'INFO'} label={`REPLAY OF ${system.replayOf.source}`} />
                ) : system.transportKind === 'SIMULATOR' ? (
                  <Tag status="WARN" label="SIMULATOR" />
                ) : (
                  (system.transportKind ?? 'NONE')
                ),
              ],
              ['ENDPOINT', system.transportLabel || '--'],
              ['I2C', bus.lastScanAt ? `${bus.devices.length} device(s)` : 'not scanned'],
            ]}
          />
        </Panel>
      </div>

      <Panel title="DIAGNOSIS" aside={system.diagnoses.length ? `${system.diagnoses.length} active / F4 report` : 'deterministic rules'}>
        {system.diagnoses.length === 0 ? (
          <Empty title="NO FINDINGS" hint="No diagnostic rule matches the evidence so far." />
        ) : (
          <div class="diagnoses">
            {system.diagnoses.map((d) => (
              <div class="diagnosis" key={d.id}>
                <div class="diagnosis-head">
                  <Tag status="WARN" label={d.title} />
                  <span class="dim">CONFIDENCE</span> <span>{d.confidence}</span>
                  <span class="dim">{`  ${d.basis}`}</span>
                </div>
                <div>{d.cause}</div>
                <div class="dim">NEXT CHECK: {d.next}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="LATEST EVENTS" aside="F2 full trace">
        {recent.length === 0 ? (
          <Empty title="NO EVENTS RECORDED" hint="Start a trace or connect a device." />
        ) : (
          <div class="trace" style={{ border: 0 }}>
            <table>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id} class={`${e.severity} src-${e.source}`}>
                    <td class="time">{clock(e.t)}</td>
                    <td class="src">{e.source}</td>
                    <td class="col-sev">
                      <Tag status={e.severity} />
                    </td>
                    <td class="msg">
                      {e.message}
                      {e.value ? <span class="val">{e.value}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
