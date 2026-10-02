import type { IntegrityStatus } from '../../core/session';
import { Tag } from './Tag';

const STATUS = {
  VERIFIED: 'PASS',
  RECOVERED: 'WARN',
  INCOMPLETE: 'WARN',
  MODIFIED: 'FAIL',
  UNVERIFIED: 'UNKNOWN',
} as const;

/** Integrity of a recording. The word carries the meaning, color reinforces it; the glossary explains it. */
export function IntegrityTag({ status }: { status: IntegrityStatus }) {
  return <Tag status={STATUS[status]} label={status} />;
}
