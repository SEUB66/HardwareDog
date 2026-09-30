import { amps, clock, volts, watts } from '../../core/format';
import type { System } from '../../core/system';
import { Empty } from '../components/Empty';
import { SignalChart, type ChartMarker } from '../components/SignalChart';
import { Tag } from '../components/Tag';

const WINDOW = 15_000;

/** Test-equipment view of the target supply (spec 15). */
export function Power({ system }: { system: System }) {
  const p = system.power;
  const s = system.settings;
  const end = p.samples.at(-1)?.t ?? Date.now();
  // Priority decides which labels survive when events crowd one spot.
  const markers: ChartMarker[] = [];
  for (const e of system.trace.all()) {
    if (e.t < end - WINDOW) continue;
    if (e.source === 'POWER' && e.message === 'voltage drop') markers.push({ t: e.t, label: 'POWER DROP', short: 'DROP', priority: 4 });
    else if (e.source === 'USB' && e.message === 'device disconnected') markers.push({ t: e.t, label: 'USB LOST', short: 'LOST', priority: 3 });
    else if (e.source === 'USB' && e.message === 'device connected') markers.push({ t: e.t, label: 'USB UP', short: 'UP', priority: 1 });
  }
  const avgV = p.sampleCount ? p.voltageSum / p.sampleCount : null;

  const metric = (label: string, value: string, live = true) => (
    <div class="metric">
      <div class="label">{label}</div>
      <div class={`value${live ? '' : ' static'}`}>{value}</div>
    </div>
  );

  return (
    <>
      <h1 class="screen-title">
        POWER MONITOR <span class="sub">target supply rail</span>
      </h1>
      <div class="metrics" style={{ marginBottom: 12 }}>
        {metric('VOLTAGE', volts(p.voltage, 3))}
        {metric('CURRENT', amps(p.current))}
        {metric('POWER', p.voltage !== null && p.current !== null ? watts(p.voltage * p.current) : '--')}
        {metric('PEAK CURRENT', amps(p.peakCurrent), false)}
        {metric('MIN VOLTAGE', volts(p.minVoltage, 3), false)}
        {metric('AVG VOLTAGE', volts(avgV, 3), false)}
        <div class="metric">
          <div class="label">STATE</div>
          <div class="value">
            {p.condition === 'STABLE' ? (
              <Tag status="PASS" label="STABLE" />
            ) : p.condition === 'NO SIGNAL' ? (
              <Tag status="UNKNOWN" label="NO SIGNAL" />
            ) : (
              <Tag status="WARN" label={p.condition} />
            )}
          </div>
        </div>
        {metric('DROPS', String(p.dropCount), false)}
      </div>

      {p.samples.length === 0 ? (
        <Empty title="NO SIGNAL" hint="Waiting for power samples from the device." />
      ) : (
        <div class="stack">
          <SignalChart
            title="VOLTAGE"
            unit="V"
            samples={p.samples}
            pick={(x) => x.voltage}
            format={(v) => volts(v, 3)}
            domain={[4.5, 5.2]}
            step={0.1}
            tickLabel={(v) => v.toFixed(2)}
            threshold={{
              value: s.undervoltageThreshold,
              label: `UNDERVOLTAGE ${s.undervoltageThreshold.toFixed(2)} V`,
              short: `${s.undervoltageThreshold.toFixed(2)} V`,
            }}
            markers={markers}
            end={end}
            windowMs={WINDOW}
          />
          <SignalChart
            title="CURRENT"
            unit="mA"
            samples={p.samples}
            pick={(x) => x.current}
            format={(v) => `${Math.round(v * 1000)} mA`}
            domain={[0, 1]}
            step={0.2}
            tickLabel={(v) => String(Math.round(v * 1000))}
            threshold={{
              value: s.overcurrentThreshold,
              label: `LIMIT ${Math.round(s.overcurrentThreshold * 1000)} mA`,
              short: `${Math.round(s.overcurrentThreshold * 1000)} mA`,
            }}
            markers={markers}
            end={end}
            windowMs={WINDOW}
            height={150}
          />
          {p.lastDropAt !== null && (
            <p class="note warn">
              LAST DROP {clock(p.lastDropAt)} / MIN {volts(p.lastDropVoltage, 3)}
            </p>
          )}
        </div>
      )}
    </>
  );
}
