/**
 * The operation log: every lab event the bus still holds, newest first,
 * with its exact code. The TV may forget a message; this does not.
 */

import { useEffect, useState } from 'preact/hooks';
import type { Lab } from '../../core/lab/context';
import type { LabEvent, LabSource } from '../../core/lab/events';
import { Panel } from '../components/Panel';

const time = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

export function EventRow({ e, start, selected, onClick }: { e: LabEvent; start?: number; selected?: boolean; onClick?: () => void }) {
  return (
    <tr class={`sev-${e.severity}${selected ? ' selected' : ''}`} onClick={onClick}>
      <td class="num">#{e.seq}</td>
      <td class="mono">{start !== undefined ? `+${((e.mono - start) / 1000).toFixed(3)} s` : time(e.at)}</td>
      <td>{e.source}</td>
      <td>{e.type}</td>
      <td>{e.severity}</td>
      <td>
        {e.message}
        {e.progress ? ` · ${e.progress.done}${e.progress.total !== null ? `/${e.progress.total}` : ''} ${e.progress.unit}` : ''}
        {e.origin !== 'PHYSICAL' && <span class="dim"> · {e.origin === 'SIMULATED' ? 'DEMO' : 'REPLAY'}</span>}
      </td>
      <td class="mono">{e.code ?? ''}</td>
    </tr>
  );
}

export function LabLog({ lab, only }: { lab: Lab; only?: LabSource }) {
  const [, setTick] = useState(0);
  const [hideObs, setHideObs] = useState(true);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return lab.bus.subscribe(() => {
      t ??= setTimeout(() => {
        t = null;
        setTick((n) => n + 1);
      }, 300);
    });
  }, [lab]);
  const events = lab.bus
    .recent((e) => (!only || e.source === only || e.source === 'USER') && (!hideObs || e.type !== 'observe'))
    .slice(-400)
    .reverse();
  return (
    <Panel title="OPERATION LOG" info="Every lab operation and link change the interface still holds (the latest few thousand), newest first, with the code exactly as the device or the browser gave it.">
      <div class="actions">
        <label class="check">
          <input type="checkbox" checked={hideObs} onChange={(e) => setHideObs((e.target as HTMLInputElement).checked)} />
          hide observations
        </label>
        <span class="dim">
          {lab.bus.size} held{lab.bus.dropped ? ` · ${lab.bus.dropped} older ones no longer held here (a recording keeps them)` : ''}
        </span>
      </div>
      <table class="trace lab-log">
        <thead>
          <tr>
            <th>#</th>
            <th>TIME</th>
            <th>SOURCE</th>
            <th>TYPE</th>
            <th>LEVEL</th>
            <th>MESSAGE</th>
            <th>CODE</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr>
              <td colSpan={7} class="dim">
                Nothing yet.
              </td>
            </tr>
          )}
          {events.map((e) => (
            <EventRow key={e.seq} e={e} />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
