/**
 * HARDWARE DOG / INSTALL AND UPDATE, ON SCREEN
 *
 * UpdateNote: a new version is ready, or another tab already started it.
 * RELOAD is offered only when a reload cuts nothing (no operation, no
 * recording); otherwise it says what it waits for. Nothing reloads on its
 * own.
 *
 * InstallCard (home): INSTALL opens the browser's own install prompt where
 * the browser offers one; on iPhone and iPad a plain line says how (Share,
 * Add to Home Screen): never an imitation of a system prompt. It can be
 * put away; Hardware Dog works the same without installing.
 */

import type { Lab } from '../core/lab/context';
import type { Lang } from '../core/lab/rules';
import { pwa, updateBlocker } from '../core/pwa';
import { local, useRev } from './lab/useRev';

export function UpdateNote({ lab, recording }: { lab: Lab; recording: boolean }) {
  useRev(pwa);
  useRev(lab.companion);
  useRev(lab.sessions);
  if (!pwa.update && !pwa.elsewhere) return null;
  const blocker = updateBlocker({ operations: lab.companion.operations.length, recording, labRecording: !!lab.sessions.recorder?.recording });
  const wait = blocker ? `It waits until nothing is running: ${blocker}.` : 'Reloading starts it; nothing is running now.';
  return (
    <div class="update-note" role="status">
      <span>
        {pwa.elsewhere ? (
          <>
            <b>UPDATED IN ANOTHER TAB.</b> This tab still runs the previous version. {wait}
          </>
        ) : (
          <>
            <b>NEW VERSION READY.</b> {wait}
            {pwa.stalled && ' It did not start: press RELOAD again, or close the other Hardware Dog tabs.'}
          </>
        )}
      </span>
      <button class="btn" disabled={!!blocker} title={blocker ?? 'Reload into the new version'} onClick={() => pwa.applyUpdate()}>
        RELOAD
      </button>
    </div>
  );
}

const KEY = 'hwdog.install.hidden';

export function InstallCard({ lang }: { lang: Lang }) {
  useRev(pwa);
  const fr = lang === 'fr';
  if (local.get<boolean>(KEY, false) || (pwa.install !== 'available' && pwa.install !== 'ios')) return null;
  const hide = () => {
    local.set(KEY, true);
    pwa.dismissInstall();
  };
  return (
    <aside class="install-card" aria-label={fr ? 'Installer Hardware Dog' : 'Install Hardware Dog'}>
      {pwa.install === 'available' ? (
        <>
          <p>
            {fr
              ? 'Installer Hardware Dog : sa propre fenêtre, et l’interface s’ouvre hors ligne après cette visite. Rien n’est obligatoire.'
              : 'Install Hardware Dog: its own window, and the interface opens offline after this visit. Nothing requires it.'}
          </p>
          <button class="btn primary" onClick={() => void pwa.promptInstall()}>
            {fr ? 'INSTALLER' : 'INSTALL'}
          </button>
        </>
      ) : (
        <p>
          {fr
            ? 'Sur iPhone ou iPad : touchez Partager, puis « Sur l’écran d’accueil ». Hardware Dog marche aussi sans l’installer.'
            : 'On iPhone or iPad: tap Share, then “Add to Home Screen”. Hardware Dog works the same without installing.'}
        </p>
      )}
      <button class="link" onClick={hide}>
        {fr ? 'masquer' : 'hide'}
      </button>
    </aside>
  );
}
