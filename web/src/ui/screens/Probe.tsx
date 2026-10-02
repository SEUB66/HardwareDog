import { useState } from 'preact/hooks';
import { clock } from '../../core/format';
import type { System } from '../../core/system';
import type { ProbeTest } from '../../core/types';
import { PROBE_TESTS } from '../../core/types';
import { Empty } from '../components/Empty';
import { Panel } from '../components/Panel';
import { Hint } from '../components/Hint';
import { Tag } from '../components/Tag';
import { explain } from '../../core/glossary';

/** What each active test will put on the wire. Shown before running (spec 20). */
const WHAT_IT_DOES: Record<ProbeTest, (target: string) => string> = {
  PING: (t) => `send 4 ICMP echo requests to ${t}, 1000 ms timeout`,
  DNS: (t) => (/^[\d.]+$/.test(t) ? `query the configured DNS server for a known name` : `resolve ${t} via the configured DNS server`),
  TCP: (t) => `open a TCP connection to ${t}:80, then close it`,
  HTTP: (t) => `send "GET /" to http://${t}/ and read the status line`,
};

/** SNIFF is passive. PROBE is active and always says what it will do. */
export function Probe({ system }: { system: System }) {
  const [target, setTarget] = useState(system.net.gateway.address ?? '192.168.1.1');
  const [tests, setTests] = useState<Set<ProbeTest>>(new Set(['PING', 'DNS', 'TCP']));
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (t: ProbeTest) => {
    const next = new Set(tests);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTests(next);
  };

  const selected = PROBE_TESTS.filter((t) => tests.has(t));
  const run = (e?: Event) => {
    e?.preventDefault();
    const result = system.probe(target, selected);
    setMessage(typeof result === 'string' ? result : null);
  };

  const quick = [
    { label: 'GATEWAY', target: system.net.gateway.address },
    { label: 'DNS SERVER', target: system.net.dns.address },
  ].filter((q): q is { label: string; target: string } => !!q.target);

  return (
    <>
      <h1 class="screen-title">
        PROBE / NETWORK <span class="sub">active tests</span>
      </h1>
      <div class="grid wide">
        <Panel title="SETUP" aside="ACTIVE">
          <form onSubmit={run}>
            <label for="probe-target" class="dim">
              <Hint text={explain('TARGET', 'PROBE')} focusable={false}>
                TARGET
              </Hint>
            </label>
            <div class="actions" style={{ marginTop: 4 }}>
              <input
                id="probe-target"
                class="input"
                value={target}
                onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
                autocomplete="off"
                spellcheck={false}
                style={{ flex: 1 }}
              />
              {quick.map((q) => (
                <button key={q.label} type="button" class="btn" onClick={() => setTarget(q.target)}>
                  {q.label}
                </button>
              ))}
            </div>
            <p class="dim" style={{ margin: '12px 0 4px' }}>
              TESTS
            </p>
            {PROBE_TESTS.map((t) => (
              <label class="check" key={t}>
                <input type="checkbox" checked={tests.has(t)} onChange={() => toggle(t)} />
                <span class="box">[{tests.has(t) ? 'X' : ' '}]</span>
                <Hint text={explain(t, 'PROBE')} focusable={false}>
                  {t}
                </Hint>
              </label>
            ))}

            <p class="dim" style={{ margin: '12px 0 4px' }}>
              HARDWARE DOG WILL
            </p>
            {selected.length === 0 ? (
              <p class="note warn">nothing: no test selected</p>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 22 }}>
                {selected.map((t) => (
                  <li key={t}>{WHAT_IT_DOES[t](target.trim() || '<target>')}</li>
                ))}
              </ol>
            )}
            <div class="actions">
              <button class="btn primary" type="submit" disabled={!system.online || selected.length === 0}>
                RUN PROBE
              </button>
            </div>
            {message && <p class="note warn">{message}</p>}
          </form>
        </Panel>

        <Panel title="RESULTS">
          {system.probes.length === 0 ? (
            <Empty title="NO PROBES RUN" hint="Nothing has been sent on the network by Hardware Dog." />
          ) : (
            <div class="stack">
              {system.probes.slice(0, 6).map((run) => (
                <div key={run.id}>
                  <div>
                    <span class="cyan">{run.target}</span>
                    <span class="dim">{`  ${clock(run.startedAt)}  `}</span>
                    {run.finishedAt === null ? <Tag status="PENDING" label="RUNNING" /> : null}
                  </div>
                  <div class="trace" style={{ border: 0 }}>
                    <table>
                      <tbody>
                        {run.tests.map((t) => {
                          const r = run.results.find((x) => x.test === t);
                          return (
                            <tr key={t}>
                              <td>
                              <Hint text={explain(t, 'PROBE')}>{t}</Hint>
                            </td>
                              <td>{r ? <Tag status={r.status} /> : <Tag status="PENDING" />}</td>
                              <td class="msg dim">{r?.detail ?? 'waiting'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
