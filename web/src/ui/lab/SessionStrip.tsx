/**
 * HARDWARE DOG / LAB SESSION STRIP
 *
 * REC, STOP and markers for the lab session, the same on every lab screen
 * (Flipper, Bluetooth, Camera Sniffer): its own module, so each lab screen
 * loads on its own.
 */

import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { Lab } from '../../core/lab/context';
import { useRev } from './useRev';

/** The recording, always in reach: REC, a marker, a note. */
export function SessionStrip({ lab }: { lab: Lab }) {
  useRev(lab.sessions);
  const [text, setText] = useState('');
  const r = lab.sessions.recorder;
  const rec = r?.recording ?? false;
  return (
    <div class="session-strip">
      <div class="actions">
        {rec ? (
          <button class="btn rec on" onClick={() => void lab.sessions.stop()} title="Stop and keep the lab session in this browser">
            ■ STOP · {r!.events.length} ev{r!.lost ? ` · ${r!.lost} LOST` : ''}
          </button>
        ) : (
          <button class="btn rec" onClick={() => lab.sessions.start('')} title="Record every lab event (Flipper, BLE, markers) on one timeline">
            ● REC LAB SESSION
          </button>
        )}
      </div>
      <form
        class="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (lab.sessions.mark(text)) setText('');
        }}
      >
        <input class="input" placeholder="marker: button pressed, cable plugged…" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} aria-label="Marker text" />
        <button class="btn" type="submit">
          MARK
        </button>
      </form>
      <div class="quick-marks">
        {['button pressed', 'cable plugged', 'cable unplugged', 'power cycled'].map((m) => (
          <Fragment key={m}>
            <button class="btn small" onClick={() => lab.sessions.mark(m)}>
              {m}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
