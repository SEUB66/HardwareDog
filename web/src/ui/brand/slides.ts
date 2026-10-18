/**
 * HARDWARE DOG / BRAND BANNERS
 *
 * The owner's banners, as slides: the image keeps its own slogans (in
 * English), the caption under it says the same in the interface's
 * language, in words that match what the code does. Brand pictures, never
 * results: nothing here is a measurement or a detection.
 */

import type { Lang } from '../../core/lab/rules';
import noCookies800 from '../../../../assets/brand/web/banners/hd-banner-no-cookies-800.webp';
import noCookies1200 from '../../../../assets/brand/web/banners/hd-banner-no-cookies-1200.webp';
import noCookies1983 from '../../../../assets/brand/web/banners/hd-banner-no-cookies-1983.webp';
import yourData800 from '../../../../assets/brand/web/banners/hd-banner-your-data-800.webp';
import yourData1200 from '../../../../assets/brand/web/banners/hd-banner-your-data-1200.webp';
import yourData1983 from '../../../../assets/brand/web/banners/hd-banner-your-data-1983.webp';
import noLeash800 from '../../../../assets/brand/web/banners/hd-banner-no-leash-800.webp';
import noLeash1200 from '../../../../assets/brand/web/banners/hd-banner-no-leash-1200.webp';
import noLeash1983 from '../../../../assets/brand/web/banners/hd-banner-no-leash-1983.webp';
import lastFix800 from '../../../../assets/brand/web/banners/hd-banner-one-last-fix-800.webp';
import lastFix1200 from '../../../../assets/brand/web/banners/hd-banner-one-last-fix-1200.webp';
import lastFix1983 from '../../../../assets/brand/web/banners/hd-banner-one-last-fix-1983.webp';
import camera800 from '../../../../assets/brand/web/banners/hd-banner-camera-sniffer-800.webp';
import camera1200 from '../../../../assets/brand/web/banners/hd-banner-camera-sniffer-1200.webp';
import camera1983 from '../../../../assets/brand/web/banners/hd-banner-camera-sniffer-1983.webp';
import scanThis800 from '../../../../assets/brand/web/banners/hd-banner-scan-this-800.webp';
import scanThis1200 from '../../../../assets/brand/web/banners/hd-banner-scan-this-1200.webp';
import scanThis1983 from '../../../../assets/brand/web/banners/hd-banner-scan-this-1983.webp';
import human800 from '../../../../assets/brand/web/banners/hd-banner-human-verification-800.webp';
import human1200 from '../../../../assets/brand/web/banners/hd-banner-human-verification-1200.webp';
import human1983 from '../../../../assets/brand/web/banners/hd-banner-human-verification-1983.webp';

export interface BannerSlide {
  id: string;
  /** The slogan on the picture, for the indicators. */
  title: string;
  /** What the picture shows, its text included. */
  alt: string;
  caption: Record<Lang, string>;
  /** Widths 800, 1200 and 1983 (the source); 1983 x 793 for all. */
  src: { '800': string; '1200': string; '1983': string };
}

/** Every banner is 1983 x 793 (about 2.5:1). */
export const BANNER_W = 1983;
export const BANNER_H = 793;

export const HOME_SLIDES: BannerSlide[] = [
  {
    id: 'no-cookies',
    title: 'NO COOKIES.',
    alt: 'Hardware Dog banner: the robot dog frowns at a cookie on a bench. NO COOKIES. No tracking. No account. No subscription. Sniff the hardware. Not the human.',
    caption: {
      en: 'No cookies, no tracker, no account. Settings and sessions stay in this browser.',
      fr: 'Pas de cookies, pas de traqueur, pas de compte. Réglages et sessions restent dans ce navigateur.',
    },
    src: { '800': noCookies800, '1200': noCookies1200, '1983': noCookies1983 },
  },
  {
    id: 'your-data',
    title: 'YOUR DATA. YOUR MACHINE.',
    alt: 'Hardware Dog banner: the robot dog next to a beige computer whose screen shows a LOCAL folder. YOUR DATA. YOUR MACHINE. Local diagnostics. You control the export.',
    caption: {
      en: 'Your diagnostics stay on your machine. You control the export.',
      fr: 'Vos diagnostics restent sur votre machine. Vous contrôlez l’export.',
    },
    src: { '800': yourData800, '1200': yourData1200, '1983': yourData1983 },
  },
  {
    id: 'no-leash',
    title: 'NO LEASH.',
    alt: 'Hardware Dog banner: the robot dog walks away from a cut cable and an open padlock. NO LEASH. No account. No subscription. Your tools. Your rules.',
    caption: {
      en: 'No account, no subscription, no required cloud. dogd runs on your own computer.',
      fr: 'Sans compte, sans abonnement, sans cloud obligatoire. dogd tourne sur votre ordinateur.',
    },
    src: { '800': noLeash800, '1200': noLeash1200, '1983': noLeash1983 },
  },
  {
    id: 'one-last-fix',
    title: 'ONE LAST FIX.',
    alt: 'Hardware Dog banner: Sébastien Germain at his bench, typing next to the robot dog. ONE LAST FIX. Sébastien Germain, senior software developer: full-stack, systems, security. seub.net. Built in Québec since 2003. Signed // Seub G.',
    caption: {
      en: 'Made in Québec by Sébastien Germain (Seub): full-stack, systems, security.',
      fr: 'Créé au Québec par Sébastien Germain (Seub) : full-stack, systèmes, sécurité.',
    },
    src: { '800': lastFix800, '1200': lastFix1200, '1983': lastFix1983 },
  },
];

export const CAMERA_SLIDES: BannerSlide[] = [
  {
    id: 'camera-sniffer',
    title: 'CAMERA SNIFFER',
    alt: 'Camera Sniffer banner: a pixel-art living room seen through a camera lens, the Hardware Dog robot holding a small camera.',
    caption: {
      en: 'Clues and devices to look at: network, Bluetooth, USB, objects.',
      fr: 'Des indices et des appareils à examiner : réseau, Bluetooth, USB, objets.',
    },
    src: { '800': camera800, '1200': camera1200, '1983': camera1983 },
  },
  {
    id: 'scan-this',
    title: 'SCAN THIS. NOT MY FACE.',
    alt: 'Hardware Dog banner: the robot dog holds a cookie up to a surveillance camera while a monitor says FACE NOT FOUND. SCAN THIS. NOT MY FACE. Diagnostics. Not surveillance.',
    caption: {
      en: 'Diagnostics, not surveillance: it reads devices, not people.',
      fr: 'Du diagnostic, pas de la surveillance : des appareils, pas des personnes.',
    },
    src: { '800': scanThis800, '1200': scanThis1200, '1983': scanThis1983 },
  },
  {
    id: 'human-verification',
    title: 'HUMAN VERIFICATION FAILED.',
    alt: 'Hardware Dog banner: an alien holds up a human face mask while the robot dog points a scanner at it. HUMAN VERIFICATION FAILED. Who watches the watchers?',
    caption: {
      en: 'Who watches the watchers? A brand picture, not a detection result.',
      fr: 'Qui surveille les surveillants ? Une image de marque, pas un résultat de détection.',
    },
    src: { '800': human800, '1200': human1200, '1983': human1983 },
  },
];
