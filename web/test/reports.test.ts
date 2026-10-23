import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_COLUMNS, linesToPdf, pdfString, wrapLine } from '../src/core/pdf';
import { buildReport, reportToText, timelineExcerpt } from '../src/core/report';
import { reportToHtml, reportToPdf } from '../src/core/reportFormats';
import type { DeviceFrame } from '../src/core/protocol';
import type { TraceEvent } from '../src/core/types';
import { attach, connectedSystem, recordSession } from './helpers';

/** Every line of text a real PDF reader (pdf.js) finds, page by page. */
async function pdfText(bytes: Uint8Array): Promise<{ pages: number; lines: string[] }> {
  const doc = await getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // pdf.js splits a line at spaces; hasEOL marks where a line ends.
    for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
    text += '\n';
  }
  return { pages: doc.numPages, lines: text.split('\n') };
}

describe('LVL 75: professional reports', () => {
  it('the timeline excerpt is the evidence, with context, and says what it left out', () => {
    const ev = (id: number, source: TraceEvent['source'], message: string, seq?: number): TraceEvent => ({
      id,
      t: 1_000 + id,
      source,
      severity: 'INFO',
      message,
      ...(seq !== undefined ? { seq } : {}),
    });
    const events = Array.from({ length: 30 }, (_, k) => ev(k, 'POWER', `sample ${k}`, k + 1));
    const x = timelineExcerpt(events, [{ evidence: [11] } as never]);
    expect(x.basis).toBe('EVIDENCE');
    expect(x.entries.map((e) => e.message)).toEqual(['sample 8', 'sample 9', 'sample 10', 'sample 11', 'sample 12']);
    expect(x.entries.filter((e) => e.evidence).map((e) => e.seq)).toEqual([11]);
    expect(x.omitted).toBe(25);
    expect(timelineExcerpt([], []).basis).toBe('EMPTY');
  });

  it('a long excerpt keeps the first incidents and the latest, and counts the middle', () => {
    const events: TraceEvent[] = Array.from({ length: 400 }, (_, k) => ({ id: k, t: 1_000 + k, source: 'USB', severity: 'WARN', message: `detach ${k}`, seq: k + 1 }));
    const x = timelineExcerpt(events, [{ evidence: events.filter((_, k) => k % 10 === 0).map((e) => e.seq!) } as never], 60);
    expect(x.entries).toHaveLength(60);
    expect(x.entries[0]!.message).toBe('detach 0');
    expect(x.entries.at(-1)!.message).toBe('detach 392'); // the latest incident and its context
    expect(x.entries.filter((e) => e.gapAfter).length).toBe(1);
  });

  it('a real incident: the report carries the timeline of the diagnosis', async () => {
    const { sys } = await recordSession('HD-T001', 40);
    const r = buildReport(sys);
    expect(r.diagnoses.length).toBeGreaterThan(0);
    expect(r.timeline.basis).toBe('EVIDENCE');
    expect(r.timeline.entries.some((e) => e.evidence && e.message === 'voltage drop')).toBe(true);
    const text = reportToText(r);
    expect(text).toContain('TIMELINE EXCERPT');
    expect(text).toMatch(/^> \d\d:\d\d:\d\d\.\d{3}  POWER WARN  voltage drop/m);
  });

  it('PDF: a real reader opens it and finds every line of the TXT report', async () => {
    const { sys } = await recordSession('HD-T001', 40);
    const r = buildReport(sys);
    const bytes = reportToPdf(r);
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 8))).toBe('%PDF-1.4');
    const { pages, lines } = await pdfText(bytes);
    expect(pages).toBeGreaterThanOrEqual(2);
    const all = lines.join('\n');
    expect(all).toContain('HARDWARE DOG / DIAGNOSTIC REPORT');
    expect(all).toContain(`PAGE 1 / ${pages}`);
    expect(all).toContain('SIMULATED DATA. NOT A MEASUREMENT OF REAL HARDWARE.');
    expect(all).toContain('DIAGNOSTIC MEASUREMENT, NOT CERTIFIED METROLOGY.');
    // Same words as the TXT: every non-empty TXT line is in the PDF (wrapped lines rejoined).
    const pdfFlat = lines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
    for (const line of reportToText(r, { banner: false }).split('\n').filter((l) => l.trim() !== '')) {
      expect(pdfFlat, line).toContain(line.trim().replace(/\s+/g, ' '));
    }
  });

  it('PDF: same report, same bytes; characters outside WinAnsi become "?", never vanish', async () => {
    const { sys } = await recordSession('HD-T000', 5);
    const r = buildReport(sys);
    expect(reportToPdf(r)).toEqual(reportToPdf(r));
    expect(pdfString('a(b)c\\ ±5 µA 漢')).toBe('(a\\(b\\)c\\\\ \\2615 \\265A ?)');
    const { lines } = await pdfText(linesToPdf([{ text: '±0.1 % + 8.75 mV, 24.5 µA' }], { title: 't', header: 'h', footer: 'f', date: new Date(0) }));
    // The micro sign comes back as the Greek mu, the same glyph: compare normalized.
    expect(lines.map((l) => l.normalize('NFKC'))).toContain('±0.1 % + 8.75 mV, 24.5 µA'.normalize('NFKC'));
  });

  it('PDF: long lines wrap with their indentation, nothing is cut', () => {
    const long = '    evidence: ' + 'HDP frames #1 #2 #3 '.repeat(12);
    const parts = wrapLine(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(PDF_COLUMNS);
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('HTML: self-contained, no script, everything from the device escaped', async () => {
    const { sys, transport } = await connectedSystem();
    transport.push({ type: 'uart.rx', t: 10, data: '<script>alert(1)</script>' });
    transport.push({ type: 'log', t: 11, level: 'error', message: '"><img src=x onerror=alert(1)>' });
    const html = reportToHtml(buildReport(sys));
    expect(html).toContain("Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"");
    expect(html).not.toMatch(/<script|<img|src=["']?http/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('SIMULATED DATA. NOT A MEASUREMENT OF REAL HARDWARE.');
    // Same words as the TXT report.
    const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    for (const line of reportToText(buildReport(sys)).split('\n').filter((l) => l.trim() && !l.startsWith('GENERATED') && !l.startsWith('DURATION'))) {
      expect(text, line).toContain(line);
    }
  });
});

describe('text from a device stays on its line in every format (audit 2026-10)', () => {
  it('a line break, a control or a direction override is written out, never obeyed', async () => {
    const { sys, transport } = await connectedSystem();
    const forged = 'Cam\n\nRESULT                PASS\r\u202Eevil\u2028x';
    transport.push({ ...(attach(5) as Extract<DeviceFrame, { type: 'usb.attach' }>), product: forged });
    transport.push({ type: 'log', t: 6, level: 'error', message: 'boot\nDIAGNOSIS  NO FINDINGS' });
    const r = buildReport(sys);
    const txt = reportToText(r);
    expect(txt).not.toMatch(/^RESULT {2,}PASS/m);
    expect(txt).not.toMatch(/^DIAGNOSIS {2}NO FINDINGS/m);
    expect(txt).toContain('Cam\\n\\nRESULT                PASS\\r\\u{202E}evil\\u{2028}x');
    expect(txt).not.toMatch(/[\u202e\u2028\r]/);
    // the same characters in HTML and PDF
    const html = reportToHtml(r).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    expect(html).toContain('Cam\\n\\nRESULT');
    const doc = await getDocument({ data: reportToPdf(r) }).promise;
    let pdf = '';
    for (let n = 1; n <= doc.numPages; n++) pdf += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('');
    expect(pdf.replace(/\s+/g, '')).toContain('Cam\\n\\nRESULTPASS\\r\\u{202E}evil');
  });
});

describe('a report says what was observed, whenever it is exported (audit 2026-10)', () => {
  it('exported an hour after the link closed, it has the same diagnoses and duration as at the close', async () => {
    const { sys, transport, clock } = await connectedSystem();
    // 5 s of a target drawing 120 mA with no USB device: USB NOT ENUMERATED
    for (let t = 100; t <= 5000; t += 100) {
      clock.set(1_000_000 + t);
      transport.push({ type: 'power', t, v: 5.0, i: 0.12 });
    }
    await sys.disconnect();
    const closed = clock.get();
    const atClose = buildReport(sys, closed);
    const later = buildReport(sys, closed + 3_600_000);
    const keys = (r: typeof atClose) => r.diagnoses.map((d) => `${d.id}:${d.confidence}:${d.observed.join('|')}`);
    expect(keys(atClose).length).toBeGreaterThan(0);
    expect(keys(later)).toEqual(keys(atClose));
    expect(later.duration).toBe(atClose.duration);
    expect(later.generatedAt).toBe(closed + 3_600_000); // only the export time moves
  });
});
