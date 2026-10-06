import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import bootLogo from '../../../assets/brand/web/hd-boot-320.webp';
import { BUILD, DESCRIPTOR } from '../core/ascii';
import type { BootStep, System } from '../core/system';
import type { Transport } from '../core/transport';
import { Bracket } from './components/Tag';
import { beep } from './sound';
import { BootIntro } from './BootIntro';

interface BootProps {
  system: System;
  /** Null: the interface opens with nothing connected (the signature start). */
  transport: Transport | null;
  /** Play the terminal intro first (phase one): when the interface opens, not for each source. */
  intro?: boolean;
  onReady: () => void;
}

/** Between two checks: slow enough to read each one. */
const STEP_MS = 260;
/** Everything checked: a moment to read the result before the interface. */
const HOLD_MS = 2600;

/**
 * The machine boots; it does not "load" (spec 08). Every line is a real
 * check. It plays when the interface opens, and again for each source.
 */
export function Boot(props: BootProps) {
  // Reduced motion: no intro, the checks only.
  const [phase, setPhase] = useState<'intro' | 'checks'>(props.intro && !props.system.settings.reducedMotion ? 'intro' : 'checks');
  if (phase === 'intro') return <BootIntro onDone={() => setPhase('checks')} />;
  return <BootChecks {...props} />;
}

/** Phase two: the real checks, one line each. */
function BootChecks({ system, transport, onReady }: BootProps) {
  const [steps, setSteps] = useState<BootStep[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pace = system.settings.reducedMotion ? 30 : STEP_MS;
    const onStep = (s: BootStep) => !cancelled && setSteps((prev) => [...prev, s]);
    void (transport ? system.boot(transport, onStep, pace) : system.start(onStep, pace))
      .then(() => {
        if (cancelled) return;
        setDone(true);
        if (system.settings.sound) beep();
        timer = setTimeout(onReady, system.settings.reducedMotion ? 500 : HOLD_MS);
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
  const ready = transport ? (failed ? 'SYSTEM READY / DEGRADED' : 'SYSTEM READY') : 'SYSTEM READY / NOT CONNECTED';

  return (
    <main class="boot boot-checks" aria-live="polite" aria-busy={!done}>
      <div class="boot-brand">
        <img class="boot-logo" src={bootLogo} width={160} height={160} alt="Hardware Dog" decoding="sync" />
        <div class="boot-word">
          HARDWARE <b>DOG</b>
        </div>
      </div>
      <div class="boot-card">
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
          (transport
            ? `\nSOURCE       ${system.transportKind ?? 'NONE'}\nDEVICE       ${system.pack ? `${system.dogs.length} DOGS (${system.dogs.map((d) => d.device?.id ?? d.id).join(' ')})` : system.device.id}\nMODE         LOCAL\nSESSION      READY\n`
            : `\nSOURCE       NONE\nDEVICE       --\nMODE         LOCAL\nSESSION      WAITING FOR A SOURCE\n`)}
      </pre>
      {done && (
        <pre class="ready">
          <span class={failed || !transport ? 'tag WARN' : 'tag OK'}>{ready}</span>
          {`\n\n${DESCRIPTOR} // local diagnostic interface`}
        </pre>
      )}
      </div>
      {done && <p class="skip">press any key</p>}
    </main>
  );
}
