import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { RULES } from '../core/system';
import type { Cell } from './intro';
import { BANNER_COLS, BANNER_ROWS, INTRO, PROMPT, PROMPT_CHAR_MS, bannerCells, cellAt, codeAt, codeLines, dogAt, rng, taglineAt, typed } from './intro';

const CYAN = '#00e5ff';
const PINK = '#ff4fa3';
const GREEN = '#79d98a';
const RAIN = [CYAN, PINK, GREEN];

/**
 * Phase one of the start: the terminal intro. Bits rain, the HW DOG banner
 * decodes out of 0 and 1, the dog arrives on its USB leash, the laws are
 * typed as code. It claims no check: phase two (Boot) does the real ones.
 * Any key or tap skips it.
 */
export function BootIntro({ onDone }: { onDone: () => void }) {
  const rain = useRef<HTMLCanvasElement>(null);
  const banner = useRef<HTMLCanvasElement>(null);
  const [t, setT] = useState(0);
  const cells = useMemo(() => bannerCells(), []);
  const code = useMemo(() => codeLines(RULES.length), []);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };

  // One clock for everything: canvases every frame, text 30 times a second.
  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    let lastText = -1;
    const rainCtx = rain.current?.getContext('2d') ?? null;
    const bannerCtx = banner.current?.getContext('2d') ?? null;
    const drops = new RainField();
    const loop = (now: number) => {
      const at = now - start;
      if (rainCtx && rain.current) drops.draw(rainCtx, rain.current, at);
      if (bannerCtx && banner.current) drawBanner(bannerCtx, banner.current, cells, at);
      if (Math.floor(at / 33) !== lastText) {
        lastText = Math.floor(at / 33);
        setT(at);
      }
      if (at >= INTRO.end) return finish();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (t < INTRO.skippable) return;
    const skip = () => finish();
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [t >= INTRO.skippable]);

  const prompt = typed(PROMPT, INTRO.prompt, t, PROMPT_CHAR_MS);
  const dog = dogAt(t);
  const lines = codeAt(code, t);
  const tagline = taglineAt(t);
  const fading = t > INTRO.hold;

  return (
    <main class={`intro${fading ? ' fading' : ''}`} aria-label="Hardware Dog is starting" aria-busy="true">
      <canvas ref={rain} class="intro-rain" aria-hidden="true" />
      <div class="intro-stage">
        <pre class="intro-prompt">
          {prompt}
          <span class="intro-cursor">█</span>
        </pre>
        <canvas ref={banner} class="intro-banner" role="img" aria-label="HW DOG" />
        <pre class="intro-dog" aria-hidden="true">
          {dog.map((line, n) => (
            <DogLine key={n} line={line} n={n} />
          ))}
        </pre>
        <pre class="intro-code" aria-hidden="true">
          {lines.map((tokens, n) => (
            <div key={n}>
              <span class="ln">{String(n + 1).padStart(2, ' ')}</span>
              {tokens.map(([kind, text], k) => (
                <span key={k} class={`tk-${kind}`}>
                  {text}
                </span>
              ))}
            </div>
          ))}
        </pre>
        <p class="intro-tagline">{tagline}</p>
      </div>
      {t >= INTRO.skippable && <p class="intro-skip">press any key or tap to skip</p>}
    </main>
  );
}

function DogLine({ line, n }: { line: string; n: number }) {
  if (n === 1) {
    const at = line.indexOf('@');
    return (
      <div>
        {line.slice(0, at)}
        <span class="eye">@</span>
        {line.slice(at + 1)}
      </div>
    );
  }
  if (n === 2) {
    const at = line.indexOf('O');
    return (
      <div>
        {line.slice(0, at)}
        <span class="leash">{line.slice(at, line.indexOf('['))}</span>
        <span class="usb">{line.slice(line.indexOf('['))}</span>
      </div>
    );
  }
  return <div>{line}</div>;
}

/** Fit a canvas to its CSS size at the screen's pixel density. */
function fit(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/** Columns of falling 0 and 1, in the signal colors, faint behind the stage. */
class RainField {
  private cols: { y: number; speed: number; color: string; bits: number }[] = [];
  private width = 0;
  private last = 0;
  private readonly random = rng(0x0b1d);
  private readonly size = 15;

  draw(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, at: number) {
    const { w, h } = fit(canvas, ctx);
    if (w !== this.width) {
      this.width = w;
      this.cols = Array.from({ length: Math.ceil(w / this.size) }, () => ({
        y: -this.random() * h,
        speed: 0.06 + this.random() * 0.16,
        color: RAIN[Math.floor(this.random() * RAIN.length)]!,
        bits: Math.floor(this.random() * 1e6),
      }));
      ctx.fillStyle = '#0b0d0f';
      ctx.fillRect(0, 0, w, h);
    }
    const dt = Math.min(64, at - this.last);
    this.last = at;
    // The trail: everything fades a little each frame.
    ctx.fillStyle = 'rgba(11, 13, 15, 0.16)';
    ctx.fillRect(0, 0, w, h);
    // Fade in at the start, out at the end.
    const level = Math.min(1, at / 900) * (at > INTRO.hold ? Math.max(0, 1 - (at - INTRO.hold) / 700) : 1);
    ctx.font = `${this.size - 2}px 'IBM Plex Mono', monospace`;
    ctx.textBaseline = 'top';
    this.cols.forEach((c, i) => {
      c.y += c.speed * dt;
      if (c.y > h + 40) {
        c.y = -this.random() * h * 0.5;
        c.speed = 0.06 + this.random() * 0.16;
      }
      c.bits = (c.bits * 1103515245 + 12345) & 0x7fffffff;
      const bit = (c.bits >> 16) & 1 ? '1' : '0';
      ctx.globalAlpha = 0.55 * level;
      ctx.fillStyle = c.color;
      ctx.fillText(bit, i * this.size, c.y);
      ctx.globalAlpha = 0.9 * level;
      ctx.fillStyle = '#ece8de';
      ctx.fillText(bit, i * this.size, c.y + this.size);
    });
    ctx.globalAlpha = 1;
  }
}

/** The banner, cell by cell: blocks as solid cells, box lines as their shadow. */
function drawBanner(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cells: Cell[], at: number) {
  const { w, h } = fit(canvas, ctx);
  ctx.clearRect(0, 0, w, h);
  const cw = w / BANNER_COLS;
  const ch = h / BANNER_ROWS;
  const gap = Math.max(0.8, cw * 0.16);
  ctx.font = `600 ${Math.round(ch * 0.78)}px 'IBM Plex Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const cell of cells) {
    const s = cellAt(cell, at);
    if (s.kind === 'none') continue;
    // Whole pixels, edge to edge: no seam between two blocks.
    const x0 = Math.floor(cell.x * cw);
    const y0 = Math.floor(cell.y * ch);
    const x1 = Math.ceil((cell.x + 1) * cw);
    const y1 = Math.ceil((cell.y + 1) * ch);
    const color = cell.word === 'DOG' ? PINK : CYAN;
    if (s.kind === 'bit') {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = (cell.x + cell.y) % 3 === 0 ? GREEN : color;
      ctx.fillText(s.bit, (x0 + x1) / 2, (y0 + y1) / 2);
      continue;
    }
    ctx.globalAlpha = 1;
    if (cell.ch === '█') {
      ctx.fillStyle = cell.word === 'DOG' ? PINK : '#e6fbff';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      ctx.strokeStyle = cell.word === 'DOG' ? '#ff4fa399' : '#00e5ff99';
      ctx.lineWidth = Math.max(1, cw * 0.1);
      boxLines(ctx, cell.ch, x0, y0, x1 - x0, y1 - y0, gap);
    }
    if (s.flash > 0) {
      ctx.globalAlpha = s.flash;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  ctx.globalAlpha = 1;
}

/** The double-line box characters as two strokes (fonts rarely carry them). */
function boxLines(ctx: CanvasRenderingContext2D, c: string, x0: number, y0: number, w: number, h: number, g: number) {
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const r = x0 + w;
  const b = y0 + h;
  const path = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  };
  switch (c) {
    case '═':
      path([[x0, cy - g], [r, cy - g]]);
      path([[x0, cy + g], [r, cy + g]]);
      break;
    case '║':
      path([[cx - g, y0], [cx - g, b]]);
      path([[cx + g, y0], [cx + g, b]]);
      break;
    case '╔':
      path([[r, cy - g], [cx - g, cy - g], [cx - g, b]]);
      path([[r, cy + g], [cx + g, cy + g], [cx + g, b]]);
      break;
    case '╗':
      path([[x0, cy - g], [cx + g, cy - g], [cx + g, b]]);
      path([[x0, cy + g], [cx - g, cy + g], [cx - g, b]]);
      break;
    case '╚':
      path([[r, cy + g], [cx - g, cy + g], [cx - g, y0]]);
      path([[r, cy - g], [cx + g, cy - g], [cx + g, y0]]);
      break;
    case '╝':
      path([[x0, cy + g], [cx + g, cy + g], [cx + g, y0]]);
      path([[x0, cy - g], [cx - g, cy - g], [cx - g, y0]]);
      break;
  }
}
