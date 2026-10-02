import type { ReportFormat } from '../../core/commands';
import { buildReport, reportToText } from '../../core/report';
import type { System } from '../../core/system';
import { AsciiBanner } from '../components/AsciiBanner';
import { useClock } from '../hooks';

interface ReportProps {
  system: System;
  onExport: (format: ReportFormat) => void;
  onExportSession: () => void;
  onSaveCase: () => void;
  /** Why SAVE AS CASE is not available, or null. */
  caseBlocker: string | null;
}

/** A report reads like engineering documentation (spec 21). */
export function Report({ system, onExport, onExportSession, onSaveCase, caseBlocker }: ReportProps) {
  const now = useClock(system, 2000);
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
        <button class="btn" onClick={() => onExport('pdf')} title="For a ticket: A4 pages, same words as the TXT report">
          EXPORT PDF
        </button>
        <button class="btn" onClick={() => onExport('html')} title="One self-contained file, opens in any browser, no script">
          EXPORT HTML
        </button>
        <button class="btn" onClick={() => onExport('json')} title="The machine-readable truth: report + full trace">
          EXPORT JSON
        </button>
        <button class="btn" onClick={onExportSession} title="Every frame of this session, replayable in any Hardware Dog interface">
          EXPORT SESSION .HDLOG
        </button>
        <button class="btn" onClick={onSaveCase} disabled={caseBlocker !== null} title={caseBlocker ?? 'This incident as a regression case: case.json + the untouched .hdlog'}>
          SAVE AS CASE
        </button>
      </div>
      {caseBlocker && system.replayOf && <p class="note warn">{caseBlocker}</p>}
      <div class="report-doc">
        <AsciiBanner scale={0.6} />
        <pre tabIndex={0} aria-label="Diagnostic report" style={{ margin: '14px 0 0', font: 'inherit', whiteSpace: 'pre-wrap' }}>
          {'hardware companion\n\n' + text}
        </pre>
      </div>
    </>
  );
}
