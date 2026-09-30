import type { CheckStatus, Severity } from '../../core/types';

type TagStatus = CheckStatus | Severity | 'OK' | 'LIVE';

/**
 * A status word. The word always carries the meaning; color only
 * reinforces it, so the tag stays readable in monochrome.
 */
export function Tag({ status, label }: { status: TagStatus; label?: string }) {
  return <span class={`tag ${status}`}>{label ?? status}</span>;
}

/** "[ OK ]" style boot / checklist marker. */
export function Bracket({ status }: { status: 'OK' | 'WARN' | 'FAIL' }) {
  const text = status === 'OK' ? ' OK ' : status;
  return <span class={`tag ${status}`}>[{text}]</span>;
}
