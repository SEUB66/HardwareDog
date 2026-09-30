import { clock } from '../../core/format';
import type { LinkError } from '../../core/system';
import { KV } from './KV';
import { Panel } from './Panel';

/** What failed, where, when, and what Hardware Dog knows (spec 36). */
export function ErrorBlock({ error }: { error: LinkError }) {
  return (
    <Panel title="FAULT" tone="fault">
      <div class="error-block" role="alert">
        <div class="what">{error.what}</div>
        <KV
          rows={[
            ['WHERE', error.where],
            ['WHEN', clock(error.when)],
            ['DETAIL', error.detail],
          ]}
        />
      </div>
    </Panel>
  );
}
