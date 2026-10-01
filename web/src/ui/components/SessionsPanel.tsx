import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionMeta } from '../../core/archive';
import { SIM_RETENTION } from '../../core/archive';
import { bytes, clockShort, duration } from '../../core/format';
import { Empty } from './Empty';
import { KV } from './KV';
import { Panel } from './Panel';
import { Tag } from './Tag';

export interface SessionsPanelProps {
  list: readonly SessionMeta[];
  /** Key of the session being recorded now. */
  activeKey: string | null;
  persistent: boolean;
  /** Last problem opening a file, shown under the list. */
  message: string | null;
  onReplay: (key: string) => void;
  onSave: (key: string) => void;
  onRemove: (key: string) => void;
  onOpen: (file: File) => void;
}

/** "POWER_INSTABILITY:HIGH" -> "POWER INSTABILITY HIGH" */
const finding = (d: string) => d.replace(/_/g, ' ').replace(':', ' ');

/**
 * Sessions recorded in this browser. A session can be replayed here, or
 * saved as .hdlog and replayed by anyone, without the device.
 */
export function SessionsPanel({ list, activeKey, persistent, message, onReplay, onSave, onRemove, onOpen }: SessionsPanelProps) {
  const file = useRef<HTMLInputElement>(null);
  // Deleting takes two clicks: a recorded fault may be the only evidence.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const total = list.reduce((sum, m) => sum + m.bytes, 0);

  return (
    <Panel title="SESSIONS" aside={`${list.length} recorded`}>
      <KV
        rows={[
          ['ARCHIVE', persistent ? 'THIS BROWSER ONLY' : <Tag status="WARN" label="MEMORY ONLY, LOST ON RELOAD" />],
          ['SIZE', bytes(total)],
        ]}
      />
      {list.length === 0 ? (
        <Empty title="NO SESSION RECORDED" hint="Live sessions are recorded here as they happen." />
      ) : (
        <ul class="sessions">
          {list.map((m) => {
            const h = m.header;
            const active = m.key === activeKey;
            return (
              <li key={m.key} class="session">
                <div class="session-head">
                  <span class="id">{h.id}</span>
                  {active && <Tag status="LIVE" label="REC" />}
                  {h.source === 'SIMULATOR' ? <Tag status="WARN" label={`SIMULATOR${h.scenario ? ` ${h.scenario}` : ''}`} /> : <span>{h.source}</span>}
                </div>
                <div class="dim">
                  {clockShort(h.startedAt)} / {duration(m.lastAt - h.startedAt)} / {m.entries.toLocaleString('en-US')} EVENTS / {bytes(m.bytes)}
                </div>
                <div class="session-findings">{m.diagnoses.length ? m.diagnoses.map(finding).join(' / ') : 'NO FINDINGS'}</div>
                <div class="actions">
                  <button class="btn" onClick={() => onReplay(m.key)} disabled={active} title={active ? 'Recording now' : 'Replay, read-only'}>
                    REPLAY
                  </button>
                  <button class="btn" onClick={() => onSave(m.key)}>
                    SAVE .HDLOG
                  </button>
                  {!active && (
                    <button
                      class={`btn${armed === m.key ? ' active' : ''}`}
                      onClick={() => {
                        if (armed !== m.key) return setArmed(m.key);
                        setArmed(null);
                        onRemove(m.key);
                      }}
                    >
                      {armed === m.key ? 'CONFIRM DELETE' : 'DELETE'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div class="actions">
        <button class="btn primary" onClick={() => file.current?.click()}>
          OPEN .HDLOG FILE
        </button>
        <input
          ref={file}
          type="file"
          accept=".hdlog,.ndjson,.jsonl,.txt"
          class="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            input.value = '';
            if (f) onOpen(f);
          }}
        />
      </div>
      {message && (
        <p class="note warn" role="alert">
          {message}
        </p>
      )}
      <p class="note">
        Live sessions are recorded in this browser only. The latest {SIM_RETENTION} simulator sessions are kept; sessions from real hardware are
        never deleted automatically. A replay goes through the same decoder and rules as a live device, and is read-only.
      </p>
    </Panel>
  );
}
