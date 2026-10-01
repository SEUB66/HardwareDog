import type { IntegrityStatus } from '../../core/session';
import { Tag } from './Tag';

const STATUS = {
  VERIFIED: 'PASS',
  RECOVERED: 'WARN',
  INCOMPLETE: 'WARN',
  MODIFIED: 'FAIL',
  UNVERIFIED: 'UNKNOWN',
} as const;

const TITLE: Record<IntegrityStatus, string> = {
  VERIFIED: 'Finalized by the recorder. Every hash and count matches.',
  RECOVERED: 'Closed after an unclean stop. Every sealed line is intact.',
  INCOMPLETE: 'Never finalized. Sealed lines are intact; the end is missing.',
  MODIFIED: 'Bytes changed after they were sealed. Not evidence.',
  UNVERIFIED: 'hdlog v1: no integrity data.',
};

/** Integrity of a recording. The word carries the meaning, color reinforces it. */
export function IntegrityTag({ status }: { status: IntegrityStatus }) {
  return (
    <span title={TITLE[status]}>
      <Tag status={STATUS[status]} label={status} />
    </span>
  );
}
