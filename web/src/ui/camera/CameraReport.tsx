/**
 * HARDWARE DOG / CAMERA SNIFFER / REPORT VIEW
 *
 * The report built from what was observed and declared, previewed exactly
 * as it will leave, with network identifiers masked and personal notes
 * hidden when asked. Photos stay in this browser.
 */

import { useMemo, useState } from 'preact/hooks';
import { bleForReport, buildReport } from '../../core/camera/report';
import type { Lab } from '../../core/lab/context';
import { instantOp } from '../../core/lab/events';
import { browserLang } from '../../core/lab/rules';
import { Panel } from '../components/Panel';
import type { UsbReading } from './CameraSniffer';

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CameraReport({ lab, usb }: { lab: Lab; usb: UsbReading | null }) {
  const net = lab.camera.net;
  const insp = lab.camera.inspections.current;
  const [maskNetwork, setMask] = useState(true);
  const [hidePersonal, setHide] = useState(false);
  const iface = net.interfaces.find((i) => i.name === (net.status?.iface ?? net.iface));
  const devices = [...net.model.devices.values()];
  const bleInput = bleForReport(lab.ble, insp.created);
  const report = useMemo(
    () =>
      buildReport(
        {
          inspection: insp,
          devices,
          notes: net.liveNotes(),
          network: {
            iface: net.status?.iface ?? null,
            network: iface?.network ?? null,
            methods: net.status?.methods ?? [],
            state: net.state,
            detail: net.status?.detail ?? '',
            // what the devices are, not what the source is now (DEMO picked after a real scan changes nothing listed)
            origin: devices.some((d) => d.origin === 'SIMULATED') || (!devices.length && net.origin === 'SIMULATED') ? 'SIMULATED' : 'PHYSICAL',
            ran: !!net.status && net.status.scan > 0,
            lost: net.lost,
            scanNotes: net.model.notes.map((n) => `${n.method}: ${n.summary}`),
          },
          ble: bleInput,
          usb: { ran: !!usb, supported: usb?.supported ?? false, clues: usb?.clues ?? [] },
          generated: Date.now(),
          lang: browserLang(),
        },
        { maskNetwork, hidePersonal },
      ),
    [net.revision, lab.camera.inspections.revision, lab.ble.revision, usb, maskNetwork, hidePersonal],
  );
  const name = `hwdog-camera-sniffer-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  return (
    <>
      <Panel title="RESULT" info="The strongest conclusion this report can reach is that no clue was identified with the methods used. It never says that a place has no camera or is safe.">
        <p class={`camera-conclusion${report.clues ? ' some' : ''}`}>{report.conclusion}</p>
      </Panel>
      <Panel title="EXPORT" info="What leaves is exactly the preview below. Network identifiers (addresses, MACs, announced names) can be replaced by aliases; personal notes can be hidden. Photos are never in this file.">
        <div class="actions">
          <label class="check">
            <input type="checkbox" checked={maskNetwork} onChange={(e) => setMask((e.target as HTMLInputElement).checked)} /> Mask network identifiers
          </label>
          <label class="check">
            <input type="checkbox" checked={hidePersonal} onChange={(e) => setHide((e.target as HTMLInputElement).checked)} /> Hide place, labels and notes
          </label>
        </div>
        <div class="actions">
          <button
            class="btn primary"
            onClick={() => {
              download(name, report.text);
              instantOp(lab.bus, { source: 'CAMERA', tool: 'camera.report', message: `report exported: ${name}`, kind: 'transfer', origin: net.origin === 'SIMULATED' ? 'SIMULATED' : 'PHYSICAL', params: { masked: maskNetwork, hidden: hidePersonal, clues: report.clues } });
            }}
          >
            EXPORT .MD
          </button>
          <span class="dim">{report.text.length} characters · made here, sent nowhere</span>
        </div>
        <pre class="camera-report" aria-label="Report preview">
          {report.text}
        </pre>
      </Panel>
    </>
  );
}
