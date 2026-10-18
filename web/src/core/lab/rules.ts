/**
 * HARDWARE DOG / COMPANION RULES
 *
 * Local rules turn a lab event into a short suggestion: what happened, the
 * next thing to check. No remote AI, no guess dressed as a fact: a rule
 * matches an exact code or state, and the code is shown as it was given.
 * An event with no matching rule says nothing on the TV (the log keeps it).
 */

import type { LabAction, LabEvent } from './events';
import type { Suggestion } from './messages';

export type Lang = 'en' | 'fr';

export const browserLang = (): Lang => (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en');

type Text = Record<Lang, string>;

/** Messages by key. `{x}` is replaced by the event's param x. */
const TEXT: Record<string, Text> = {
  'link.lost': { en: 'Connection lost. Check the USB cable.', fr: 'Connexion interrompue. Vérifie le câble USB.' },
  'link.connected': { en: 'Flipper connected. Read-only until you ask.', fr: 'Flipper connecté. Lecture seule tant que tu ne demandes rien.' },
  'link.absent': { en: 'No Flipper picked. Plug it in, then CONNECT.', fr: 'Aucun Flipper choisi. Branche-le, puis CONNECT.' },
  'serial.unsupported': { en: 'This browser has no Web Serial. Use Chrome, Edge or Opera.', fr: 'Ce navigateur n’a pas Web Serial. Utilise Chrome, Edge ou Opera.' },
  'serial.cancelled': { en: 'No port chosen.', fr: 'Aucun port choisi.' },
  'serial.denied': { en: 'Access to the port was refused.', fr: 'Accès au port refusé.' },
  'serial.busy': { en: 'The port may be open elsewhere (qFlipper, a terminal). Close it, retry.', fr: 'Le port est peut-être ouvert ailleurs (qFlipper, un terminal). Ferme-le, réessaie.' },
  'rpc.timeout': { en: 'No answer from the Flipper in time.', fr: 'Pas de réponse du Flipper à temps.' },
  'rpc.busy': { en: 'The Flipper is busy: an app holds it. Exit the app on the device.', fr: 'Le Flipper est occupé : une app le retient. Quitte-la sur l’appareil.' },
  'rpc.sd': { en: 'The SD card is not ready. Is it inserted?', fr: 'La carte SD n’est pas prête. Est-elle insérée ?' },
  'rpc.exists': { en: 'That name already exists on the Flipper. Nothing was overwritten.', fr: 'Ce nom existe déjà sur le Flipper. Rien n’a été écrasé.' },
  'rpc.notexist': { en: 'That path does not exist on the Flipper.', fr: 'Ce chemin n’existe pas sur le Flipper.' },
  'rpc.denied': { en: 'The Flipper refused access to that path.', fr: 'Le Flipper a refusé l’accès à ce chemin.' },
  'rpc.notimpl': { en: 'This firmware does not implement that command.', fr: 'Ce firmware n’implémente pas cette commande.' },
  'rpc.other': { en: 'The Flipper answered with an error.', fr: 'Le Flipper a répondu par une erreur.' },
  'file.invalid': { en: 'This file could not be read as a known format.', fr: 'Ce fichier n’a pas pu être lu dans un format connu.' },
  'copy.done': { en: 'Copied to this computer: {name}.', fr: 'Copié sur cet ordinateur : {name}.' },
  'ble.unsupported': { en: 'Web Bluetooth is not available here. dogd can scan on Linux.', fr: 'Web Bluetooth n’est pas disponible ici. dogd peut scanner sous Linux.' },
  'ble.noadapter': { en: 'No Bluetooth adapter found.', fr: 'Aucun adaptateur Bluetooth trouvé.' },
  'ble.denied': { en: 'Bluetooth permission was refused.', fr: 'Permission Bluetooth refusée.' },
  'ble.gattlost': { en: 'The BLE device disconnected. Nothing will be resent on its own.', fr: 'L’appareil BLE s’est déconnecté. Rien ne sera renvoyé tout seul.' },
  'op.failed': { en: 'Failed: {what}.', fr: 'Échec : {what}.' },
  'cam.searching': { en: 'Searching the selected network.', fr: 'Recherche sur le réseau sélectionné.' },
  'cam.video': { en: 'Video service to examine.', fr: 'Service vidéo à examiner.' },
  'cam.unidentified': { en: 'This device is not identified yet.', fr: 'Cet appareil n’est pas encore identifié.' },
  'cam.visual': { en: 'This check needs a visual inspection.', fr: 'Cette vérification nécessite une inspection visuelle.' },
  'cam.done': { en: 'Inspection finished. Some devices can stay invisible to scans.', fr: 'Inspection terminée. Certains appareils peuvent rester invisibles aux scans.' },
  'cam.netdone': { en: 'Network scan finished. Some devices can stay invisible to scans.', fr: 'Scan réseau terminé. Certains appareils peuvent rester invisibles aux scans.' },
  'cam.dogd': { en: 'Network discovery needs dogd running on this computer.', fr: 'La découverte réseau nécessite dogd sur cet ordinateur.' },
  'dev.connected': { en: 'Device connected.', fr: 'Appareil connecté.' },
  'dev.lost': { en: 'Device link lost. Check the USB cable.', fr: 'Liaison avec l’appareil perdue. Vérifie le câble USB.' },
  'dev.dogd': { en: 'dogd was not reached on this computer. Start it, then retry.', fr: 'dogd est injoignable sur cet ordinateur. Lance-le, puis réessaie.' },
  permission: { en: 'Permission needed to continue.', fr: 'Permission nécessaire pour continuer.' },
  'scan.running': { en: 'Scan running…', fr: 'Scan en cours…' },
  'ble.adapter': { en: 'Bluetooth adapter disconnected.', fr: 'Adaptateur Bluetooth déconnecté.' },
  'export.done': { en: 'Export finished.', fr: 'Export terminé.' },
  cancelled: { en: 'Cancelled.', fr: 'Annulé.' },
};

/** Camera Sniffer messages: neutral words, never an alarm. A success means an operation finished, not that a place is safe. */
export const CAMERA_MESSAGES = ['cam.searching', 'cam.video', 'cam.unidentified', 'cam.visual', 'cam.done', 'cam.netdone', 'cam.dogd'] as const;

/** A message text in a language, for showing it outside the TV too. */
export const messageText = (key: string, lang: Lang): string | null => TEXT[key]?.[lang] ?? null;

const fill = (template: string, params: LabEvent['params']) => template.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const retry = (command: string, lang: Lang): LabAction => ({ label: lang === 'fr' ? 'Réessayer' : 'Retry', command });
const details = (lang: Lang): LabAction => ({ label: lang === 'fr' ? 'Voir les détails' : 'Details', command: 'lab.log' });

function say(key: string, e: LabEvent, lang: Lang, actions?: LabAction[]): Suggestion {
  const s: Suggestion = { key: `${e.source}:${key}:${e.code ?? ''}`, severity: e.severity, text: fill(TEXT[key]![lang], e.params) };
  if (e.code) s.code = e.code;
  if (actions) s.actions = actions;
  return s;
}

/** Codes a Flipper RPC answer can carry (CommandStatus), mapped to a message. */
const RPC_CODES: Record<string, string> = {
  ERROR_BUSY: 'rpc.busy',
  ERROR_APP_SYSTEM_LOCKED: 'rpc.busy',
  ERROR_STORAGE_NOT_READY: 'rpc.sd',
  ERROR_STORAGE_EXIST: 'rpc.exists',
  ERROR_STORAGE_NOT_EXIST: 'rpc.notexist',
  ERROR_STORAGE_DENIED: 'rpc.denied',
  ERROR_NOT_IMPLEMENTED: 'rpc.notimpl',
  ERROR_STORAGE_NOT_IMPLEMENTED: 'rpc.notimpl',
};

/** Tools whose successful end is a file handed to the person: an export. */
const EXPORTS = /(^|\.)(report|export)$/;

export function suggest(e: LabEvent, lang: Lang): Suggestion | null {
  // An operation waiting for the person (a chooser, a permission prompt): said once, whatever the tool.
  if ((e.type === 'op.start' || e.type === 'op.progress') && e.params?.['wait'] === 'user') return say('permission', { ...e, severity: 'INFO' }, lang);
  if (e.type === 'op.start' && e.params?.['kind'] === 'search' && e.source !== 'CAMERA') return say('scan.running', { ...e, severity: 'INFO' }, lang);
  if (e.type === 'op.end' && e.severity === 'PASS' && EXPORTS.test(e.tool)) return say('export.done', e, lang);
  if (e.source === 'DEVICE') {
    if (e.type === 'link.state') {
      const state = e.params?.['state'];
      if (state === 'CONNECTED') return say('dev.connected', { ...e, severity: 'PASS' }, lang);
      if (state === 'DISCONNECTED' && e.params?.['reason'] === 'lost') return say('dev.lost', { ...e, severity: 'FAIL' }, lang, [details(lang)]);
      return null;
    }
    if (e.type === 'op.end' && e.code === 'DOGD_UNREACHABLE') return say('dev.dogd', e, lang, [retry('device.dogd', lang), details(lang)]);
  }
  if (e.type === 'op.end' && e.params?.['outcome'] === 'stopped') return null;
  if (e.type === 'op.end' && (e.code === 'CANCELLED' || e.code === 'ABORTED' || e.params?.['outcome'] === 'cancelled') && e.source !== 'CAMERA')
    return say('cancelled', { ...e, severity: 'INFO' }, lang);
  if (e.source === 'CAMERA') {
    const key = e.params?.['say'];
    if (typeof key === 'string' && TEXT[key]) return say(key, { ...e, severity: e.severity === 'FAIL' ? 'FAIL' : 'INFO' }, lang);
    if (e.type === 'op.end' && e.severity === 'FAIL' && (e.code === 'DOGD_ABSENT' || e.code === 'DOGD_LOST')) return say('cam.dogd', e, lang, [details(lang)]);
    if (e.type !== 'op.end' || e.severity !== 'FAIL') return null;
  }
  if (e.type === 'link.state') {
    const state = e.params?.['state'];
    if (e.source === 'FLIPPER') {
      if (state === 'DISCONNECTED' && e.params?.['reason'] === 'lost') return say('link.lost', { ...e, severity: 'FAIL' }, lang, [retry('flipper.connect', lang), details(lang)]);
      if (state === 'CONNECTED') return say('link.connected', { ...e, severity: 'PASS' }, lang);
    }
    if (e.source === 'BLE' && state === 'DISCONNECTED' && e.params?.['reason'] === 'lost') return say('ble.gattlost', { ...e, severity: 'WARN' }, lang, [details(lang)]);
    return null;
  }
  if (e.type !== 'op.end' || e.severity === 'PASS' || e.severity === 'INFO') {
    if (e.type === 'op.end' && e.severity === 'PASS' && e.params?.['copied']) return say('copy.done', e, lang);
    return null;
  }
  const code = e.code ?? '';
  const connect = e.source === 'FLIPPER' ? 'flipper.connect' : e.source === 'DEVICE' ? 'device.connect' : 'ble.start';
  switch (code) {
    case 'SERIAL_UNSUPPORTED':
      return say('serial.unsupported', e, lang);
    case 'NotFoundError':
      return e.source === 'BLE' ? say('ble.noadapter', e, lang, [details(lang)]) : say('serial.cancelled', { ...e, severity: 'INFO' }, lang);
    case 'SecurityError':
    case 'NotAllowedError':
      return say(e.source === 'BLE' ? 'ble.denied' : 'serial.denied', e, lang, [details(lang)]);
    case 'NetworkError':
    case 'InvalidStateError':
      return e.source === 'FLIPPER' ? say('serial.busy', e, lang, [retry(connect, lang), details(lang)]) : say('ble.gattlost', e, lang, [details(lang)]);
    case 'TIMEOUT':
      return say('rpc.timeout', e, lang, [retry(connect, lang), details(lang)]);
    case 'BLE_UNSUPPORTED':
      return say('ble.unsupported', e, lang, [details(lang)]);
    case 'BLE_NO_ADAPTER':
      return say(e.params?.['phase'] === 'running' ? 'ble.adapter' : 'ble.noadapter', e, lang, [details(lang)]);
    case 'FORMAT_INVALID':
      return say('file.invalid', e, lang, [details(lang)]);
  }
  if (RPC_CODES[code]) return say(RPC_CODES[code], e, lang, [details(lang)]);
  if (code.startsWith('ERROR')) return say('rpc.other', e, lang, [details(lang)]);
  return say('op.failed', { ...e, params: { ...e.params, what: e.message } }, lang, [details(lang)]);
}
