/*
 * HARDWARE DOG / PDF WRITER
 *
 * A report must be attachable to a ticket as a PDF, offline, with no
 * library and no server. This writes PDF 1.4 by hand: A4 pages of
 * monospaced text in the 14 standard fonts every reader has (Courier,
 * Courier-Bold), so nothing is embedded and nothing is fetched.
 *
 * Text is WinAnsi (Latin-1 plus a few typographic signs). Anything else
 * becomes "?": a report never silently drops a character.
 */

export interface PdfLine {
  text: string;
  bold?: boolean;
  /** RGB 0..1. Default black. */
  color?: [number, number, number];
}

export interface PdfOptions {
  title: string;
  /** Left of each page header, e.g. "HARDWARE DOG / DIAGNOSTIC REPORT". */
  header: string;
  /** Right of each page header, e.g. the session id. */
  headerRight?: string;
  /** Printed in red under the header of every page (e.g. SIMULATED DATA). */
  stamp?: string;
  /** Left of each page footer. */
  footer: string;
  /** PDF CreationDate, so the same report gives the same bytes. */
  date: Date;
}

const PAGE_W = 595.28; // A4, points
const PAGE_H = 841.89;
const MARGIN_X = 42;
const TOP = 52;
const BOTTOM = 46;
const SIZE = 8.4;
const LEADING = 10.6;
/** Courier advances 0.6 em per character. */
export const PDF_COLUMNS = Math.floor((PAGE_W - 2 * MARGIN_X) / (SIZE * 0.6));
const ROWS = Math.floor((PAGE_H - TOP - BOTTOM - 2 * LEADING) / LEADING);

/** WinAnsiEncoding code for characters outside ASCII (cp1252). */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

function encodeChar(ch: string): string {
  const c = ch.codePointAt(0)!;
  let code: number;
  if (c >= 0x20 && c < 0x7f) code = c;
  else if (c >= 0xa0 && c <= 0xff) code = c;
  else code = WIN_ANSI[ch] ?? 0x3f; // '?'
  if (code === 0x28 || code === 0x29 || code === 0x5c) return '\\' + String.fromCharCode(code);
  if (code < 0x80) return String.fromCharCode(code);
  return '\\' + code.toString(8).padStart(3, '0');
}

/** A PDF literal string, pure ASCII (octal escapes above 127). */
export function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) out += encodeChar(ch);
  return out + ')';
}

/** Hard-wrap to the page width, keeping the indentation of the line. */
export function wrapLine(text: string, columns = PDF_COLUMNS): string[] {
  const chars = [...text.replace(/\t/g, '    ')];
  if (chars.length <= columns) return [chars.join('')];
  // Hanging indent: under the value column of a "LABEL    value" line,
  // else two spaces past the line's own indentation.
  const flat = chars.join('');
  const column = /^\S[^\n]{0,28}?\s{2,}(?=\S)/.exec(flat);
  const lead = chars.length - flat.trimStart().length;
  const indent = Math.min(column ? column[0].length : lead + 2, Math.floor(columns / 2));
  const out: string[] = [];
  let rest = chars;
  let width = columns;
  while (rest.length > width) {
    let cut = width;
    // Break at the last space in the second half of the line, if any.
    for (let k = width; k > width / 2; k--) {
      if (rest[k] === ' ') {
        cut = k;
        break;
      }
    }
    out.push((out.length ? ' '.repeat(indent) : '') + rest.slice(0, cut).join('').trimEnd());
    rest = rest.slice(cut);
    while (rest[0] === ' ') rest = rest.slice(1);
    width = columns - indent;
  }
  if (rest.length) out.push(' '.repeat(indent) + rest.join(''));
  return out;
}

const fmt = (n: number) => Number(n.toFixed(2)).toString();

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Lay the lines out on A4 pages and write the PDF file. */
export function linesToPdf(lines: readonly PdfLine[], o: PdfOptions): Uint8Array {
  const rows: PdfLine[] = lines.flatMap((l) => wrapLine(l.text).map((text) => ({ ...l, text })));
  const pages: PdfLine[][] = [];
  for (let k = 0; k < Math.max(1, rows.length); k += ROWS) pages.push(rows.slice(k, k + ROWS));

  const streams = pages.map((page, n) => {
    const ops: string[] = [];
    const text = (x: number, y: number, s: string, bold: boolean, size: number, rgb: [number, number, number] = [0, 0, 0]) =>
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${fmt(size)} Tf ${rgb.map(fmt).join(' ')} rg ${fmt(x)} ${fmt(y)} Td ${pdfString(s)} Tj ET`);
    // Header, rule, optional stamp.
    const headY = PAGE_H - 30;
    text(MARGIN_X, headY, o.header, true, 8);
    if (o.headerRight) text(PAGE_W - MARGIN_X - o.headerRight.length * 8 * 0.6, headY, o.headerRight, false, 8);
    ops.push(`0.6 G ${fmt(MARGIN_X)} ${fmt(headY - 6)} m ${fmt(PAGE_W - MARGIN_X)} ${fmt(headY - 6)} l 0.5 w S 0 G`);
    let y = PAGE_H - TOP;
    if (o.stamp) {
      text(MARGIN_X, y, o.stamp, true, SIZE, [0.75, 0.1, 0.1]);
      y -= LEADING * 1.5;
    }
    for (const l of page) {
      if (l.text !== '') text(MARGIN_X, y, l.text, l.bold ?? false, SIZE, l.color);
      y -= LEADING;
    }
    // Footer.
    const footY = 26;
    ops.push(`0.6 G ${fmt(MARGIN_X)} ${fmt(footY + 12)} m ${fmt(PAGE_W - MARGIN_X)} ${fmt(footY + 12)} l 0.5 w S 0 G`);
    text(MARGIN_X, footY, o.footer, false, 7);
    const pageNo = `PAGE ${n + 1} / ${pages.length}`;
    text(PAGE_W - MARGIN_X - pageNo.length * 7 * 0.6, footY, pageNo, false, 7);
    return ops.join('\n');
  });

  // Objects: 1 catalog, 2 pages, 3 Courier, 4 Courier-Bold, 5 info, then page + content pairs.
  const objects: string[] = [];
  const kids = pages.map((_, n) => `${6 + 2 * n} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title ${pdfString(o.title)} /Producer (Hardware Dog) /Creator (Hardware Dog, generated locally) /CreationDate (${pdfDate(o.date)}) >>`;
  streams.forEach((content, n) => {
    const page = 6 + 2 * n;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W)} ${fmt(PAGE_H)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${page + 1} 0 R >>`;
    objects[page + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  // Everything above is ASCII: string length == byte length.
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let k = 1; k < objects.length; k++) {
    offsets[k] = byteLength(body);
    body += `${k} 0 obj\n${objects[k]}\nendobj\n`;
  }
  const xref = byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objects.length; k++) body += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(body);
}

/** Bytes of a string whose characters are all below 256. */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k) & 0xff;
  return out;
}

const byteLength = (s: string) => s.length;
