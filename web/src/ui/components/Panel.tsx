import type { ComponentChildren } from 'preact';
import { explainPanel } from '../../core/glossary';
import { Hint, Scope } from './Hint';

interface PanelProps {
  title: string;
  aside?: ComponentChildren;
  tone?: 'alert' | 'fault';
  children: ComponentChildren;
  class?: string;
  /** Glossary scope of the labels inside. Default: the title. */
  scope?: string;
  /** What the panel is about, when the title alone is ambiguous. */
  info?: string;
}

/** A bordered instrument panel with its title set into the top edge. */
export function Panel({ title, aside, tone, children, class: extra, scope, info }: PanelProps) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section class={['panel', tone, extra].filter(Boolean).join(' ')} aria-labelledby={id}>
      <h2 class="panel-title" id={id}>
        <Hint text={info ?? explainPanel(title)}>{title}</Hint>
        {aside !== undefined && <span class="aside">{aside}</span>}
      </h2>
      <Scope.Provider value={scope ?? title}>{children}</Scope.Provider>
    </section>
  );
}
