/**
 * HARDWARE DOG / LAB SESSION MANAGER
 *
 * Start, name, stop a lab session; markers and notes; the sessions kept in
 * this browser; reopening one (read-only). A session is recorded whether
 * or not any lab screen or the TV is showing.
 */

import type { LabBus, LabEvent } from './events';
import { LabRecorder, parseHdlab, toHdlab, type LabSessionData } from './session';
import type { KvBackend } from './store';

export interface StoredLabSession {
  id: string;
  name: string;
  startedAt: number;
  events: number;
  lost: number;
  text: string;
}

export class LabSessions {
  recorder: LabRecorder | null = null;
  stored: StoredLabSession[] = [];
  /** A reopened session, shown read-only. */
  opened: LabSessionData | null = null;
  private listeners = new Set<() => void>();
  private rev = 0;
  private live: (() => void) | null = null;

  constructor(
    private readonly bus: LabBus,
    private readonly kv: KvBackend<StoredLabSession>,
    private readonly app: string,
  ) {}

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

  get persistent(): boolean {
    return this.kv.kind === 'INDEXEDDB';
  }

  async refresh(): Promise<void> {
    this.stored = (await this.kv.all()).sort((a, b) => b.startedAt - a.startedAt);
    this.changed();
  }

  start(name: string): LabRecorder {
    if (this.recorder?.recording) return this.recorder;
    this.recorder = new LabRecorder(this.bus, name, this.app);
    // The count on screen follows the recording, at most a few times a second.
    let pending = false;
    this.live = this.bus.subscribe(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        this.changed();
      }, 250);
    });
    this.changed();
    return this.recorder;
  }

  async stop(): Promise<LabSessionData | null> {
    const r = this.recorder;
    if (!r?.recording) return null;
    const data = r.stop();
    this.live?.();
    this.live = null;
    await this.kv.put(data.header.id, { id: data.header.id, name: data.header.name, startedAt: data.header.startedAt, events: data.events.length, lost: data.footer?.lost ?? 0, text: toHdlab(data) });
    await this.refresh();
    return data;
  }

  rename(name: string): void {
    this.recorder?.rename(name);
    this.changed();
  }

  /** A marker on the timeline: "button pressed", "cable plugged". */
  mark(text: string, kind: 'marker' | 'note' = 'marker'): LabEvent | null {
    const t = text.trim().slice(0, 500);
    if (!t) return null;
    return this.bus.emit({ source: 'USER', tool: 'lab', type: kind, severity: 'INFO', message: t, origin: 'PHYSICAL' });
  }

  async open(id: string): Promise<LabSessionData> {
    const s = await this.kv.get(id);
    if (!s) throw new Error('no such session');
    return this.openText(s.text);
  }

  openText(text: string): LabSessionData {
    this.opened = parseHdlab(text);
    this.changed();
    return this.opened;
  }

  close(): void {
    this.opened = null;
    this.changed();
  }

  async remove(id: string): Promise<void> {
    await this.kv.remove(id);
    await this.refresh();
  }

  async text(id: string): Promise<string> {
    const s = await this.kv.get(id);
    if (!s) throw new Error('no such session');
    return s.text;
  }
}
