import { explainStatus } from '../../core/glossary';
import type { CheckStatus, Severity } from '../../core/types';
import { Hint } from './Hint';

type TagStatus = CheckStatus | Severity | 'OK' | 'LIVE';

/**
 * A status word. The word always carries the meaning; color only
 * reinforces it, so the tag stays readable in monochrome. A known word
 * explains itself on hover or tap.
 */
export function Tag({ status, label }: { status: TagStatus; label?: string }) {
  const word = label ?? status;
  return (
    <Hint text={explainStatus(word)} term={word} focusable={false} class="tag-hint">
      <span class={`tag ${status}`}>{word}</span>
    </Hint>
  );
}

/** "[ OK ]" style boot / checklist marker. */
export function Bracket({ status }: { status: 'OK' | 'WARN' | 'FAIL' }) {
  const text = status === 'OK' ? ' OK ' : status;
  return <span class={`tag ${status}`}>[{text}]</span>;
}
