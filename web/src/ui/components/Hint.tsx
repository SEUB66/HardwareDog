import { createContext, type ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

/** The panel a label sits in, so the glossary can tell STATE from STATE. */
export const Scope = createContext<string | undefined>(undefined);

interface HintProps {
  /** The explanation. No text, no hint: the children render as they are. */
  text: string | undefined;
  /** Heading of the bubble, when the children are not plain text. */
  term?: string;
  /** In the Tab order. Status tags are not, so Tab is not flooded. */
  focusable?: boolean;
  class?: string;
  children: ComponentChildren;
}

/**
 * A label with an explanation, shown on hover, focus or tap (ui/tips.ts).
 * The same text is linked for screen readers with aria-describedby.
 */
export function Hint({ text, term, focusable = true, class: extra, children }: HintProps) {
  const id = useId();
  if (!text) return <>{children}</>;
  return (
    <span
      class={['hint', extra].filter(Boolean).join(' ')}
      data-tip={text}
      data-tip-term={term ?? (typeof children === 'string' ? children : undefined)}
      tabIndex={focusable ? 0 : -1}
      aria-describedby={id}
    >
      {children}
      <span id={id} hidden>
        {text}
      </span>
    </span>
  );
}
