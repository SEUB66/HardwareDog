import { DESCRIPTOR, DOG_TEXT, TAGLINE } from '../../core/ascii';
import { AsciiBanner } from '../components/AsciiBanner';
import { COMMANDS } from '../../core/commands';
import { Panel } from '../components/Panel';

export const SHORTCUTS: [string, string][] = [
  ['F1', 'HELP'],
  ['F2', 'TRACE'],
  ['F3', 'PROBE'],
  ['F4', 'REPORT'],
  ['1 - 7', 'STATUS  TRACE  POWER  USB  SERIAL  BUS  NET'],
  ['CTRL+K', 'COMMAND'],
  ['CTRL+E', 'EXPORT REPORT'],
  ['CTRL+L', 'CLEAR TRACE'],
  ['SPACE', 'PAUSE / RESUME TRACE VIEW'],
  ['ESC', 'CLOSE / BACK'],
];

export function Help() {
  return (
    <div class="help">
      <h1 class="screen-title">
        HELP <span class="sub">keyboard first</span>
      </h1>
      <div class="grid wide">
        <Panel title="KEYS">
          <table>
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td class="dim">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="COMMANDS" aside="CTRL+K">
          <table>
            <tbody>
              {COMMANDS.map((c) => (
                <tr key={c.usage}>
                  <td class="cyan">{c.usage}</td>
                  <td class="dim">{c.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="VOCABULARY">
          <table>
            <tbody>
              <tr><td>SNIFF</td><td class="dim">passive: observe without touching the target</td></tr>
              <tr><td>PROBE</td><td class="dim">active: sends something, always announced first</td></tr>
              <tr><td>WATCH</td><td class="dim">follow a signal live on the trace</td></tr>
              <tr><td>TRACE</td><td class="dim">every event from every source on one clock</td></tr>
              <tr><td>REPORT</td><td class="dim">observation, correlation and possible cause, kept apart</td></tr>
              <tr><td><span class="hint">DOTTED</span></td><td class="dim">a dotted label explains itself: hover it, Tab to it, or tap it</td></tr>
            </tbody>
          </table>
        </Panel>
      </div>
      <div style={{ marginTop: 24 }}>
        <AsciiBanner scale={0.8} />
        <pre class="dim" style={{ margin: '12px 0 0' }} aria-hidden="true">
          {`${DOG_TEXT}\n\n${DESCRIPTOR} // ${TAGLINE}`}
        </pre>
      </div>
    </div>
  );
}
