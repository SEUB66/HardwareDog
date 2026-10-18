/**
 * HARDWARE DOG / HOME
 *
 * Nothing connected: the brand banners, the dog's TV, one line on what
 * this is, the tools one tap away with what this device can really do, and the start
 * guide folded underneath. Three states are kept apart, never summed up
 * as one "OFFLINE": a device (none connected yet), dogd (running on this
 * computer or not) and this browser's network (which Hardware Dog does
 * not need once loaded). When a session runs, STATUS shows it instead:
 * nothing here pushes the instrument down.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Screen } from '../../core/commands';
import { bluetoothApi } from '../../core/ble/webbt';
import { dogdHealth } from '../../core/dogd';
import type { Lang } from '../../core/lab/rules';
import { webSerialSupported } from '../../core/webserial';
import { BannerCarousel } from '../brand/BannerCarousel';
import { HOME_SLIDES } from '../brand/slides';
import { Icon } from '../components/Icon';

export type DogdState = 'checking' | 'running' | 'absent';

interface HomeProps {
  lang: Lang;
  reducedMotion: boolean;
  /** Sessions kept in this browser. */
  sessions: number;
  onConsole: () => void;
  onNetwork: () => void;
  onProbe: () => void;
  onDogd: () => void;
  onOpen: (file: File) => void;
  onDemo: () => void;
  onTour: () => void;
  onGo: (s: Screen) => void;
  /** A fault to show first (a source that failed). */
  children?: ComponentChildren;
  /** The companion's TV, in its place on the home. */
  tv?: ComponentChildren;
}

type T = Record<Lang, string>;
const t = (x: T, lang: Lang) => x[lang];

const TEXT = {
  tagline: {
    en: 'YOUR HARDWARE. YOUR TOOLS. YOUR RULES.',
    fr: 'VOTRE MATÉRIEL. VOS OUTILS. VOS RÈGLES.',
  },
  values: {
    en: 'Local-first. No account. No subscription.',
    fr: 'Local d’abord. Sans compte. Sans abonnement.',
  },
  privacy: {
    en: 'Your diagnostics stay on your machine. You control the export.',
    fr: 'Vos diagnostics restent sur votre machine. Vous contrôlez l’export.',
  },
  banners: {
    en: 'Hardware Dog: what it stands for',
    fr: 'Hardware Dog : ses valeurs',
  },
  tools: { en: 'TOOLS', fr: 'OUTILS' },
  sources: { en: 'Other sources', fr: 'Autres sources' },
  demo: { en: 'TRY THE DEMO', fr: 'ESSAYER LA DÉMO' },
} satisfies Record<string, T>;

/** Is dogd answering on this computer? Asked when the home opens, and on request. */
function useDogd(): [DogdState, string | null, () => void] {
  const [state, setState] = useState<DogdState>('checking');
  const [version, setVersion] = useState<string | null>(null);
  const ask = () => {
    setState('checking');
    dogdHealth().then(
      (h) => {
        setVersion(h.dogd);
        setState('running');
      },
      () => setState('absent'),
    );
  };
  useEffect(ask, []);
  return [state, version, ask];
}

function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

interface CardProps {
  icon: string;
  title: string;
  text: string;
  /** What this device can do for it, said plainly. */
  can: { ok: boolean | null; text: string };
  children: ComponentChildren;
  tone?: 'pink' | 'cyan';
}

function ToolCard({ icon, title, text, can, children, tone = 'cyan' }: CardProps) {
  return (
    <article class={`tool-card tone-${tone}`}>
      <header class="tool-head">
        <span class="tool-icon" aria-hidden="true">
          <Icon name={icon} size={22} />
        </span>
        <h3 class="tool-title">{title}</h3>
      </header>
      <p class="tool-text">{text}</p>
      <p class={`tool-can ${can.ok === true ? 'ok' : can.ok === false ? 'no' : 'unknown'}`}>
        <span class="tool-can-mark" aria-hidden="true">
          {can.ok === true ? '●' : can.ok === false ? '○' : '◌'}
        </span>{' '}
        {can.text}
      </p>
      <div class="tool-actions">{children}</div>
    </article>
  );
}

export function Home({ lang, reducedMotion, sessions, onConsole, onNetwork, onProbe, onDogd, onOpen, onDemo, onTour, onGo, children, tv }: HomeProps) {
  const file = useRef<HTMLInputElement>(null);
  const [dogd, dogdVersion, askDogd] = useDogd();
  const online = useOnline();
  const serial = webSerialSupported();
  const bluetooth = bluetoothApi() !== null;
  const fr = lang === 'fr';
  const demoBtn = (
    <button class="btn demo-btn" onClick={onDemo}>
      {t(TEXT.demo, lang)}
    </button>
  );
  const serialNo = fr ? 'Web Serial absent ici : il faut Chrome ou Edge sur un ordinateur.' : 'No Web Serial here: it needs Chrome or Edge on a computer.';
  const dogdText =
    dogd === 'running'
      ? fr
        ? `dogd tourne sur cet ordinateur${dogdVersion ? ` (v${dogdVersion})` : ''}.`
        : `dogd is running on this computer${dogdVersion ? ` (v${dogdVersion})` : ''}.`
      : dogd === 'absent'
        ? fr
          ? 'dogd ne répond pas sur cet ordinateur : lancez « dogd serve --source host » (docs/DOGD.md).'
          : 'dogd does not answer on this computer: start “dogd serve --source host” (docs/DOGD.md).'
        : fr
          ? 'dogd : vérification…'
          : 'dogd: checking…';

  return (
    <div class="home">
      {children}
      <div class="home-top">
        <BannerCarousel slides={HOME_SLIDES} label={t(TEXT.banners, lang)} lang={lang} reducedMotion={reducedMotion} priority sizes="(max-width: 1099px) 100vw, 58vw" class="home-banners" />

        {tv && <div class="home-tv">{tv}</div>}
        <section class="home-hero" aria-labelledby="home-tagline">
          <h1 id="home-tagline" class="home-tagline">
            {t(TEXT.tagline, lang)}
          </h1>
          <p class="home-values">{t(TEXT.values, lang)}</p>
          <p class="home-privacy">{t(TEXT.privacy, lang)}</p>
        </section>

        <ul class="home-states" aria-label={fr ? 'États' : 'States'}>
          <li class="home-state">
            <span class="home-state-k">{fr ? 'APPAREIL' : 'DEVICE'}</span>
            <span class="home-state-v unknown">{fr ? 'aucun connecté' : 'none connected'}</span>
          </li>
          <li class="home-state">
            <span class="home-state-k">DOGD</span>
            <span class={`home-state-v ${dogd === 'running' ? 'ok' : dogd === 'absent' ? 'warn' : 'unknown'}`}>
              {dogd === 'running' ? (fr ? 'en marche' : 'running') : dogd === 'absent' ? (fr ? 'absent sur cet ordinateur' : 'not on this computer') : fr ? 'vérification…' : 'checking…'}
            </span>
            {dogd !== 'checking' && (
              <button class="link home-state-act" onClick={askDogd}>
                {fr ? 'revérifier' : 'check again'}
              </button>
            )}
          </li>
          <li class="home-state">
            <span class="home-state-k">{fr ? 'NAVIGATEUR' : 'BROWSER'}</span>
            <span class={`home-state-v ${online ? 'ok' : 'warn'}`}>
              {online ? (fr ? 'en ligne' : 'online') : fr ? 'hors ligne : l’outil chargé fonctionne' : 'offline: what is loaded keeps working'}
            </span>
          </li>
        </ul>
      </div>

      <section class="home-tools" aria-labelledby="home-tools-title">
        <h2 id="home-tools-title" class="home-h2">
          {t(TEXT.tools, lang)}
        </h2>
        <div class="tool-grid">
          <ToolCard
            icon="SERIAL"
            tone="pink"
            title="SERIAL CONSOLE"
            text={fr ? 'La console série de n’importe quelle carte : Arduino, ESP32, routeur. Sans sonde.' : 'The serial console of any board: Arduino, ESP32, a router. No probe needed.'}
            can={
              serial
                ? {
                    ok: true,
                    text: fr ? 'Web Serial disponible sur ce navigateur.' : 'Web Serial available in this browser.',
                  }
                : { ok: false, text: serialNo }
            }
          >
            <button class="btn primary" onClick={onConsole} disabled={!serial}>
              {fr ? 'OUVRIR LA CONSOLE' : 'OPEN THE CONSOLE'}
            </button>
            {!serial && demoBtn}
          </ToolCard>

          <ToolCard
            icon="NET"
            title={fr ? 'RÉSEAU · USB' : 'NETWORK · USB'}
            text={
              fr
                ? 'Le réseau de cet ordinateur (lien, DHCP, passerelle, DNS, Internet) et ses périphériques USB, par dogd.'
                : 'This computer’s network (link, DHCP, gateway, DNS, Internet) and its USB devices, through dogd.'
            }
            can={{
              ok: dogd === 'running' ? true : dogd === 'absent' ? false : null,
              text: dogdText,
            }}
          >
            <button class="btn primary" onClick={onNetwork} disabled={dogd !== 'running'}>
              {fr ? 'SURVEILLER CET ORDINATEUR' : 'WATCH THIS COMPUTER'}
            </button>
            {dogd === 'absent' && demoBtn}
          </ToolCard>

          <ToolCard
            icon="BLE"
            title="BLUETOOTH LAB"
            text={fr ? 'Scanner, inspecter et lire les appareils Bluetooth LE autour de vous.' : 'Scan, inspect and read the Bluetooth LE devices around you.'}
            can={{
              ok: bluetooth || dogd === 'running',
              text: bluetooth
                ? fr
                  ? 'Web Bluetooth disponible ; la démo aussi.'
                  : 'Web Bluetooth available; the demo too.'
                : dogd === 'running'
                  ? fr
                    ? 'Pas de Web Bluetooth ici ; scan par dogd possible (Linux) ; démo.'
                    : 'No Web Bluetooth here; dogd can scan (Linux); demo.'
                  : fr
                    ? 'Pas de Web Bluetooth ici (Chrome ou Edge) : la démo marche partout.'
                    : 'No Web Bluetooth here (Chrome or Edge): the demo works anywhere.',
            }}
          >
            <button class="btn primary" onClick={() => onGo('BLE')}>
              {fr ? 'OUVRIR BLUETOOTH LAB' : 'OPEN BLUETOOTH LAB'}
            </button>
          </ToolCard>

          <ToolCard
            icon="FLIPPER"
            title="FLIPPER LAB"
            text={fr ? 'Fichiers, captures et infos d’un Flipper Zero en USB, avec la TV compagnon.' : 'Files, captures and info of a Flipper Zero over USB, with the companion TV.'}
            can={
              serial
                ? {
                    ok: true,
                    text: fr ? 'USB (Web Serial) disponible ; un Flipper de démo aussi.' : 'USB (Web Serial) available; a demo Flipper too.',
                  }
                : {
                    ok: false,
                    text: fr ? 'Pas de Web Serial ici : le Flipper de démo marche partout.' : 'No Web Serial here: the demo Flipper works anywhere.',
                  }
            }
          >
            <button class="btn primary" onClick={() => onGo('FLIPPER')}>
              {fr ? 'OUVRIR FLIPPER LAB' : 'OPEN FLIPPER LAB'}
            </button>
          </ToolCard>

          <ToolCard
            icon="CAMERA"
            tone="pink"
            title="CAMERA SNIFFER"
            text={fr ? 'Des indices de caméras : réseau, Bluetooth, USB, objets à inspecter, rapport.' : 'Clues of cameras: network, Bluetooth, USB, objects to inspect, a report.'}
            can={{
              ok: true,
              text:
                dogd === 'running'
                  ? fr
                    ? 'Catalogue et inspection hors ligne ; découverte réseau par dogd.'
                    : 'Offline catalog and inspection; network discovery through dogd.'
                  : fr
                    ? 'Catalogue et inspection hors ligne ; réseau de démo sans dogd.'
                    : 'Offline catalog and inspection; a demo network without dogd.',
            }}
          >
            <button class="btn primary" onClick={() => onGo('CAMERA')}>
              {fr ? 'OUVRIR CAMERA SNIFFER' : 'OPEN CAMERA SNIFFER'}
            </button>
          </ToolCard>

          <ToolCard
            icon="RECORDING"
            title={fr ? 'SESSIONS · RELECTURE' : 'SESSIONS · REPLAY'}
            text={fr ? 'Rejouer un enregistrement (.hdlog), en lecture seule, ou une session gardée dans ce navigateur.' : 'Replay a recording (.hdlog), read-only, or a session kept in this browser.'}
            can={{
              ok: true,
              text: fr ? `${sessions} session(s) gardée(s) dans ce navigateur.` : `${sessions} session(s) kept in this browser.`,
            }}
          >
            <button class="btn primary" onClick={() => file.current?.click()}>
              {fr ? 'OUVRIR UN FICHIER' : 'OPEN A RECORDING'}
            </button>
            <button class="btn" onClick={() => onGo('SETUP')}>
              {fr ? 'SESSIONS GARDÉES' : 'SAVED SESSIONS'}
            </button>
          </ToolCard>
        </div>

        <div class="home-sources">
          <span class="home-sources-k">{t(TEXT.sources, lang)}</span>
          <button class="btn" onClick={onProbe} disabled={!serial} title={serial ? undefined : serialNo}>
            <Icon name="WEB_SERIAL" size={15} /> {fr ? 'SONDE HARDWARE DOG' : 'HARDWARE DOG PROBE'}
          </button>
          <button class="btn" onClick={onDogd}>
            <Icon name="DOGD" size={15} /> {fr ? 'CONNECTER DOGD' : 'CONNECT DOGD'}
          </button>
          <button class="btn demo-btn" onClick={onDemo}>
            <Icon name="DEMO" size={15} /> {fr ? 'MODE DÉMO (SIMULÉ)' : 'DEMO MODE (SIMULATED)'}
          </button>
        </div>
      </section>

      <details class="home-guide">
        <summary>{fr ? 'Guide de démarrage · ce que fait Hardware Dog' : 'Start guide · what Hardware Dog does'}</summary>
        <div class="home-guide-body">
          <p>
            {fr
              ? 'Hardware Dog lit ce que dit votre matériel, le met sur une seule ligne de temps, et dit ce qui a mal tourné. Pas besoin de sonde pour commencer : la console série d’une carte, ou cet ordinateur (son réseau, ses périphériques USB) par dogd. Une sonde Hardware Dog ajoute l’alimentation, l’USB, l’I2C et le réseau de la carte elle-même.'
              : 'Hardware Dog reads what your hardware says, puts it on one timeline, and tells you what went wrong. No probe needed to start: a board’s serial console, or this computer (its network, its USB devices) through dogd. A Hardware Dog probe adds the power, USB, I2C and network of the board itself.'}
          </p>
          <ol class="start-steps">
            <li>
              <b>{fr ? 'Branchez' : 'Plug in'}</b>{' '}
              {fr
                ? 'une carte avec un port série USB (Arduino, ESP32, adaptateur USB-UART), ou surveillez cet ordinateur.'
                : 'a board with a USB serial port (Arduino, ESP32, a USB-UART adapter), or watch this computer.'}
            </li>
            <li>
              <b>{fr ? 'Observez' : 'Watch'}</b>{' '}
              {fr
                ? 'en direct : redémarrages, plantages, mauvais débit ; lien, DHCP, passerelle, DNS, Internet ; USB qui décroche.'
                : 'it live: resets, crashes, wrong baud rate; link, DHCP, gateway, DNS, Internet; USB devices that drop.'}
            </li>
            <li>
              <b>{fr ? 'Lisez' : 'Read'}</b> {fr ? 'le diagnostic : ce qui s’est passé, avec quelle certitude, quoi vérifier ensuite.' : 'the diagnosis: what happened, how sure, what to check next.'}
            </li>
          </ol>
          <p class="dim">
            {fr
              ? 'Où vont les données : le navigateur garde les réglages et les sessions (stockage local de cet appareil) ; dogd, s’il tourne, garde les siennes sur cet ordinateur. Vos diagnostics ne sont envoyés nulle part : un export est un fichier que vous téléchargez. Les tests réseau que vous lancez contactent les hôtes testés.'
              : 'Where data goes: this browser keeps settings and sessions (this device’s local storage); dogd, when it runs, keeps its own on this computer. Your diagnostics are sent nowhere: an export is a file you download. Network tests you start do reach the hosts they test.'}
          </p>
          <button class="btn" onClick={onTour}>
            {fr ? 'VISITE GUIDÉE' : 'TAKE THE TOUR'}
          </button>
        </div>
      </details>

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
