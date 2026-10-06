import { useRef } from 'preact/hooks';
import { webSerialSupported } from '../../core/webserial';
import { Hint } from './Hint';
import { Icon } from './Icon';

interface ConnectBannerProps {
  onConsole: () => void;
  onSerial: () => void;
  onDogd: () => void;
  /** This computer's network, through dogd --source host. */
  onNetwork: () => void;
  onOpen: (file: File) => void;
  onDemo: () => void;
  onTour: () => void;
}

const WHY =
  'Hardware Dog reads the serial console of a board, or the Hardware Dog probes you connect (Web Serial, or dogd on this machine). It never lists or measures the USB ports of this computer. Nothing runs until you choose a source: no data is invented while you look around.';

/**
 * Nothing is connected: say it, and offer every source. The demo is one of
 * them, chosen on purpose, never started behind the operator's back.
 */
export function ConnectBanner({ onConsole, onSerial, onDogd, onNetwork, onOpen, onDemo, onTour }: ConnectBannerProps) {
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
          Hardware Dog reads what your hardware says, puts it on one timeline, and tells you what went wrong. <b>No probe needed to start</b>: read a
          board's serial console, or this computer's network. A Hardware Dog probe adds power, USB, I2C, and the network of the board itself. First time?{' '}
          <button class="link" onClick={onTour}>
            take the tour
          </button>
        </p>
        <ol class="start-steps">
          <li>
            <b>Plug&nbsp;in</b> a board with a USB serial port (Arduino, ESP32, a USB-UART adapter), or check this computer's network.
          </li>
          <li>
            <b>Watch</b> it live: resets, crashes, wrong baud rate; link, DHCP, gateway, DNS, Internet.
          </li>
          <li>
            <b>Read</b> the diagnosis: what happened, how sure, what to check next.
          </li>
        </ol>
      </div>
      <div class="sources">
        {!serialOk && (
          <p class="sources-note">
            Serial ports need <b>Chrome or Edge on a computer</b>. On this device: the demo, a recording, or dogd.
          </p>
        )}
        {tile(
          'SERIAL',
          'SERIAL CONSOLE',
          'Any board on a USB serial port: Arduino, ESP32, a router console. No probe needed.',
          onConsole,
          ' primary',
          !serialOk,
          serialOk ? 'Chrome lists the serial ports of this computer; pick the board' : 'Web Serial needs Chrome or Edge on a computer, over https or localhost',
        )}
        {tile(
          'NET',
          'THIS COMPUTER\'S NETWORK',
          'Link, DHCP, gateway, DNS, Internet, checked from here. No probe: dogd serve --source host.',
          onNetwork,
          ' primary-alt',
          false,
          'The network as this computer sees it, through dogd on this machine (docs/DOGD.md)',
        )}
        {tile(
          'WEB_SERIAL',
          'HARDWARE DOG PROBE',
          'A Hardware Dog on USB: power, USB, serial, I2C, network.',
          onSerial,
          '',
          !serialOk,
          serialOk ? 'A Hardware Dog probe on a USB serial port' : 'Web Serial needs Chrome or Edge on a computer, over https or localhost',
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

/**
 * Off STATUS, nothing connected: one line, not the whole start card, so
 * each screen is itself and the way back to the sources is one tap.
 */
export function ConnectStrip({ onChoose, onDemo }: { onChoose: () => void; onDemo: () => void }) {
  return (
    <div class="connect-strip" role="status">
      <span class="dot" aria-hidden="true" />
      <b>NOT CONNECTED</b>
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
