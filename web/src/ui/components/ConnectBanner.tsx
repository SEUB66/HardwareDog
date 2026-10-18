/**
 * Off STATUS, nothing connected: one line, not the whole start card, so
 * each screen is itself and the way back to the sources is one tap.
 */
export function ConnectStrip({ onChoose, onDemo }: { onChoose: () => void; onDemo: () => void }) {
  return (
    <div class="connect-strip" role="status">
      <span class="dot" aria-hidden="true" />
      <b>NO DEVICE</b>
      <span class="dim">nothing is measured</span>
      <span class="spacer" />
      <button class="btn" onClick={onChoose}>
        <span class="long">CHOOSE A </span>SOURCE
      </button>
      <button class="btn demo-btn" onClick={onDemo}>
        DEMO
      </button>
    </div>
  );
}
