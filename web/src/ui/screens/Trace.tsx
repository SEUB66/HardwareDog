import { useEffect, useRef, useState } from 'preact/hooks';
import { clock } from '../../core/format';
import type { System } from '../../core/system';
import type { Source } from '../../core/types';
import { SOURCES } from '../../core/types';
import { Empty } from '../components/Empty';
import { Tag } from '../components/Tag';

const MAX_ROWS = 800;

/** One chronological timeline for every source (spec 13, 14). */
export function Trace({ system, only }: { system: System; only?: Source[] | null }) {
  const [hidden, setHidden] = useState<Set<Source>>(() => new Set(only ? SOURCES.filter((s) => !only.includes(s)) : []));
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const lastSeen = useRef(0);

  const all = system.trace.visible();
  const events = all.filter((e) => !hidden.has(e.source)).slice(-MAX_ROWS);
  const newest = events.at(-1)?.id ?? 0;
  const freshFrom = lastSeen.current;

  useEffect(() => {
    lastSeen.current = newest;
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });

  const toggle = (s: Source) => {
    const next = new Set(hidden);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setHidden(next);
  };

  const onScroll = () => {
    const el = box.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  return (
    <>
      <h1 class="screen-title">
        TRACE <span class="sub">every source, one clock</span>
      </h1>
      <div class="trace-controls" role="group" aria-label="Trace sources">
        {SOURCES.map((s) => (
          <label class="check" key={s}>
            <input type="checkbox" checked={!hidden.has(s)} onChange={() => toggle(s)} />
            <span class="box">[{hidden.has(s) ? ' ' : 'X'}]</span>
            {s}
          </label>
        ))}
        <span class="trace-state">
          {system.trace.paused ? (
            <Tag status="WARN" label={`PAUSED / ${system.trace.buffered} BUFFERED`} />
          ) : (
            <Tag status="LIVE" label="LIVE" />
          )}
          <span class="dim">{`  ${system.trace.size} EVENTS`}</span>
        </span>
      </div>
      <div class="actions" style={{ marginTop: 0, marginBottom: 8 }}>
        <button class={`btn ${system.trace.paused ? 'active' : ''}`} onClick={() => system.toggleTrace()}>
          {system.trace.paused ? 'RESUME' : 'PAUSE'} <span class="dim">SPACE</span>
        </button>
        <button class="btn" onClick={() => system.clearTrace()}>
          CLEAR <span class="dim">CTRL+L</span>
        </button>
      </div>
      {events.length === 0 ? (
        <Empty title="NO EVENTS RECORDED" hint="Start a trace or connect a device." />
      ) : (
        <div class="trace" ref={box} onScroll={onScroll} style={{ maxHeight: 'calc(100vh - 230px)', minHeight: 240 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">TIME</th>
                <th scope="col">SOURCE</th>
                <th scope="col" class="col-sev">LEVEL</th>
                <th scope="col">MESSAGE</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} class={`${e.severity} src-${e.source}${e.id > freshFrom && freshFrom > 0 ? ' fresh' : ''}`}>
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
      {all.length > MAX_ROWS && <p class="note">Showing the latest {MAX_ROWS} events. Full timeline is kept and included in exports.</p>}
    </>
  );
}
