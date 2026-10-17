/**
 * HARDWARE DOG / WHAT'S NEW
 *
 * The features worth showing when the interface opens, newest first. A new
 * section is one entry here (and its banner): the What's New screen, the
 * NEW mark in the menu and the links to it follow. Nothing is fetched: the
 * list ships with the interface.
 */

import type { Screen } from './commands';

export interface Feature {
  id: string;
  screen: Screen;
  name: string;
  /** One line, in the browser's language when given. */
  pitch: { en: string; fr: string };
  /** Added in this version of the interface (for the NEW mark). */
  since: string;
  /** Marked NEW in the menu. */
  isNew: boolean;
}

export const FEATURES: Feature[] = [
  {
    id: 'camera-sniffer',
    screen: 'CAMERA',
    name: 'CAMERA SNIFFER',
    pitch: {
      en: 'Spot the clues. Inspect the devices. Local network, Bluetooth, USB, an offline catalog of objects and a guided inspection.',
      fr: 'Repérer les indices. Inspecter les appareils. Réseau local, Bluetooth, USB, catalogue d’objets hors ligne et inspection guidée.',
    },
    since: '2026-10-17',
    isNew: true,
  },
  {
    id: 'companion-tv',
    screen: 'FLIPPER',
    name: 'COMPANION TV',
    pitch: {
      en: 'The orange TV and its companion, drawn scene by scene: it follows what the lab tools do. Float it, drag it, on a phone too.',
      fr: 'La télé orange et son compagnon, dessiné scène par scène : il suit ce que font les outils. Flottante et déplaçable, au doigt aussi.',
    },
    since: '2026-10-17',
    isNew: false,
  },
  {
    id: 'bluetooth-lab',
    screen: 'BLE',
    name: 'BLUETOOTH LAB',
    pitch: { en: 'Our own BLE scanner, inspector and GATT client. Local, offline.', fr: 'Notre propre scanner BLE, inspecteur et client GATT. Local, hors ligne.' },
    since: '2026-10-17',
    isNew: false,
  },
  {
    id: 'flipper-lab',
    screen: 'FLIPPER',
    name: 'FLIPPER LAB',
    pitch: { en: 'Your Flipper Zero over USB: files, captures, a local library. Optional.', fr: 'Ton Flipper Zero en USB : fichiers, captures, bibliothèque locale. Optionnel.' },
    since: '2026-10-17',
    isNew: false,
  },
];

export const isNewScreen = (s: Screen): boolean => FEATURES.some((f) => f.isNew && f.screen === s);
