/**
 * HARDWARE DOG / INSTALL AND UPDATE
 *
 * The page's side of the service worker (web/sw/service-worker.js):
 *
 *   REGISTER   in a production build served over HTTPS (or localhost):
 *              after one visit, the interface opens offline
 *   UPDATE     a new version installs in the background and waits; the
 *              interface says it is ready, and the person reloads when
 *              nothing is running (no scan, transfer or recording is ever
 *              cut by an update); the worker is asked again every hour.
 *              Another tab may start the new version first: this one then
 *              says it still runs the previous one, and RELOAD reloads. A
 *              new version that does not take over within 10 s is said,
 *              and RELOAD can be pressed again
 *   INSTALL    where the browser offers installation (beforeinstallprompt),
 *              a button opens the browser's own prompt; on iPhone and iPad,
 *              where no such prompt exists, a line says how (Share, Add to
 *              Home Screen). Hardware Dog works the same without installing
 *
 * No request leaves this site here: the worker file is the site's own.
 */

export type InstallState = 'available' | 'ios' | 'installed' | 'none';

interface PromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const HOUR = 3_600_000;
/** How long a new version may take to take over after RELOAD before that is said. */
export const TAKEOVER_MS = 10_000;

export class Pwa {
  /** A new version is installed and waiting for a reload. */
  update = false;
  /** Another tab started the new version: this page still runs the previous one. */
  elsewhere = false;
  /** RELOAD was pressed and the new version did not take over in time. */
  stalled = false;
  install: InstallState = 'none';
  private registration: ServiceWorkerRegistration | null = null;
  private deferred: PromptEvent | null = null;
  private reloading = false;
  private takeover: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private rev = 0;

  constructor(private readonly reload: () => void = () => location.reload()) {}

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get revision(): number {
    return this.rev;
  }
  private changed(): void {
    this.rev++;
    for (const l of [...this.listeners]) l();
  }

  /** Running as an installed app (its own window, or a home-screen icon on iOS). */
  static standalone(): boolean {
    if (typeof window === 'undefined') return false;
    return (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  }

  /** iPhone, iPad (an iPad says it is a Mac with a touch screen). */
  static ios(ua: string, platform: string, touchPoints: number): boolean {
    return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
  }

  /** Start: listen for the browser's install offer, register the worker where it may run. */
  start(production: boolean): void {
    if (typeof window === 'undefined') return;
    if (Pwa.standalone()) this.install = 'installed';
    else if (Pwa.ios(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) this.install = 'ios';
    window.addEventListener('beforeinstallprompt', (e) => {
      // Kept for the INSTALL button; the browser's own install entry stays where it is.
      e.preventDefault();
      this.deferred = e as PromptEvent;
      this.install = 'available';
      this.changed();
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.install = 'installed';
      this.changed();
    });
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!production || !secure || !('serviceWorker' in navigator)) return;
    // A worker taking over a page that had one is a new version: asked here, or by another tab.
    let controlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      this.takenOver(controlled);
      controlled = true;
    });
    void navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        this.registration = reg;
        const waiting = () => {
          if (reg.waiting && navigator.serviceWorker.controller) {
            this.update = true;
            this.changed();
          }
        };
        waiting();
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          next?.addEventListener('statechange', () => next.state === 'installed' && waiting());
        });
        setInterval(() => void reg.update().catch(() => {}), HOUR);
      })
      .catch(() => {
        // No worker (private window, storage refused): the interface works online as before.
      });
  }

  private takenOver(hadController: boolean): void {
    if (this.reloading) {
      if (this.takeover !== null) clearTimeout(this.takeover);
      this.reload();
      return;
    }
    // The first visit's worker claiming the page is no update.
    if (!hadController) return;
    this.update = false;
    this.elsewhere = true;
    this.changed();
  }

  /** The person asked for the new version: the waiting worker takes over, then the page reloads once. */
  applyUpdate(): void {
    if (this.reloading) return;
    const waiting = this.registration?.waiting;
    // Already started (by another tab), or gone: a reload is all that is left to do.
    if (!waiting) {
      this.reloading = true;
      this.reload();
      return;
    }
    this.reloading = true;
    this.stalled = false;
    this.changed();
    waiting.postMessage('hwdog:activate');
    this.takeover = setTimeout(() => {
      this.reloading = false;
      this.stalled = true;
      this.changed();
    }, TAKEOVER_MS);
  }

  /** The person put the install offer away (remembered by the caller). */
  dismissInstall(): void {
    this.install = 'none';
    this.changed();
  }

  /** The browser's own install prompt, opened by a person's click. */
  async promptInstall(): Promise<void> {
    const e = this.deferred;
    if (!e) return;
    this.deferred = null;
    await e.prompt();
    const { outcome } = await e.userChoice;
    this.install = outcome === 'accepted' ? 'installed' : 'none';
    this.changed();
  }
}

/** Why an update must wait, or null when a reload cuts nothing. */
export function updateBlocker(s: { operations: number; recording: boolean; labRecording: boolean }): string | null {
  if (s.operations > 0) return 'an operation is running (scan, transfer, inspection)';
  if (s.recording) return 'a session is connected and recording';
  if (s.labRecording) return 'a lab session is recording';
  return null;
}

export const pwa = new Pwa();
