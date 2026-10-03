import type { System } from '../../core/system';
import { Hint } from './Hint';

interface SimBannerProps {
  system: System;
  /** The scenario playing, when the simulator is the source. */
  scenario: { id: string; title: string } | null;
  onConnect: () => void;
  /** Leave the demo: back to NOT CONNECTED. Null when there is no demo to stop. */
  onStop: (() => void) | null;
}

const WHY =
  'Hardware Dog reads ONE device: the Hardware Dog you connect in SETUP (Web Serial or dogd). It never lists or measures the USB ports of this computer. In DEMO MODE, which you started, a built-in simulator plays a fault scenario so every screen has something to show.';

/**
 * Simulated data is labeled on every screen (LAWS 5). Not a corner tag:
 * a line nobody can miss, saying where the numbers come from.
 */
export function SimBanner({ system, scenario, onConnect, onStop }: SimBannerProps) {
  const replay = system.replayOf;
  const simulated = replay ? replay.origin === 'SIMULATED' : system.origin === 'SIMULATED';
  if (!simulated) return null;
  const what = replay
    ? `REPLAY OF A SIMULATED RECORDING ${replay.id}`
    : scenario
      ? `DEMO SCENARIO ${scenario.id} ${scenario.title}`
      : 'SIMULATED SOURCE THROUGH DOGD';
  return (
    <div class="sim-banner" role="status">
      <Hint text={WHY} term="SIMULATED DATA">
        <b>SIMULATED DATA</b>
      </Hint>
      <span class="what">{what}</span>
      <span class="dim">nothing on screen comes from this computer</span>
      {!replay && (
        <span class="actions">
          {onStop && (
            <button class="btn" onClick={onStop}>
              STOP DEMO
            </button>
          )}
          <button class="btn" onClick={onConnect}>
            CONNECT A REAL DEVICE
          </button>
        </span>
      )}
    </div>
  );
}
