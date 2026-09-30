import { useEffect, useRef, useState } from 'preact/hooks';
import { COMMANDS, execute, type CommandContext } from '../core/commands';

export interface PaletteEntry {
  input: string;
  ok: boolean;
  lines: string[];
}

interface PaletteProps {
  context: CommandContext;
  log: PaletteEntry[];
  onLog: (entry: PaletteEntry) => void;
  onClose: () => void;
}

/** The command layer (spec 22). Same System underneath as every button. */
export function CommandPalette({ context, log, onLog, onClose }: PaletteProps) {
  const [value, setValue] = useState('');
  const [recall, setRecall] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const out = useRef<HTMLPreElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [log.length]);

  const history = log.map((e) => e.input);
  const typed = value.trim().toLowerCase();
  const suggestions = typed ? COMMANDS.filter((c) => c.usage.startsWith(typed.split(' ')[0]!)).slice(0, 5) : [];

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!value.trim()) return;
      const result = execute(value, context);
      onLog({ input: value, ...result });
      setValue('');
      setRecall(-1);
    } else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      const n = recall === -1 ? history.length - 1 : Math.max(0, recall - 1);
      setRecall(n);
      setValue(history[n]!);
    } else if (e.key === 'ArrowDown' && recall !== -1) {
      e.preventDefault();
      const n = recall + 1;
      if (n >= history.length) {
        setRecall(-1);
        setValue('');
      } else {
        setRecall(n);
        setValue(history[n]!);
      }
    } else if (e.key === 'Tab' && suggestions.length === 1) {
      e.preventDefault();
      setValue(suggestions[0]!.usage.split(' <')[0]!.split(' [')[0]! + ' ');
    }
  };

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command">
        <div class="prompt">
          <span class="pink" aria-hidden="true">
            &gt;
          </span>
          <input
            ref={input}
            class="input"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
            placeholder="sniff usb / probe net 192.168.1.1 / help"
            autocomplete="off"
            spellcheck={false}
            aria-label="Command"
          />
        </div>
        {suggestions.length > 0 && (
          <ul class="suggest">
            {suggestions.map((s) => (
              <li key={s.usage}>
                {s.usage.padEnd(40)} {s.summary}
              </li>
            ))}
          </ul>
        )}
        <pre class="out" ref={out} aria-live="polite">
          {log.length === 0 && <span class="echo">type help for the command list</span>}
          {log.map((entry, n) => (
            <div key={n}>
              <span class="echo">&gt; {entry.input}</span>
              {'\n'}
              <span class={entry.ok ? 'okline' : 'err'}>{entry.lines.join('\n')}</span>
              {'\n'}
            </div>
          ))}
        </pre>
        <div class="hint">ENTER run / TAB complete / UP DOWN history / ESC close</div>
      </div>
    </div>
  );
}
