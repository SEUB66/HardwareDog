import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_COLUMNS, linesToPdf, pdfString, wrapLine } from '../src/core/pdf';
import { buildReport, reportToText, timelineExcerpt } from '../src/core/report';
import { reportToHtml, reportToPdf } from '../src/core/reportFormats';
import type { TraceEvent } from '../src/core/types';
import { connectedSystem, recordSession } from './helpers';

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
