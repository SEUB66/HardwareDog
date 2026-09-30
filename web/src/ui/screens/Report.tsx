import { buildReport, reportToText } from '../../core/report';
import type { System } from '../../core/system';
import { AsciiBanner } from '../components/AsciiBanner';
import { useNow } from '../hooks';

interface ReportProps {
  system: System;
  onExport: (format: 'txt' | 'json') => void;
}

/** A report reads like engineering documentation (spec 21). */
export function Report({ system, onExport }: ReportProps) {
  const now = useNow(2000);
  const text = reportToText(buildReport(system, now), { banner: false });
  return (
    <>
      <h1 class="screen-title">
        REPORT <span class="sub">generated locally, never uploaded</span>
      </h1>
      <div class="actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <button class="btn primary" onClick={() => onExport('txt')}>
          EXPORT TXT <span class="dim">CTRL+E</span>
        </button>
        <button class="btn" onClick={() => onExport('json')}>
          EXPORT JSON
        </button>
      </div>
      <div class="report-doc">
        <AsciiBanner scale={0.6} />
        <pre tabIndex={0} aria-label="Diagnostic report" style={{ margin: '14px 0 0', font: 'inherit', whiteSpace: 'pre-wrap' }}>
          {'hardware companion\n\n' + text}
        </pre>
      </div>
    </>
  );
}
