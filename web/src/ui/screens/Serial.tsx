import { useEffect, useRef, useState } from 'preact/hooks';
import { bytes, clock } from '../../core/format';
import type { System } from '../../core/system';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** A real serial monitor, minimal controls (spec 17). */
export function Serial({ system }: { system: System }) {
  const s = system.serial;
  const [baud, setBaud] = useState(String(s.baud));
  const [text, setText] = useState('');
  const [stamps, setStamps] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const out = useRef<HTMLDivElement>(null);

  useEffect(() => setBaud(String(s.baud)), [s.baud]);
  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  });

  const send = (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    setMessage(system.sendSerial(text));
    setText('');
  };

  return (
    <>
      <h1 class="screen-title">
        SERIAL / UART <span class="sub">target console</span>
      </h1>
      <div class="grid wide">
        <Panel title="PORT">
          <KV
            rows={[
              ['PORT', s.port],
              ['BAUD', String(s.baud), true],
              ['DATA', String(s.dataBits)],
              ['PARITY', s.parity],
              ['STOP', String(s.stopBits)],
            ]}
          />
          <form
            class="actions"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(system.setBaud(Number(baud)));
            }}
          >
            <label class="sr-only" for="baud">
              Baud rate
            </label>
            <select id="baud" class="input" value={baud} onChange={(e) => setBaud((e.target as HTMLSelectElement).value)}>
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <button class="btn" type="submit" disabled={!system.online}>
              APPLY
            </button>
          </form>
        </Panel>
        <Panel title="COUNTERS">
          <KV
            rows={[
              ['RX', bytes(s.rxBytes), true],
              ['TX', bytes(s.txBytes)],
              ['ERRORS', s.errors ? <Tag status="WARN" label={String(s.errors)} /> : '0'],
              ['STATE', s.active ? <Tag status="LIVE" label="ACTIVE" /> : <Tag status="UNKNOWN" label="IDLE" />],
            ]}
          />
        </Panel>
      </div>

      <Panel title="CONSOLE" aside={`${s.lines.length} lines`}>
        <label class="check" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={stamps} onChange={() => setStamps(!stamps)} />
          <span class="box">[{stamps ? 'X' : ' '}]</span>
          TIMESTAMPS
        </label>
        <div class="console" ref={out} role="log" aria-label="Serial console" tabIndex={0}>
          {s.lines.map((l, n) => (
            <div key={n} class={l.dir === 'TX' ? 'tx' : undefined}>
              {stamps && <span class="dim">{clock(l.t)} </span>}
              {l.dir === 'TX' ? '< ' : '> '}
              {l.text}
            </div>
          ))}
          <div>
            {'> '}
            <span class="cursor-blink">_</span>
          </div>
        </div>
        <form class="console-input" onSubmit={send}>
          <label class="sr-only" for="uart-tx">
            Send to target
          </label>
          <input
            id="uart-tx"
            class="input"
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            placeholder="line to send (ACTIVE: writes to the target UART)"
            autocomplete="off"
            spellcheck={false}
          />
          <button class="btn" type="submit" disabled={!system.online}>
            SEND
          </button>
        </form>
        {message && <p class="note warn">{message}</p>}
      </Panel>
    </>
  );
}
