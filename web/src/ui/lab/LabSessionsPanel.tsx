/**
 * Lab sessions: record, name, mark, stop; the sessions kept here; reopen
 * one read-only, filter its timeline, compare before / after a marker or
 * two sessions, export the file, export the report.
 */

import { useMemo, useState } from 'preact/hooks';
import type { Lab } from '../../core/lab/context';
import { LAB_SOURCES, type LabEvent, type LabSource } from '../../core/lab/events';
import { compare, labReport, near, parseHdlab, splitAt, toHdlab, type LabSessionData } from '../../core/lab/session';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';
import { download } from './FlipperLab';
import { EventRow } from './LabLog';
import { useRev } from './useRev';

const integrityTag = (i: LabSessionData['integrity']) => <Tag status={i === 'VERIFIED' ? 'PASS' : i === 'MODIFIED' ? 'FAIL' : 'WARN'} label={i} />;

function Timeline({ data, onCompareAt }: { data: LabSessionData; onCompareAt: (seq: number) => void }) {
  const [sources, setSources] = useState<LabSource[]>([...LAB_SOURCES]);
  const [text, setText] = useState('');
  const [failOnly, setFailOnly] = useState(false);
  const [focus, setFocus] = useState<LabEvent | null>(null);
  const shown = useMemo(
    () =>
      data.events.filter((e) => sources.includes(e.source) && (!failOnly || e.severity === 'FAIL' || e.severity === 'WARN') && (!text || `${e.message} ${e.code ?? ''} ${e.device ?? ''}`.toLowerCase().includes(text.toLowerCase()))),
    [data, sources, text, failOnly],
  );
  const close = focus ? near(data.events, focus, 2000) : [];
  return (
    <>
      <div class="actions">
        {LAB_SOURCES.map((s) => (
          <label class="check" key={s}>
            <input type="checkbox" checked={sources.includes(s)} onChange={() => setSources(sources.includes(s) ? sources.filter((x) => x !== s) : [...sources, s])} />
            {s}
          </label>
        ))}
        <label class="check">
          <input type="checkbox" checked={failOnly} onChange={(e) => setFailOnly((e.target as HTMLInputElement).checked)} />
          warnings and failures
        </label>
        <input class="input" placeholder="filter text" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} aria-label="Filter the timeline" />
        <span class="dim">
          {shown.length} of {data.events.length}
        </span>
      </div>
      <div class="timeline-scroll">
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
            {shown.slice(0, 2000).map((e) => (
              <EventRow key={e.seq} e={e} start={data.header.startMono} selected={focus?.seq === e.seq} onClick={() => setFocus(e)} />
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > 2000 && <p class="note dim">First 2000 shown: filter to narrow.</p>}
      {focus && (
        <div class="focus">
          <p class="note">
            #{focus.seq} {focus.message}
            {(focus.type === 'marker' || focus.type === 'note') && (
              <button class="btn" onClick={() => onCompareAt(focus.seq)}>
                COMPARE BEFORE / AFTER THIS
              </button>
            )}
          </p>
          <p class="note dim">
            {close.length} event(s) within ±2 s on this computer's clock (proximity in time, not a cause): {close.slice(0, 20).map((e) => `#${e.seq}`).join(' ')}
          </p>
        </div>
      )}
    </>
  );
}

function ComparisonView({ before, after, label }: { before: LabEvent[]; after: LabEvent[]; label: string }) {
  const c = compare(before, after);
  return (
    <div class="comparison">
      <p class="note">
        {label}: {c.before.events} event(s) before, {c.after.events} after. Differences only; no cause is inferred. RSSI is a radio level, not a distance.
      </p>
      {c.counts.length > 0 && (
        <table class="trace">
          <thead>
            <tr>
              <th>EVENTS</th>
              <th>BEFORE</th>
              <th>AFTER</th>
            </tr>
          </thead>
          <tbody>
            {c.counts.map((x) => (
              <tr key={x.key}>
                <td>{x.key}</td>
                <td class="num">{x.before}</td>
                <td class="num">{x.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(c.bleOnlyBefore.length > 0 || c.bleOnlyAfter.length > 0) && (
        <p class="note">
          BLE ids seen only before: {c.bleOnlyBefore.join(', ') || 'none'} · only after: {c.bleOnlyAfter.join(', ') || 'none'} (ids as observed: a changed random address is a new id)
        </p>
      )}
      {c.bleBoth.length > 0 && (
        <table class="trace">
          <thead>
            <tr>
              <th>BLE ID IN BOTH</th>
              <th>RSSI MEDIAN BEFORE</th>
              <th>AFTER</th>
              <th>PAYLOAD</th>
            </tr>
          </thead>
          <tbody>
            {c.bleBoth.map((x) => (
              <tr key={x.device}>
                <td>{x.device}</td>
                <td class="num">{x.rssiBefore ?? '--'} dBm</td>
                <td class="num">{x.rssiAfter ?? '--'} dBm</td>
                <td>{x.payloadChanged ? 'CHANGED' : 'same'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function LabSessionsPanel({ lab, onReplayBle }: { lab: Lab; onReplayBle?: (data: LabSessionData) => void }) {
  useRev(lab.sessions);
  const s = lab.sessions;
  const r = s.recorder;
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState<number | null>(null);
  const [other, setOther] = useState<LabSessionData | null>(null);
  const opened = s.opened;
  const live = r?.recording ? r.data() : null;
  const view = opened ?? live;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  return (
    <Panel title="LAB SESSIONS" info="One timeline for every lab tool: Flipper operations, BLE observations, GATT reads and writes, your markers and notes. Kept in this browser as sealed .hdlab files. Reopening one is a visualization: nothing is ever sent to a device again.">
      <div class="actions">
        {r?.recording ? (
          <>
            <Tag status="LIVE" label="RECORDING" />
            <input class="input" value={r.header.name} onChange={(e) => s.rename((e.target as HTMLInputElement).value)} aria-label="Session name" />
            <span class="dim">
              {r.events.length} event(s){r.lost ? ` · ${r.lost} LOST (limit reached)` : ''}
            </span>
            <button class="btn primary" onClick={() => void s.stop().catch(fail)}>
              STOP AND KEEP
            </button>
          </>
        ) : (
          <>
            <input class="input" placeholder="session name (optional)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="New session name" />
            <button
              class="btn primary"
              onClick={() => {
                s.start(name);
                setName('');
              }}
            >
              ● START LAB SESSION
            </button>
          </>
        )}
        <label class="btn file-btn">
          OPEN .HDLAB…
          <input
            type="file"
            accept=".hdlab,application/x-ndjson"
            hidden
            onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              try {
                s.openText(await f.text());
                setError(null);
              } catch (x) {
                fail(x);
              }
            }}
          />
        </label>
      </div>
      {!s.persistent && <p class="note warn">This browser refused storage: sessions last until the page closes. Export them.</p>}
      {error && <p class="note warn">{error}</p>}

      <table class="trace">
        <thead>
          <tr>
            <th>SESSION</th>
            <th>STARTED</th>
            <th>EVENTS</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {s.stored.length === 0 && (
            <tr>
              <td colSpan={4} class="dim">
                No lab session kept yet.
              </td>
            </tr>
          )}
          {s.stored.map((x) => (
            <tr key={x.id} class={opened?.header.id === x.id ? 'selected' : undefined}>
              <td>
                {x.name} <span class="dim">{x.id}</span>
              </td>
              <td>{new Date(x.startedAt).toLocaleString()}</td>
              <td class="num">
                {x.events}
                {x.lost ? ` (+${x.lost} lost)` : ''}
              </td>
              <td class="row-actions">
                <button class="btn" onClick={() => void s.open(x.id).then(() => setSplit(null), fail)}>
                  OPEN
                </button>
                <button class="btn" onClick={() => void s.text(x.id).then((t) => download(`${x.id}.hdlab`, 'application/x-ndjson', t), fail)}>
                  EXPORT
                </button>
                <button class="btn" title="Compare the open session with this one" disabled={!opened || opened.header.id === x.id} onClick={() => void s.text(x.id).then((t) => setOther(parseHdlab(t)), fail)}>
                  VS OPEN
                </button>
                <button class="btn danger" onClick={() => confirm(`Delete ${x.name} from this browser?`) && void s.remove(x.id).catch(fail)}>
                  DELETE
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {view && (
        <div class="session-view">
          <div class="actions">
            <b>{view.header.name}</b>
            {opened ? integrityTag(view.integrity) : <Tag status="LIVE" label="LIVE" />}
            {view.events.some((e) => e.origin === 'SIMULATED') && <Tag status="WARN" label="CONTAINS DEMO DATA" />}
            <button class="btn" onClick={() => download(`${view.header.id}.txt`, 'text/plain', labReport(view))}>
              REPORT (TXT)
            </button>
            {opened && (
              <>
                {onReplayBle && (
                  <button class="btn" onClick={() => onReplayBle(opened)}>
                    SHOW BLE IN BLUETOOTH LAB
                  </button>
                )}
                <button class="btn" onClick={() => download(`${opened.header.id}.hdlab`, 'application/x-ndjson', toHdlab(opened))}>
                  EXPORT
                </button>
                <button
                  class="btn"
                  onClick={() => {
                    s.close();
                    setOther(null);
                    setSplit(null);
                  }}
                >
                  CLOSE
                </button>
              </>
            )}
          </div>
          {opened && <p class="note dim">Read-only replay: a visualization of what was recorded. Nothing here is sent to any device.</p>}
          <Timeline data={view} onCompareAt={setSplit} />
          {split !== null && <ComparisonView label={`Before / after marker #${split}`} before={splitAt(view.events, split)[0]} after={splitAt(view.events, split)[1]} />}
          {other && opened && <ComparisonView label={`${opened.header.name} (before) vs ${other.header.name} (after)`} before={opened.events} after={other.events} />}
        </div>
      )}
    </Panel>
  );
}
