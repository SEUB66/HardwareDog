import { amps, clock, volts, watts } from '../../core/format';
import type { System } from '../../core/system';
import { uncertainty } from '../../core/calibration';
import { Empty } from '../components/Empty';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import { SignalChart, type ChartMarker } from '../components/SignalChart';
import { Hint } from '../components/Hint';
import { Tag } from '../components/Tag';
import { explain } from '../../core/glossary';

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

  const m = system.meter;
  // What the reading is worth, next to it: +- the expected error.
  const pmV = (v: number | null) => (m && v !== null ? `± ${(uncertainty(v, m.v_err) * 1000).toFixed(1)} mV` : undefined);
  const pmI = (i: number | null) => (m && i !== null ? `± ${(uncertainty(i, m.i_err) * 1000).toFixed(2)} mA` : undefined);

  const metric = (label: string, value: string, live = true, pm?: string) => (
    <div class="metric">
      <div class="label">
        <Hint text={explain(label, 'POWER')}>{label}</Hint>
      </div>
      <div class={`value${live ? '' : ' static'}`}>{value}</div>
      {pm && <div class="pm">{pm}</div>}
    </div>
  );

  return (
    <>
      <h1 class="screen-title">
        POWER MONITOR <span class="sub">target supply rail</span>
      </h1>
      <div class="metrics" style={{ marginBottom: 12 }}>
        {metric('VOLTAGE', volts(p.voltage, 3), true, pmV(p.voltage))}
        {metric('CURRENT', amps(p.current), true, pmI(p.current))}
        {metric('POWER', p.voltage !== null && p.current !== null ? watts(p.voltage * p.current) : '--')}
        {metric('PEAK CURRENT', amps(p.peakCurrent), false)}
        {metric('MIN VOLTAGE', volts(p.minVoltage, 3), false)}
        {metric('AVG VOLTAGE', volts(avgV, 3), false)}
        <div class="metric">
          <div class="label">
            <Hint text={explain('STATE', 'POWER')}>STATE</Hint>
          </div>
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

      <Panel title="MEASUREMENT" scope="METER" aside={m ? m.basis : 'NOT DECLARED'}>
        {m ? (
          <KV
            rows={[
              ['SENSOR', `${m.sensor}, shunt ${m.shunt_ohm} ohm`],
              ['RANGE', `0-${m.v_max} V / ±${m.i_max} A`],
              ['RESOLUTION', `${(m.v_res * 1000).toFixed(2)} mV / ${(m.i_res * 1e6).toFixed(1)} µA`],
              ['RATE', `${m.rate_hz} samples/s`],
              ['VOLTAGE ERROR', `±${m.v_err.pct}% + ${(m.v_err.abs * 1000).toFixed(1)} mV`],
              ['CURRENT ERROR', `±${m.i_err.pct}% + ${(m.i_err.abs * 1000).toFixed(2)} mA`],
              ['BASIS', m.cal ? `CALIBRATED ${m.cal.date} / ${m.cal.ref}` : 'DATASHEET, NOT CALIBRATED'],
              ...(system.calPoints.length ? ([['CAL POINTS', `${system.calPoints.length} waiting`]] as [string, string][]) : []),
            ]}
          />
        ) : (
          <p class="note warn">This device has not declared what its numbers are worth: accuracy unknown.</p>
        )}
        <p class="note">DIAGNOSTIC MEASUREMENT, NOT CERTIFIED METROLOGY</p>
      </Panel>

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
