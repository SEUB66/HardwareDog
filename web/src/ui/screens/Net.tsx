import { clock, ms, percent } from '../../core/format';
import type { System } from '../../core/system';
import type { CheckStatus } from '../../core/types';
import { Empty } from '../components/Empty';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';

/** Layer by layer: how far does communication actually get? (spec 19) */
export function Net({ system }: { system: System }) {
  const n = system.net;
  const layers: { name: string; value: string; status: CheckStatus }[] = [
    {
      name: 'LINK',
      value: n.link ? (n.link.up ? `${n.link.mbps ?? '--'} Mbps / ${n.link.duplex ?? '--'}` : 'DOWN') : '--',
      status: n.link ? (n.link.up ? 'PASS' : 'FAIL') : 'UNKNOWN',
    },
    { name: 'ADDRESS', value: n.address ?? '--', status: n.address ? 'PASS' : 'UNKNOWN' },
    { name: 'DHCP', value: '', status: n.dhcp },
    { name: 'GATEWAY', value: n.gateway.address ?? '--', status: n.gateway.status },
    { name: 'DNS', value: n.dns.address ?? '--', status: n.dns.status },
    { name: 'INTERNET', value: '', status: n.internet },
  ];
  // The first failing layer explains everything above it.
  const firstFail = layers.findIndex((l) => l.status === 'FAIL');

  return (
    <>
      <h1 class="screen-title">
        NETWORK <span class="sub">{n.updatedAt ? `updated ${clock(n.updatedAt)}` : 'no report yet'}</span>
      </h1>
      {n.updatedAt === null ? (
        <Empty title="NO SIGNAL" hint="Waiting for a network report from the device." />
      ) : (
        <div class="grid wide">
          <Panel title="LAYERS">
            <div class="trace" style={{ border: 0 }}>
              <table>
                <tbody>
                  {layers.map((l, i) => (
                    <tr key={l.name}>
                      <td class="dim">{String(i + 1).padStart(2, '0')}</td>
                      <td>{l.name}</td>
                      <td class="msg">{l.value}</td>
                      <td>
                        <Tag status={firstFail !== -1 && i > firstFail && l.status === 'UNKNOWN' ? 'UNKNOWN' : l.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {firstFail !== -1 && (
              <p class="note warn">
                COMMUNICATION STOPS AT {layers[firstFail]!.name}. Layers above it cannot be judged.
              </p>
            )}
          </Panel>
          <Panel title="QUALITY">
            <div class="metrics" style={{ border: 0 }}>
              <div class="metric">
                <div class="label">LATENCY</div>
                <div class="value">{ms(n.latencyMs)}</div>
              </div>
              <div class="metric">
                <div class="label">PACKET LOSS</div>
                <div class="value">{percent(n.packetLoss)}</div>
              </div>
            </div>
            <div class="actions">
              <button class="btn" onClick={() => system.refreshNet()} disabled={!system.online}>
                REFRESH
              </button>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
