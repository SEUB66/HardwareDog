/*
 * The report as a document a technician attaches to a ticket (LVL 75).
 * HTML and PDF are made from the same styled lines as the TXT report
 * (reportLines): no format can say something another one does not.
 * JSON stays the machine-readable truth.
 */
import { linesToPdf, type PdfLine } from './pdf';
import { reportLines, type LineStyle, type Report } from './report';

const PDF_STYLE: Record<LineStyle, Omit<PdfLine, 'text'>> = {
  normal: {},
  banner: { color: [0.25, 0.25, 0.25] },
  title: { bold: true },
  alert: { bold: true, color: [0.72, 0.1, 0.1] },
  note: { color: [0.35, 0.35, 0.35] },
  evidence: { bold: true },
  rule: { color: [0.55, 0.55, 0.55] },
};

/** The warning repeated on every page, when there is one. */
function stamp(r: Report): string | undefined {
  if (r.recording?.integrity === 'MODIFIED') return 'MODIFIED RECORDING: BYTES CHANGED AFTER THEY WERE SEALED. NOT EVIDENCE.';
  if (r.simulated) return 'SIMULATED DATA. NOT A MEASUREMENT OF REAL HARDWARE.';
  return undefined;
}

export function reportToPdf(r: Report): Uint8Array {
  // No ASCII-art banner: its box-drawing characters are not in the PDF standard fonts.
  const lines = reportLines(r, { banner: false }).map((l): PdfLine => ({ text: l.text, ...PDF_STYLE[l.style] }));
  return linesToPdf(lines, {
    title: `Hardware Dog diagnostic report ${r.session}`,
    header: 'HARDWARE DOG / DIAGNOSTIC REPORT',
    headerRight: r.session,
    stamp: stamp(r),
    footer: 'Generated locally, never uploaded. Diagnostic measurement, not certified metrology.',
    date: new Date(r.generatedAt),
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One self-contained HTML file: no script, no remote resource (the content
 * security policy forbids both), light paper colors, prints on A4.
 * Every string comes from a device or a file: all of it is escaped.
 */
export function reportToHtml(r: Report): string {
  const lines = reportLines(r);
  // The banner is drawn with block characters: its lines must touch.
  const banner = lines.filter((l) => l.style === 'banner').map((l) => escapeHtml(l.text));
  const body =
    (banner.length ? `<span class="banner">${banner.join('\n')}</span>\n` : '') +
    lines
      .filter((l) => l.style !== 'banner')
      .map((l) => (l.text === '' ? '' : `<span class="${l.style}">${escapeHtml(l.text)}</span>`))
      .join('\n');
  const warn = stamp(r);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Hardware Dog">
<title>Hardware Dog diagnostic report ${escapeHtml(r.session)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f1e8; color: #0b0d0f; font: 12px/1.45 ui-monospace, 'IBM Plex Mono', Menlo, Consolas, monospace; }
  main { max-width: 100ch; margin: 0 auto; padding: 24px 16px 48px; }
  pre { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  .stamp { border: 2px solid #b3261e; color: #b3261e; font-weight: 700; padding: 6px 10px; margin-bottom: 16px; }
  .banner { display: block; color: #3c4347; line-height: 1.05; margin-bottom: 4px; }
  .title { font-weight: 700; letter-spacing: 0.04em; }
  .alert { color: #b3261e; font-weight: 700; }
  .note { color: #3c4347; }
  .evidence { font-weight: 700; background: #ebe7dc; }
  .rule { color: #8a9195; }
  @page { size: A4; margin: 16mm 14mm; }
  @media print {
    body { background: #fff; font-size: 9pt; }
    main { max-width: none; padding: 0; }
  }
</style>
</head>
<body>
<main>
${warn ? `<div class="stamp" role="alert">${escapeHtml(warn)}</div>\n` : ''}<pre>${body}</pre>
</main>
</body>
</html>
`;
}
