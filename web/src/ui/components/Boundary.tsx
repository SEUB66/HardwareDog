import { Component, type ComponentChildren } from 'preact';
import { ErrorBlock } from './ErrorBlock';

interface BoundaryProps {
  /** What failed, as the operator knows it: a screen, the TV. */
  where: string;
  /** Told once per failure (the trace keeps it). */
  onError?: (detail: string) => void;
  /** Shown instead of the failed part; null: nothing (the TV just goes away). */
  quiet?: boolean;
  children: ComponentChildren;
}

/**
 * One part of the interface that fails to draw (a bug, data it did not
 * expect) is said where it was, and the rest goes on: the session keeps
 * recording, the other screens work. RETRY draws it again.
 */
export class Boundary extends Component<BoundaryProps, { error: Error | null; at: number }> {
  override state = { error: null as Error | null, at: 0 };

  override componentDidCatch(error: unknown) {
    const e = error instanceof Error ? error : new Error(String(error));
    this.setState({ error: e, at: Date.now() });
    this.props.onError?.(e.message);
  }

  override render() {
    const { error, at } = this.state;
    if (!error) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <div class="boundary">
        <ErrorBlock error={{ what: `${this.props.where} COULD NOT BE DRAWN`, where: this.props.where, when: at, detail: error.message || error.name }} />
        <p class="note">The session keeps recording and the other screens work. This is a bug: the session file and this message help fix it.</p>
        <div class="actions">
          <button class="btn" type="button" onClick={() => this.setState({ error: null })}>
            RETRY
          </button>
        </div>
      </div>
    );
  }
}
