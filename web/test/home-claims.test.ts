import { describe, expect, it } from 'vitest';
import { REPORT_FORMATS } from '../src/core/commands';
import { milliamps, ms, percent, volts } from '../src/core/format';
import type { DeviceFrame } from '../src/core/protocol';
import { SCENARIOS, SCENARIO_IDS, type ScenarioId } from '../src/core/scenarios';
import { parseHdlog } from '../src/core/session';
import { sha256 } from '../src/core/sha256';
import { RULES, System, memoryStore } from '../src/core/system';
import type { Transport, TransportSink } from '../src/core/transport';

/**
 * THE HOME PAGE SAYS WHAT THE TOOL DOES (web/index.html)
 *
 * Every number, every screen and every example the page shows comes from
 * the code or from a file of this repository. When the tool changes, the
 * page has to follow, or this fails.
 */

const pages = import.meta.glob('../index.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const page = pages['../index.html']!;
const src = import.meta.glob(['../src/ui/Boot.tsx', '../src/ui/App.tsx', '../src/ui/screens/Status.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const cases = import.meta.glob('../../cases/*/*.case.json', { import: 'default', eager: true }) as Record<string, { id: string; recording: { sha256: string }; expect: { facts: Record<string, number>; diagnoses: { id: string; confidence: string; evidence: number[] }[] } }>;
const C017 = Object.values(import.meta.glob('../../cases/power/HD-C017.hdlog', { query: '?raw', import: 'default', eager: true }))[0] as string;
const c017 = Object.entries(cases).find(([p]) => p.endsWith('HD-C017.case.json'))![1];

/** Text of the page between two markers, tags removed, entities decoded. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const block = (start: string, end: string) => {
  const from = page.indexOf(start);
  expect(from, start).toBeGreaterThan(0);
  return page.slice(from, page.indexOf(end, from));
};

describe('the home page says what the tool does', () => {
  it('its terminal prints what the tool prints when it opens, rule count included', async () => {
    const lines = [...block('<pre class="crt-boot">', '</pre>').matchAll(/<span[^>]*>(.*?)<\/span>/g)].map((m) => text(m[1]!).trim());
    const steps = await new System(memoryStore(), () => 0).start(() => {}, 0);
    const boot = steps.map((s) => `${s.status === 'OK' ? '[ OK ]' : `[${s.status}]`} ${s.label}${s.detail ? `  ${s.detail}` : ''}`);
    expect(lines.slice(0, 1 + boot.length)).toEqual(['INITIALIZING...', ...boot]);
    expect(boot.join('\n')).toContain(`DIAGNOSTIC RULES  ${RULES.length} loaded`);
    // the end of the boot screen with nothing connected (ui/Boot.tsx)
    const tail = lines.slice(1 + boot.length);
    expect(src['../src/ui/Boot.tsx']).toContain(`${tail.slice(0, 4).join('\\n')}\\n`);
    expect(src['../src/ui/Boot.tsx']).toContain(`'${tail[4]}'`);
  });

  it('its shortcuts are the tool’s', () => {
    const keys = text(block('<ul class="mod-screen keys"', '</ul>'));
    for (const k of ['F1HELP', 'F2TRACE', 'F3PROBE', 'F4REPORT', '1-7SCREENS', 'CTRL KCOMMAND']) expect(keys).toContain(k);
    const app = src['../src/ui/App.tsx']!;
    expect(app).toContain("{ F1: 'HELP', F2: 'TRACE', F3: 'PROBE', F4: 'REPORT' }");
    expect(app).toContain('/^[1-7]$/');
    expect(app).toContain("ctrl && key === 'k'");
  });

  it('its eight readings are the STATUS screen’s, at the moment it names in HD-C017', async () => {
    const card = block('<div class="mod-screen gauges">', '</div>\n    </article>');
    const shown = Object.fromEntries([...card.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map((m) => [m[1]!, m[2]!]));
    expect(card).toContain('STATUS · HD-C017 · t+9.100 s · SIMULATED');
    const status = src['../src/ui/screens/Status.tsx']!;
    for (const label of ['VOLTAGE', 'CURRENT', 'LINK', 'DHCP', 'DNS', 'LATENCY', 'LOSS']) expect(status).toContain(`['${label}'`);
    expect(status).toContain("label={usb.connected ? 'CONNECTED' : 'DISCONNECTED'}");

    // HD-C017 played up to t+9.100 s, the last sample before the drop
    const frames = parseHdlog(C017)
      .entries.flatMap((e) => ('frame' in e ? [e.frame] : []))
      .filter((f) => !('t' in f) || (f as { t: number }).t <= 9100);
    const upTo: Transport = {
      kind: 'SIMULATOR',
      origin: 'SIMULATED',
      label: 'HD-C017',
      async open(sink: TransportSink) {
        for (const f of frames) sink.frame(f as DeviceFrame);
      },
      send() {},
      async close() {},
    };
    const sys = new System(memoryStore(), () => 0);
    expect(await sys.connect(upTo)).toBe(true);
    expect(shown).toEqual({
      VOLTAGE: volts(sys.power.voltage),
      CURRENT: milliamps(sys.power.current),
      USB: sys.usb.connected ? 'CONNECTED' : 'DISCONNECTED',
      LINK: sys.net.link?.up ? 'UP' : 'DOWN',
      DHCP: sys.net.dhcp,
      DNS: sys.net.dns.status,
      LATENCY: ms(sys.net.latencyMs),
      LOSS: percent(sys.net.packetLoss),
    });
    await sys.disconnect();
  });

  it('its incident is HD-C017 as the engine reads it', () => {
    const lines = C017.split('\n');
    const frame = (n: number) => JSON.parse(lines[n - 1]!).frame as Record<string, unknown> & { t: number };
    const drop = frame(475);
    const detach = frame(480);
    const down = frame(493);
    expect([drop.type, drop.v, drop.i]).toEqual(['power', 4.603, 0.7261]);
    expect(detach.type).toBe('usb.detach');
    expect([down.type, (down.link as { up: boolean }).up]).toEqual(['net.status', false]);
    const incident = text(block('<div class="incident" id="timeline">', '</section>'));
    expect(incident).toContain(`▼ ${drop.v} V · ${(drop.i as number).toFixed(3)} A`);
    expect(incident).toContain(`DETACH +${detach.t - drop.t} ms`);
    expect(incident).toContain(`LINK DOWN +${down.t - drop.t} ms`);
    expect(incident).toContain(`l’USB décroche ${detach.t - drop.t} ms plus tard, le réseau tombe à ${down.t - drop.t} ms`);
    const { facts, diagnoses } = c017.expect;
    expect(incident).toContain(`${facts['disconnectsAfterDrop']} of ${facts['usbDisconnects']} USB disconnects followed a voltage drop.`);
    const power = diagnoses.find((d) => d.id === 'POWER_INSTABILITY')!;
    expect(incident).toContain(`CONFIDENCE ${power.confidence}`);
    for (const ref of [474, 479, 492]) expect(diagnoses.some((d) => d.evidence.includes(ref)), `#${ref}`).toBe(true);
    expect(incident).toContain('POWER_INSTABILITY · NETWORK_POWER_LOSS');
    expect(diagnoses.map((d) => d.id)).toEqual(['POWER_INSTABILITY', 'NETWORK_POWER_LOSS']);
  });

  it('its .hdlog excerpt is the real file, seal and hash included', () => {
    const r = parseHdlog(C017);
    const f = r.integrity!.footer!;
    const excerpt = block('<figure class="file">', '</figure>');
    expect(text(excerpt)).toContain(`${Math.round(C017.length / 1024)} KB · ${f.frames} FRAMES · ${((f.endedAt - f.startedAt) / 1000).toFixed(1)} s`);
    expect(r.integrity!.status).toBe('VERIFIED');
    expect(excerpt).toContain(r.integrity!.fileSha256);
    expect(c017.recording.sha256).toBe(sha256(C017));
    const lines = C017.trimEnd().split('\n');
    for (const [, n, shown] of excerpt.matchAll(/<span class="ln" aria-hidden="true">(\d+)<\/span><code>(.*?)<\/code>/g)) {
      const visible = text(shown!);
      const line = lines[Number(n) - 1]!;
      // shown as written, in order; "…" marks every cut
      let at = 0;
      for (const part of visible.split('…').map((p) => p.replace(/^,|,$/g, ''))) {
        const found = line.indexOf(part, at);
        expect(found, `line ${n}: ${part}`).toBeGreaterThanOrEqual(at);
        at = found + part.length;
      }
      if (!visible.includes('…')) expect(visible).toBe(line);
    }
  });

  it('its case count and demos exist', () => {
    expect(text(page)).toContain(`cases/ · ${Object.keys(cases).length} CASES`);
    const demos = [...page.matchAll(/href="\.\/diagnostic\.html\?scenario=(HD-T\d{3})">DEMO \/\/ (HD-T\d{3}) ([^<↗]+?) ↗/g)];
    expect(demos.length).toBeGreaterThanOrEqual(8);
    for (const [, linked, named, title] of demos) {
      expect(named).toBe(linked);
      expect(SCENARIO_IDS).toContain(linked);
      expect(SCENARIOS[linked as ScenarioId].title.startsWith(title!.trim()), `${linked}: ${title}`).toBe(true);
    }
  });

  it('its report formats are the tool’s', () => {
    expect(page).toContain('Rapports TXT, JSON, HTML et PDF');
    expect([...REPORT_FORMATS]).toEqual(['txt', 'json', 'html', 'pdf']);
  });
});
