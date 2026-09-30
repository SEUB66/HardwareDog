/**
 * The ASCII identity (spec 05). Used by the boot screen, the help screen
 * and every exported report, so it lives in core, not in the UI.
 */

export const BANNER = String.raw`██╗  ██╗██╗    ██╗    ██████╗  ██████╗  ██████╗
██║  ██║██║    ██║    ██╔══██╗██╔═══██╗██╔════╝
███████║██║ █╗ ██║    ██║  ██║██║   ██║██║  ███╗
██╔══██║██║███╗██║    ██║  ██║██║   ██║██║   ██║
██║  ██║╚███╔███╔╝    ██████╔╝╚██████╔╝╚██████╔╝
╚═╝  ╚═╝ ╚══╝╚══╝     ╚═════╝  ╚═════╝  ╚═════╝`;

/** The dog on its USB leash. Split so the UI can color the leash and eye. */
export const DOG = [
  '           / \\__',
  '          (    @\\___',
  '          /         O================[ USB ]',
  '         /   (_____/',
  '        /_____/   \\',
] as const;

export const DOG_TEXT = DOG.join('\n');

export const DESCRIPTOR = 'hardware companion';
export const TAGLINE = 'SNIFF THE PROBLEM.';
export const BUILD = '0.1.0';
