import { clockText } from '../../core/format';
import { explain } from '../../core/glossary';
import type { System } from '../../core/system';
import { useClock } from '../hooks';
import { Hint } from './Hint';
import { Panel } from './Panel';
import { Tag } from './Tag';

const COLUMNS = ['DOG', 'DEVICE', 'LINK', 'OBSERVES', 'CLOCK'] as const;

/**
 * Several Dogs watching one incident (docs/PACK.md): who each one is,
 * whether its link is up, which signals it is the source for, and how
 * well its clock is known. The diagnosis never compares two Dogs' times
 * more finely than these errors allow.
 */
export function PackPanel({ system }: { system: System }) {
  const now = useClock(system);
  const dogs = system.packView(now);
  const refused = dogs.filter((d) => d.refused.length > 0);
  return (
    <Panel title="PACK" aside={`${dogs.length} Dogs / one timeline / one clock`}>
      <div class="trace" style={{ border: 0 }}>
        <table class="pack">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th scope="col" key={c}>
                  <Hint text={explain(c, 'PACK')}>{c}</Hint>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dogs.map((d) => (
              <tr key={d.id}>
                <td class="pink">{d.id}</td>
                <td>
                  {d.device ? (
                    <>
                      {d.device.id}
                      <span class="dim rev">{` rev ${d.device.rev} fw ${d.device.firmware}`}</span>
                    </>
                  ) : (
                    <span class="dim">no hello yet</span>
                  )}
                </td>
                <td>
                  <Tag status={d.link === 'ONLINE' ? 'PASS' : d.link === 'LOST' ? 'FAIL' : 'UNKNOWN'} label={d.link} />
                </td>
                <td>
                  {d.observes.length ? d.observes.join(' ') : <span class="dim">nothing</span>}
                  {d.refused.length > 0 && <span class="amber">{`  refused: ${d.refused.join(' ')}`}</span>}
                </td>
                <td>{d.clock.state === 'ALIGNED' ? <span class="cyan">{clockText(d.clock)}</span> : d.clock.state === 'UNBOUNDED' ? <Tag status="WARN" label="UNBOUNDED" /> : '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {refused.length > 0 && (
        <p class="note warn">
          {refused.map((d) => `${d.id} also claims ${d.refused.join(' ')}`).join('; ')}: one signal has one source, the first Dog that claimed it. Frames for
          it from another Dog are ignored and counted.
        </p>
      )}
      <p class="note">
        Two Dogs' times are compared with their clock errors added as a margin: when the margin is wider than a rule's window, the link between two
        events is said UNKNOWN, never guessed.
      </p>
    </Panel>
  );
}
