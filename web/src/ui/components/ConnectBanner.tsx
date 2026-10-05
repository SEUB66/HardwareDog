import { useRef } from 'preact/hooks';
import { webSerialSupported } from '../../core/webserial';
import { Hint } from './Hint';

interface ConnectBannerProps {
  onSerial: () => void;
  onDogd: () => void;
  onOpen: (file: File) => void;
  onDemo: () => void;
  onTour: () => void;
}

const WHY =
  'Hardware Dog reads ONE device: the Hardware Dog you connect (Web Serial, or dogd on this machine). It never lists or measures the USB ports of this computer. Nothing runs until you choose a source: no data is invented while you look around.';

/**
 * Nothing is connected: say it, and offer every source. The demo is one of
 * them, chosen on purpose, never started behind the operator's back.
 */
export function ConnectBanner({ onSerial, onDogd, onOpen, onDemo, onTour }: ConnectBannerProps) {
  const file = useRef<HTMLInputElement>(null);
  const serialOk = webSerialSupported();
  return (
    <div class="connect-banner" role="status">
      <Hint text={WHY} term="NOT CONNECTED">
        <b>NOT CONNECTED</b>
      </Hint>
      <span class="dim">
        choose a source: nothing is measured until you do. First time here?{' '}
        <button class="link" onClick={onTour}>
          take the tour
        </button>
      </span>
      <span class="actions">
        <button class="btn" onClick={onSerial} disabled={!serialOk} title={serialOk ? 'A Hardware Dog on a USB serial port' : 'Web Serial needs a Chromium-based browser over https or localhost'}>
          CONNECT WEB SERIAL
        </button>
        <button class="btn" onClick={onDogd} title="The local daemon on this machine (127.0.0.1:4782)">
          CONNECT DOGD
        </button>
        <button class="btn" onClick={() => file.current?.click()} title="Replay a recorded session (.hdlog)">
          OPEN A RECORDING
        </button>
        <button class="btn demo" onClick={onDemo} title="A simulated Hardware Dog plays a fault scenario. Every screen says SIMULATED.">
          DEMO MODE
        </button>
      </span>
      <input
        ref={file}
        class="sr-only"
        type="file"
        accept=".hdlog,application/x-ndjson"
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
  );
}
