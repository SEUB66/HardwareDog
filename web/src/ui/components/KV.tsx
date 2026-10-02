import { Fragment, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import { explain } from '../../core/glossary';
import { Hint, Scope } from './Hint';

export type Row = [label: string, value: ComponentChildren, live?: boolean];

/** Label / value rows. Values are tabular so columns of numbers line up. */
export function KV({ rows }: { rows: Row[] }) {
  const scope = useContext(Scope);
  return (
    <dl class="kv">
      {rows.map(([label, value, live]) => (
        <Fragment key={label}>
          <dt>
            <Hint text={explain(label, scope)}>{label}</Hint>
          </dt>
          <dd class={live ? 'live' : undefined}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
