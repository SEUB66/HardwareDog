/**
 * What a Flipper file holds, said with its provenance:
 *   DECODED    parameters the Flipper decoded and saved: no waveform is drawn
 *   MEASURED   timings the Flipper's receiver recorded: drawn as recorded
 * A file that is not a known format is shown as bytes, never guessed at.
 */

import { FormatError, hexString, parseFlipperFile, timingStats, type ParsedFile } from '../../core/flipper/formats';
import { Fragment } from 'preact';
import { HexView } from './HexView';

function Rows({ rows, mono }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl class="kv">
      {rows.map(([k, v], i) => (
        <Fragment key={`${i}${k}`}>
          <dt>{k}</dt>
          <dd class={mono ? 'mono' : undefined}>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const MAX_DRAWN = 400;

/** Recorded timings as a pulse train: high when the level is on, low when off. Nothing interpolated. */
export function PulseTrain({ timings, alternate }: { timings: readonly number[]; alternate: boolean }) {
  const shown = timings.slice(0, MAX_DRAWN);
  const total = shown.reduce((n, t) => n + Math.abs(t), 0) || 1;
  let x = 0;
  let d = 'M0 30';
  shown.forEach((t, i) => {
    // IR: mark, space, mark... ; Sub-GHz RAW: the sign says the level.
    const high = alternate ? i % 2 === 0 : t > 0;
    const y = high ? 4 : 30;
    const w = (Math.abs(t) / total) * 1000;
    d += ` L${x.toFixed(2)} ${y} L${(x + w).toFixed(2)} ${y}`;
    x += w;
  });
  return (
    <figure class="pulses">
      <svg viewBox="0 0 1000 34" preserveAspectRatio="none" role="img" aria-label={`${shown.length} recorded timings`}>
        <path d={d} />
      </svg>
      <figcaption>
        MEASURED by the Flipper's receiver: {shown.length} of {timings.length} timings drawn to scale, {(total / 1000).toFixed(2)} ms
        {timings.length > MAX_DRAWN ? ` (first ${MAX_DRAWN})` : ''}
      </figcaption>
    </figure>
  );
}

function Stats({ timings }: { timings: readonly number[] }) {
  const s = timingStats(timings);
  if (!s) return <p class="note">No timings.</p>;
  return (
    <p class="note">
      {s.count} timings · total {(s.totalUs / 1000).toFixed(2)} ms · shortest {s.minUs} µs · longest {s.maxUs} µs
    </p>
  );
}

function Parsed({ p }: { p: ParsedFile }) {
  return (
    <div class="preview">
      <div class="preview-head">
        <span class="tag INFO">{p.kind.toUpperCase()}</span> {p.filetype}
        {p.version !== null ? ` · version ${p.version}` : ''}
      </div>
      {p.warnings.map((w) => (
        <p class="note warn" key={w}>
          {w}
        </p>
      ))}
      {p.ir?.map((s, n) => (
        <div class="preview-block" key={n}>
          <b>{s.name}</b>{' '}
          {s.type === 'parsed' ? (
            <>
              <span class="prov">DECODED</span> {s.protocol} · address {hexString(s.address)} · command {hexString(s.command)}
              <p class="note dim">The file holds decoded parameters only: there is no recorded waveform to draw.</p>
            </>
          ) : (
            <>
              <span class="prov measured">MEASURED</span> raw · carrier {s.frequency} Hz · duty {s.dutyCycle}
              <Stats timings={s.timings} />
              <PulseTrain timings={s.timings} alternate />
            </>
          )}
        </div>
      ))}
      {p.subghz && (
        <div class="preview-block">
          <div>
            {(p.subghz.frequency / 1e6).toFixed(3)} MHz · preset {p.subghz.preset || '--'} · protocol <b>{p.subghz.protocol}</b>
          </div>
          {p.subghz.timings ? (
            <>
              <span class="prov measured">MEASURED</span>
              <Stats timings={p.subghz.timings} />
              <PulseTrain timings={p.subghz.timings} alternate={false} />
            </>
          ) : p.subghz.binRaw ? (
            <>
              <span class="prov">DECODED</span> BinRAW · TE {p.subghz.binRaw.te} µs · {p.subghz.binRaw.blocks.length} block(s)
              {p.subghz.binRaw.blocks.map((b, i) => (
                <div class="mono small" key={i}>
                  {b.bits} bits: {hexString(b.data)}
                </div>
              ))}
            </>
          ) : (
            <>
              <span class="prov">DECODED</span>
              <Rows rows={Object.entries(p.subghz.key)} />
              <p class="note dim">A key file holds decoded fields: no waveform is drawn from it.</p>
            </>
          )}
        </div>
      )}
      {p.nfc && (
        <div class="preview-block">
          <span class="prov">DECODED</span> {p.nfc.deviceType} · UID {hexString(p.nfc.uid)}
          {p.nfc.atqa ? ` · ATQA ${hexString(p.nfc.atqa)}` : ''}
          {p.nfc.sak ? ` · SAK ${hexString(p.nfc.sak)}` : ''}
          {p.nfc.memory.size > 0 && (
            <table class="trace mem">
              <thead>
                <tr>
                  <th>{p.nfc.memoryUnit?.toUpperCase()}</th>
                  <th>BYTES (?? = not read)</th>
                </tr>
              </thead>
              <tbody>
                {[...p.nfc.memory].map(([n, bytes]) => (
                  <tr key={n}>
                    <td>{n}</td>
                    <td class="mono">{hexString(bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {p.key && (
        <div class="preview-block">
          <span class="prov">DECODED</span> {p.key.type}
          <Rows mono rows={Object.entries(p.key.fields).map(([k, v]) => [k, Array.isArray(v) ? hexString(v) : v])} />
        </div>
      )}
      {p.kind === 'unknown' && <p class="note">Flipper File Format "{p.filetype}": not a kind Hardware Dog interprets yet. Its entries:</p>}
      {p.kind === 'unknown' && (
        <Rows rows={p.entries.slice(0, 200).map((e) => [e.key, e.value])} />
      )}
    </div>
  );
}

export function FilePreview({ name, data }: { name: string; data: Uint8Array }) {
  let parsed: ParsedFile | null = null;
  let error: string | null = null;
  try {
    parsed = parseFlipperFile(data);
  } catch (e) {
    error = e instanceof FormatError ? e.message : String(e);
  }
  return (
    <div class="file-preview">
      <div class="preview-title">{name}</div>
      {parsed ? (
        <Parsed p={parsed} />
      ) : (
        <>
          <p class="note">
            Not read as a Flipper text file ({error}). <span class="tag UNKNOWN">FORMAT_INVALID</span> The bytes, as they are:
          </p>
          <HexView bytes={data} />
        </>
      )}
    </div>
  );
}
