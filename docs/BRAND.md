# HARDWARE DOG / BRAND

```text
STATUS      LOCKED
MASCOT      ONE DOG. THE OFFICIAL ONE.
ASSETS      assets/brand/  (audit: assets/brand/README.md)
PIPELINE    cd web && npm run assets
```

<p align="center">
  <img src="../assets/brand/web/hd-official-full-art-840.webp" alt="Official Hardware Dog" width="320" height="320">
</p>

---

## OFFICIAL DOG

The cream / black robotic dog of `assets/brand/source/hd-official-full-art.png`
and `assets/brand/source/hd-official-head.png`:

```text
[X] cream body and head
[X] black graphic linework
[X] cyan mechanical joints
[X] cyan collar
[X] magenta hardware accents (ear, body plates)
[X] USB cable attached to the collar ring
[X] cyan USB-A connector
[X] calm, proud, upward-looking face
```

## DO NOT SUBSTITUTE THE MASCOT

```text
[ ] no husky            [ ] no wolf              [ ] no sunglasses
[ ] no aggressive dog   [ ] no alternate breed   [ ] no cyberpunk mascot
[ ] no reinterpretation, no redraw, no "improved" version
```

Derivatives are **crops and scales** of the official artwork. Simplifying
for small sizes means removing parts (the USB plug at favicon size), never
drawing new ones. An asset showing any other dog is obsolete and goes to
`assets/brand/archive/`.

The ASCII dog (`docs/DESIGN_SPEC.md` section 05) is the text form of the
identity, not a second mascot.

---

## COLORS

```text
BASE                           SIGNAL
BACKGROUND   #0B0D0F           CYAN    #00E5FF   live data, connection
PANEL        #111417           PINK    #FF4FA3   identity, selection, notable marker
PANEL ALT    #16191C           AMBER   #E4B04A   warning
BORDER       #34393D           GREEN   #79D98A   healthy, pass
TEXT         #ECE8DE           RED     #FF5F56   actual failure only
TEXT DIM     #8A9195
```

Most of the interface is black, charcoal, warm off-white and grey. Color
means system state. Solid fills, 1 px borders, zero radius. No glass, no
blur, no translucent panels, no glow, no decorative gradients.

Source of truth in code: `web/src/styles/tokens.css`.

## TYPOGRAPHY

```text
IBM Plex Mono              interface, values, logs   (400, 600)
IBM Plex Sans Condensed    panel titles              (600)
UPPERCASE                  system states: ONLINE STABLE PASS WARN FAIL
```

Fonts are bundled with the app, never loaded from a CDN.

---

## ASSET ROLES

One image never does every job.

```text
ROLE          FILE                                          SIZE
FULL ART      assets/brand/web/hd-official-full-art-840.webp  README hero, docs cover
LOCKUP        assets/brand/web/hd-lockup-horizontal-1200.webp README / docs, wide areas
HEADER MARK   assets/brand/web/hd-mark-{1,2,3}x.webp          22 px in the app header
APP ICON      web/public/icon-{192,512}.png, apple-touch-icon  OS / PWA shell
MASKABLE      web/public/icon-maskable-512.png                 Android adaptive icon
FAVICON       web/public/favicon.ico, favicon-{16,32}.png      browser tab
SOCIAL / OG   assets/brand/social/hd-og-1200x630.{jpg,webp}    link previews, GitHub social
AVATAR        assets/brand/source/hd-icon-rounded-neon.png     social profile picture only
```

## HEADER RULE

```text
[X] official mark (head + collar), 22 px, loaded eagerly, width/height set
[X] "HW DOG" text: HW warm off-white, DOG magenta
[ ] no full dog          [ ] no USB plug         [ ] no framed banner
[ ] no badge             [ ] no taller header to make room for branding
```

The header is an instrument status bar. Branding serves the instrument.
On phones the mark is dropped: the app icon lives in the OS shell.

## APP ICON RULE

```text
[X] official head + cyan collar + USB cable, on #0B0D0F
[ ] no text   [ ] no full dog   [ ] no HUD frame   [ ] no glow   [ ] no gradient
```

Checked at 16, 32, 64 and 128 px. The maskable variant keeps the art
inside the 80 % safe zone.

## FAVICON RULE

```text
[X] head + collar only, USB masked out
[X] cream face, black outline, magenta ear, cyan collar cue
[X] must read at 16 px
```

The favicon does not tell the whole story. It only has to be recognized.

## SOCIAL IMAGE RULE

```text
[X] 1200 x 630, from assets/brand/source/hd-social-banner.png
[X] full official dog + HARDWARE DOG + hardware companion + SNIFF THE PROBLEM.
[ ] never the favicon or the app icon as an OG image
```

---

## PIPELINE

`web/scripts/build-brand-assets.mjs` regenerates every derivative from
`assets/brand/source/`. Sources are read, never written. Outputs are
metadata-free, sized for their exact display size, WebP where the
browser loads them and PNG / ICO / JPEG where platforms require it.

```text
FAVICON      < 10 KB       HEADER MARK   < 10 KB (all densities)
APP ICON     < 150 KB      SOCIAL        quality first, 1200 x 630
```

> **The mascot is locked. Be creative with the product around him, not
> with the dog.**
