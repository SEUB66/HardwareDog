import { useRef } from 'preact/hooks';
import { webSerialSupported } from '../../core/webserial';
import { Hint } from './Hint';
import { Icon } from './Icon';

interface ConnectBannerProps {
  onSerial: () => void;
  onDogd: () => void;
  onOpen: (file: File) => void;
  onDemo: () => void;
  onTour: () => void;
}

const WHY =
  'Hardware Dog reads the Hardware Dogs you connect (Web Serial, or dogd on this machine): one, or several as a pack. It never lists or measures the USB ports of this computer. Nothing runs until you choose a source: no data is invented while you look around.';

/**
 * Nothing is connected: say it, and offer every source. The demo is one of
 * them, chosen on purpose, never started behind the operator's back.
 */
export function ConnectBanner({ onSerial, onDogd, onOpen, onDemo, onTour }: ConnectBannerProps) {
  const file = useRef<HTMLInputElement>(null);
  const serialOk = webSerialSupported();
  const tile = (icon: string, title: string, text: string, onClick: () => void, extra = '', disabled = false, why?: string) => (
    <button class={`source-tile${extra}`} onClick={onClick} disabled={disabled} title={why}>
      <Icon name={icon} size={22} />
      <span class="source-title">{title}</span>
      <span class="source-text">{text}</span>
    </button>
  );
  return (
    <div class="connect-banner" role="status">
      <div class="start-intro">
        <Hint text={WHY} term="NOT CONNECTED">
          <b class="start-state">NOT CONNECTED</b>
        </Hint>
        <h2 class="start-title">Start here</h2>
        <p class="start-text">
          Hardware Dog watches a board through a Hardware Dog probe, puts everything it sees on one timeline, and tells you what went wrong. Nothing is
          measured until you choose a source. First time?{' '}
          <button class="link" onClick={onTour}>
            take the tour
          </button>
        </p>
        <ol class="start-steps">
          <li>
            <b>Connect</b> a Hardware Dog: by USB, or through dogd.
          </li>
          <li>
            <b>Watch</b> power, USB, serial, I2C and network, live.
          </li>
          <li>
            <b>Read</b> the diagnosis: what happened, how sure, what to check next.
          </li>
        </ol>
      </div>
      <div class="sources">
        {tile(
          'WEB_SERIAL',
          'CONNECT WEB SERIAL',
          'A Hardware Dog on a USB port of this computer.',
          onSerial,
          '',
          !serialOk,
          serialOk ? 'A Hardware Dog on a USB serial port' : 'Web Serial needs a Chromium-based browser over https or localhost',
        )}
        {tile('DOGD', 'CONNECT DOGD', 'Through the local daemon: one Dog, or several as a pack.', onDogd, '', false, 'The local daemon on this machine (127.0.0.1:4782)')}
        {tile('RECORDING', 'OPEN A RECORDING', 'Replay a saved session (.hdlog), read-only.', () => file.current?.click(), '', false, 'Replay a recorded session (.hdlog)')}
        {tile('DEMO', 'DEMO MODE', 'Try it on a simulated fault. Always labeled SIMULATED.', onDemo, ' demo', false, 'A simulated Hardware Dog plays a fault scenario. Every screen says SIMULATED.')}
      </div>
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
