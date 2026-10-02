import { useState } from 'preact/hooks';
import { PROTOCOL_VERSION } from '../../core/protocol';
import type { System } from '../../core/system';
import { RULES } from '../../core/system';
import type { Settings, TransportKind } from '../../core/types';
import { webSerialSupported } from '../../core/webserial';
import { SCENARIOS, SCENARIO_IDS, type ScenarioId } from '../../core/scenarios';
import { bytes } from '../../core/format';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import type { ComponentChildren } from 'preact';
import { IntegrityTag } from '../components/IntegrityTag';
import { SessionsPanel, type SessionsPanelProps } from '../components/SessionsPanel';
import { Hint } from '../components/Hint';
import { Tag } from '../components/Tag';
import { explain } from '../../core/glossary';
import { beep } from '../sound';

interface SetupProps {
  system: System;
  /** Active simulator scenario, or null on real hardware. */
  scenario: ScenarioId | null;
  onSwitch: (kind: Exclude<TransportKind, 'REPLAY'>, scenario?: ScenarioId) => void;
  sessions: SessionsPanelProps;
  /** What the current session has written so far; null for a replay. */
  recording: { entries: number; bytes: number } | null;
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="check">
      <input type="checkbox" checked={on} onChange={() => onChange(!on)} />
      <span class="box">[{on ? 'X' : ' '}]</span>
      {label}
    </label>
  );
}

function NumberField(props: { id: string; label: string; unit: string; value: number; step: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(props.value));
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v >= props.min && v <= props.max) props.onCommit(v);
    else setText(String(props.value));
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
      <label for={props.id} class="dim" style={{ minWidth: 150 }}>
        <Hint text={explain(props.label, 'RULES')} focusable={false}>
          {props.label}
        </Hint>
      </label>
      <input
        id={props.id}
        class="input"
        type="number"
        step={props.step}
        min={props.min}
        max={props.max}
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        style={{ width: 100 }}
      />
      <span class="dim">{props.unit}</span>
    </div>
  );
}

function sourceCell(system: System) {
  const r = system.replayOf;
  if (r) return <Tag status={r.origin === 'SIMULATED' ? 'WARN' : 'INFO'} label={`REPLAY OF ${r.origin} / ${r.id}${r.scenario ? ` ${r.scenario}` : ''}`} />;
  if (system.transportKind === 'DOGD') return <Tag status={system.origin === 'SIMULATED' ? 'WARN' : 'INFO'} label={`DOGD / ${system.origin ?? '--'}`} />;
  if (system.transportKind === 'SIMULATOR') return <Tag status="WARN" label="SIMULATOR" />;
  return system.transportKind ?? 'NONE';
}

function recordingCell(system: System, recording: SetupProps['recording']) {
  if (system.replayOf) return 'OFF (REPLAY, READ-ONLY)';
  if (system.recordingError) return <Tag status="FAIL" label={`STOPPED: ${system.recordingError}`} />;
  if (!recording) return '--';
  return <Tag status="LIVE" label={`REC ${recording.entries.toLocaleString('en-US')} EVENTS / ${bytes(recording.bytes)}`} />;
}

export function Setup({ system, scenario, onSwitch, sessions, recording }: SetupProps) {
  const s = system.settings;
  const set = (patch: Partial<Settings>) => system.updateSettings(patch);
  const serialOk = webSerialSupported();

  return (
    <>
      <h1 class="screen-title">
        SETUP <span class="sub">stored in this browser only</span>
      </h1>
      <div class="grid wide">
        <Panel title="LINK">
          <KV
            rows={[
              ['SOURCE', sourceCell(system)],
              ['ENDPOINT', system.transportLabel || '--'],
              ['STATE', <Tag status={system.link === 'ONLINE' ? 'PASS' : system.link === 'LOST' ? 'FAIL' : 'UNKNOWN'} label={system.link} />],
              ['PROTOCOL', `v${PROTOCOL_VERSION} / NDJSON`],
              ['FRAME ERRORS', String(system.frameErrors)],
              ['RECORDING', recordingCell(system, recording)],
              ...(system.replayIntegrity ? ([['INTEGRITY', <IntegrityTag status={system.replayIntegrity.status} />]] as [string, ComponentChildren][]) : []),
              ...(system.recordedThresholds ? ([['THRESHOLDS', 'AS RECORDED']] as [string, string][]) : []),
            ]}
          />
          {system.replayIntegrity && system.replayIntegrity.problems.length > 0 && (
            <ul class="note warn" role="alert">
              {system.replayIntegrity.problems.slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div class="actions">
            <button class={`btn ${system.transportKind === 'SIMULATOR' ? 'active' : ''}`} onClick={() => onSwitch('SIMULATOR')}>
              USE SIMULATOR
            </button>
            <button class={`btn ${system.transportKind === 'DOGD' ? 'active' : ''}`} onClick={() => onSwitch('DOGD')} title="The local daemon on this machine (127.0.0.1:4782)">
              CONNECT DOGD
            </button>
            <button class={`btn ${system.transportKind === 'WEB SERIAL' ? 'active' : ''}`} onClick={() => onSwitch('WEB SERIAL')} disabled={!serialOk}>
              CONNECT WEB SERIAL
            </button>
          </div>
          {!serialOk && <p class="note warn">WEB SERIAL NOT AVAILABLE IN THIS BROWSER. Use a Chromium-based browser over https or localhost.</p>}
          <p class="note">Switching source starts a new session, so simulated and real measurements are never mixed in one report.</p>
        </Panel>

        <SessionsPanel {...sessions} />

        <Panel title="SIMULATOR SCENARIO" aside={scenario ?? 'hardware'}>
          <label class="sr-only" for="scenario">
            Fault scenario
          </label>
          <select
            id="scenario"
            class="input"
            value={scenario ?? ''}
            onChange={(e) => onSwitch('SIMULATOR', (e.target as HTMLSelectElement).value as ScenarioId)}
            style={{ width: '100%' }}
          >
            {scenario === null && <option value="">-- choose a scenario --</option>}
            {SCENARIO_IDS.map((id) => (
              <option key={id} value={id}>
                {id} {SCENARIOS[id].title}
              </option>
            ))}
          </select>
          {scenario && <p class="note">{SCENARIOS[scenario].fault}</p>}
          <p class="note">Each scenario is a physical fault turned into protocol frames. The diagnostic engine is not told which one is running.</p>
        </Panel>

        <Panel title="LOCAL">
          <KV
            rows={[
              ['MODE', 'LOCAL'],
              ['CLOUD', 'DISABLED'],
              ['ACCOUNT', 'NOT REQUIRED'],
              ['DEVICE DATA', 'LOCAL ONLY'],
              ['STORAGE', system.storageOk ? <Tag status="PASS" label="OK" /> : <Tag status="WARN" label="UNAVAILABLE" />],
            ]}
          />
        </Panel>

        <Panel title="INTERFACE">
          <Toggle label="STARTUP BEEP" on={s.sound} onChange={(v) => set({ sound: v })} />
          <Toggle label="FIELD MODE (high contrast, direct sunlight)" on={s.fieldMode} onChange={(v) => set({ fieldMode: v })} />
          <Toggle label="REDUCED MOTION" on={s.reducedMotion} onChange={(v) => set({ reducedMotion: v })} />
          <div class="actions">
            <button class="btn" onClick={beep}>
              TEST BEEP
            </button>
          </div>
        </Panel>

        <Panel title="DIAGNOSTIC RULES" aside={`${RULES.length} loaded`}>
          <pre style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }} class="dim">
            {RULES.join('\n')}
          </pre>
          <NumberField id="uv" label="UNDERVOLTAGE" unit="V" value={s.undervoltageThreshold} step={0.01} min={3} max={5.5} onCommit={(v) => set({ undervoltageThreshold: v })} />
          <NumberField id="oc" label="OVERCURRENT" unit="A" value={s.overcurrentThreshold} step={0.05} min={0.05} max={5} onCommit={(v) => set({ overcurrentThreshold: v })} />
          <NumberField id="cw" label="CORRELATION WINDOW" unit="ms" value={s.correlationWindowMs} step={10} min={10} max={2000} onCommit={(v) => set({ correlationWindowMs: v })} />
          <p class="note">Thresholds apply to new samples. Past events are not rewritten.</p>
        </Panel>
      </div>
    </>
  );
}
