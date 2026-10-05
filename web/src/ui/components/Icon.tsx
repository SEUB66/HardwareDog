import type { Screen } from '../../core/commands';

/** Line icons, 24 x 24, drawn with the current text color. */
const PATHS: Record<string, string> = {
  STATUS: 'M3 12h4l2-6 4 12 2-6h6',
  TRACE: 'M4 6h16M4 12h10M4 18h13',
  POWER: 'M13 2 5 13h6l-1 9 8-11h-6z',
  USB: 'M12 3v14M12 3l-2.5 3h5zM12 11l-4-2v-3M12 13l4-2V8.5M10 20a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
  SERIAL: 'M4 5h16v14H4zM7 10l3 2-3 2M12 15h5',
  BUS: 'M3 8h18M3 16h18M7 8v8M12 8v8M17 8v8',
  NET: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  PROBE: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
  REPORT: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  SETUP: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  HELP: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14M12 17.5v.5',
  MORE: 'M5 12h.01M12 12h.01M19 12h.01',
  TOUR: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
  WEB_SERIAL: 'M7 7h10v6a5 5 0 0 1-10 0zM10 3v4M14 3v4M12 18v3',
  DOGD: 'M4 5h16v10H4zM8 19h8M12 15v4',
  RECORDING: 'M5 4h10l4 4v12H5zM10 11v6l5-3z',
  DEMO: 'M6 4l14 8-14 8z',
};

/** What each section is for, in a few words: the menu explains itself. */
export const SCREEN_PURPOSE: Record<Screen, string> = {
  STATUS: 'the whole picture, now',
  TRACE: 'every event, in order',
  POWER: 'supply voltage and current',
  USB: 'the device on the cable',
  SERIAL: 'the target console (UART)',
  BUS: 'I2C chips on the board',
  NET: 'the network, layer by layer',
  PROBE: 'run network tests',
  REPORT: 'what was found, to share',
  SETUP: 'sources, sessions, settings',
  HELP: 'keys, commands, words',
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
