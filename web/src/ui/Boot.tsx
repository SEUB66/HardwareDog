import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BUILD, DESCRIPTOR, DOG } from '../core/ascii';
import type { BootStep, System } from '../core/system';
import type { Transport } from '../core/transport';
import { AsciiBanner } from './components/AsciiBanner';
import { Bracket } from './components/Tag';
import { beep } from './sound';

interface BootProps {
  system: System;
  transport: Transport;
  onReady: () => void;
}

/** The machine boots; it does not "load" (spec 08). Every line is a real check. */
export function Boot({ system, transport, onReady }: BootProps) {
  const [steps, setSteps] = useState<BootStep[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pace = system.settings.reducedMotion ? 30 : 85;
    void system
      .boot(transport, (s) => !cancelled && setSteps((prev) => [...prev, s]), pace)
      .then(() => {
        if (cancelled) return;
        setDone(true);
        if (system.settings.sound) beep();
        timer = setTimeout(onReady, 500);
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [system, transport]);

  useEffect(() => {
    if (!done) return;
    const skip = () => onReady();
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [done]);

  const failed = steps.some((s) => s.status === 'FAIL');

  return (
    <main class="boot" aria-live="polite" aria-busy={!done}>
      <div class="logo">
        <AsciiBanner />
      </div>
      <pre class="dog" aria-hidden="true">
        {DOG.map((line, n) => {
          if (n === 1) {
            const at = line.indexOf('@');
            return (
              <Fragment key={n}>
                {line.slice(0, at)}
                <span class="eye">@</span>
                {line.slice(at + 1)}
                {'\n'}
              </Fragment>
            );
          }
          if (n === 2) {
            const at = line.indexOf('O');
            return (
              <Fragment key={n}>
                {line.slice(0, at)}
                <span class="leash">{line.slice(at)}</span>
                {'\n'}
              </Fragment>
            );
          }
          return line + '\n';
        })}
      </pre>
      <pre class="lines">
        {`HARDWARE DOG DIAGNOSTIC SYSTEM\nBUILD ${BUILD}\n\nINITIALIZING...\n\n`}
        {steps.map((s) => (
          <Fragment key={s.label}>
            <Bracket status={s.status} /> {s.label}
            {s.detail ? <span class="dim">{`  ${s.detail}`}</span> : null}
            {'\n'}
          </Fragment>
        ))}
        {done &&
          `\nSOURCE       ${system.transportKind ?? 'NONE'}\nDEVICE       ${system.device.id}\nMODE         LOCAL\nSESSION      READY\n`}
      </pre>
      {done && (
        <pre class="ready">
          <span class={failed ? 'tag WARN' : 'tag OK'}>{failed ? 'SYSTEM READY / DEGRADED' : 'SYSTEM READY'}</span>
          {`\n\n${DESCRIPTOR} // local diagnostic interface`}
        </pre>
      )}
      {done && <p class="skip">press any key</p>}
    </main>
  );
}
