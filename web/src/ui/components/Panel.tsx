import type { ComponentChildren } from 'preact';

interface PanelProps {
  title: string;
  aside?: ComponentChildren;
  tone?: 'alert' | 'fault';
  children: ComponentChildren;
  class?: string;
}

/** A bordered instrument panel with its title set into the top edge. */
export function Panel({ title, aside, tone, children, class: extra }: PanelProps) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section class={['panel', tone, extra].filter(Boolean).join(' ')} aria-labelledby={id}>
      <h2 class="panel-title" id={id}>
        {title}
        {aside !== undefined && <span class="aside">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}
