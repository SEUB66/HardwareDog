/**
 * HARDWARE DOG / WHAT WORKS ON THIS DEVICE
 *
 * The browser, the system and the kind of device, as the browser says them,
 * and for each tool whether it works here, checked on the spot (the
 * functions exist or not), with what to use instead when it does not.
 * Nothing leaves the page: this is read, shown, and forgotten.
 */

export type Form = 'phone' | 'tablet' | 'computer';

export interface DeviceInfo {
  browser: string;
  os: string;
  form: Form;
  /** https or localhost: what Web Serial, Bluetooth, the camera and offline need. */
  secure: boolean;
  /** Opened as an installed app. */
  installed: boolean;
}

export type Support = 'YES' | 'PARTIAL' | 'NO' | 'CHECKING';

export interface DeviceCapability {
  id: 'serial' | 'bluetooth' | 'camera' | 'dogd' | 'offline' | 'storage' | 'install' | 'window' | 'demo';
  tool: string;
  state: Support;
  detail: string;
  /** What to use instead, when it does not work here. */
  instead?: string;
}

interface UaData {
  brands?: { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
}

/** What the browser says about itself (no fingerprinting: only names, read once). */
export function deviceInfo(nav: Navigator = navigator, standalone = false, secure = typeof isSecureContext === 'undefined' ? true : isSecureContext): DeviceInfo {
  const ua = nav.userAgent ?? '';
  const data = (nav as Navigator & { userAgentData?: UaData }).userAgentData;
  const touch = (nav.maxTouchPoints ?? 0) > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch);
  const os = ios
    ? /iPhone|iPod/.test(ua)
      ? 'iOS'
      : 'iPadOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : (data?.platform ?? 'unknown system');
  const version = (re: RegExp) => re.exec(ua)?.[1]?.split('.')[0] ?? '';
  const named = (name: string, re: RegExp) => `${name} ${version(re)}`.trim();
  let browser: string;
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = named('Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/);
  else if (/OPR\/|Opera/.test(ua)) browser = named('Opera', /OPR\/([\d.]+)/);
  else if (/SamsungBrowser\//.test(ua)) browser = named('Samsung Internet', /SamsungBrowser\/([\d.]+)/);
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = named('Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/);
  else if (/CriOS\//.test(ua)) browser = named('Chrome', /CriOS\/([\d.]+)/);
  else if (/Chrome\//.test(ua)) browser = named('Chrome', /Chrome\/([\d.]+)/);
  else if (/Safari\//.test(ua)) browser = named('Safari', /Version\/([\d.]+)/);
  else browser = data?.brands?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand))?.brand ?? 'unknown browser';
  // Every browser on iPhone and iPad runs Safari's engine: what Safari cannot do, none of them can.
  if (ios && !/^Safari/.test(browser)) browser += " (Safari's engine)";
  const form: Form = ios ? (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? 'tablet' : 'phone') : data?.mobile || /Mobile/.test(ua) ? 'phone' : /Android/.test(ua) ? 'tablet' : 'computer';
  return { browser, os, form, secure, installed: standalone };
}

/** What the page can see of this browser's functions: given by the caller, so it can be tested. */
export interface DeviceFunctions {
  serial: boolean;
  bluetooth: boolean;
  bluetoothScan: boolean;
  camera: boolean;
  serviceWorker: boolean;
  indexedDb: boolean;
  /** Persistent storage granted (navigator.storage.persisted), when known. */
  persisted: boolean | null;
  installPrompt: boolean;
  documentPip: boolean;
  dogd: 'running' | 'absent' | 'checking';
}

/** The browser's own functions, read here and now. */
export function readFunctions(dogd: DeviceFunctions['dogd'], persisted: boolean | null, installPrompt: boolean): DeviceFunctions {
  const nav = navigator as Navigator & { serial?: unknown; bluetooth?: { requestLEScan?: unknown } };
  let indexedDb = false;
  try {
    indexedDb = !!globalThis.indexedDB;
  } catch {
    indexedDb = false;
  }
  return {
    serial: !!nav.serial,
    bluetooth: !!nav.bluetooth,
    bluetoothScan: !!nav.bluetooth?.requestLEScan,
    camera: !!nav.mediaDevices?.getUserMedia,
    serviceWorker: 'serviceWorker' in nav,
    indexedDb,
    persisted,
    installPrompt,
    documentPip: 'documentPictureInPicture' in globalThis,
    dogd,
  };
}

/** For each tool: works here, partly, or not, and what to use instead. */
export function deviceCapabilities(d: DeviceInfo, f: DeviceFunctions): DeviceCapability[] {
  const apple = d.os === 'iOS' || d.os === 'iPadOS';
  const insecure = 'this page is not https or localhost: the browser keeps it from devices';
  const chromium = !apple && /^(Chrome|Edge|Opera|Samsung Internet)/.test(d.browser);
  const out: DeviceCapability[] = [];
  out.push(
    f.serial && d.secure
      ? { id: 'serial', tool: 'SERIAL CONSOLE · HARDWARE DOG PROBE · FLIPPER LAB (USB)', state: 'YES', detail: 'Web Serial: a board, a probe or a Flipper on USB, picked in the browser\'s chooser' }
      : {
          id: 'serial',
          tool: 'SERIAL CONSOLE · HARDWARE DOG PROBE · FLIPPER LAB (USB)',
          state: 'NO',
          detail: !d.secure ? insecure : apple ? 'no browser on iPhone or iPad has Web Serial (Apple allows only its engine, which has none)' : `${d.browser} has no Web Serial`,
          instead: d.form === 'computer' ? 'Chrome, Edge or Opera on this computer; or dogd, which reads a probe on a serial port' : 'a computer with Chrome, Edge or Opera; the demo works here',
        },
  );
  out.push(
    f.bluetooth && d.secure
      ? {
          id: 'bluetooth',
          tool: 'BLUETOOTH LAB',
          state: f.bluetoothScan ? 'YES' : 'PARTIAL',
          detail: f.bluetoothScan ? 'GATT on a picked device, and scanning' : 'GATT on one picked device; scanning is behind a browser flag (chrome://flags, Experimental Web Platform features)',
          instead: f.bluetoothScan ? undefined : 'dogd on Linux scans every advertiser',
        }
      : {
          id: 'bluetooth',
          tool: 'BLUETOOTH LAB',
          state: 'NO',
          detail: !d.secure
            ? insecure
            : apple
              ? 'no browser on iPhone or iPad has Web Bluetooth'
              : chromium && d.os === 'Linux'
                ? `Web Bluetooth is off in ${d.browser} on Linux (behind chrome://flags, Experimental Web Platform features)`
                : `${d.browser} has no Web Bluetooth`,
          instead: chromium && d.os === 'Linux' ? 'dogd on this computer scans every advertiser (BlueZ); or turn the flag on' : 'Chrome or Edge on a computer or Android; dogd on Linux for scanning; the demo works here',
        },
  );
  out.push(
    f.camera && d.secure
      ? { id: 'camera', tool: 'CAMERA SNIFFER · PHOTOS', state: 'YES', detail: 'the live camera (asked when you open it); a photo file works too' }
      : { id: 'camera', tool: 'CAMERA SNIFFER · PHOTOS', state: 'PARTIAL', detail: !d.secure ? insecure : 'no live camera in this browser', instead: 'ADD A PHOTO FILE (the phone\'s own camera app)' },
  );
  out.push(
    f.dogd === 'running'
      ? { id: 'dogd', tool: 'NETWORK · THIS COMPUTER\'S USB · CAMERA SNIFFER NETWORK', state: 'YES', detail: 'dogd answers on this computer' }
      : f.dogd === 'checking'
        ? { id: 'dogd', tool: 'NETWORK · THIS COMPUTER\'S USB · CAMERA SNIFFER NETWORK', state: 'CHECKING', detail: 'asking dogd on this computer…' }
        : {
            id: 'dogd',
            tool: 'NETWORK · THIS COMPUTER\'S USB · CAMERA SNIFFER NETWORK',
            state: 'NO',
            detail: d.form === 'computer' ? 'dogd does not answer on this computer' : 'dogd runs on a computer, not on a phone or a tablet',
            instead: d.form === 'computer' ? 'start it: dogd serve --source host (packages for Kali, Debian, Ubuntu; docs/INSTALL.md)' : 'open Hardware Dog on the computer that runs dogd',
          },
  );
  out.push(
    f.serviceWorker && d.secure
      ? { id: 'offline', tool: 'OFFLINE', state: 'YES', detail: 'after one visit, the tool opens without a connection' }
      : { id: 'offline', tool: 'OFFLINE', state: 'NO', detail: !d.secure ? insecure : 'this browser keeps no offline copy (a private window often refuses it)', instead: 'keep the tab open; exports work offline' },
  );
  out.push(
    !f.indexedDb
      ? { id: 'storage', tool: 'SESSIONS KEPT IN THIS BROWSER', state: 'NO', detail: 'this browser refuses storage: sessions last until the tab closes', instead: 'export each session (.hdlog, .hdlab)' }
      : f.persisted === false
        ? { id: 'storage', tool: 'SESSIONS KEPT IN THIS BROWSER', state: 'PARTIAL', detail: 'kept, but the browser may evict them when space runs low', instead: 'export what matters; recording real hardware asks the browser to keep them' }
        : { id: 'storage', tool: 'SESSIONS KEPT IN THIS BROWSER', state: 'YES', detail: f.persisted ? 'kept: the browser will not evict them' : 'kept in this browser' },
  );
  out.push(
    d.installed
      ? { id: 'install', tool: 'INSTALL AS AN APP', state: 'YES', detail: 'opened as an installed app' }
      : f.installPrompt
        ? { id: 'install', tool: 'INSTALL AS AN APP', state: 'YES', detail: 'the browser offers it: INSTALL on the home' }
        : apple
          ? { id: 'install', tool: 'INSTALL AS AN APP', state: 'PARTIAL', detail: 'Safari: Share, then Add to Home Screen' }
          : { id: 'install', tool: 'INSTALL AS AN APP', state: 'PARTIAL', detail: 'not offered by this browser now (or already installed): Hardware Dog works the same in a tab' },
  );
  out.push(
    f.documentPip
      ? { id: 'window', tool: 'TV IN ITS OWN WINDOW', state: 'YES', detail: 'always on top, same session' }
      : { id: 'window', tool: 'TV IN ITS OWN WINDOW', state: 'NO', detail: 'no Document Picture-in-Picture in this browser', instead: 'FLOAT: the TV stays on top of the page and follows you' },
  );
  out.push({ id: 'demo', tool: 'DEMO · REPLAY · REPORTS', state: 'YES', detail: 'every screen with simulated data, recordings replayed, reports exported: on any browser' });
  return out;
}
