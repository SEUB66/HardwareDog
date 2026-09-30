import { Fragment, type ComponentChildren } from 'preact';

export type Row = [label: string, value: ComponentChildren, live?: boolean];

/** Label / value rows. Values are tabular so columns of numbers line up. */
export function KV({ rows }: { rows: Row[] }) {
  return (
    <dl class="kv">
      {rows.map(([label, value, live]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd class={live ? 'live' : undefined}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
