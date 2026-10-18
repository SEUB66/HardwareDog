import { render } from 'preact';
// Fonts are bundled, never fetched from a CDN: the interface must work
// offline, served from the device itself (spec 38, local first).
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
// Descriptions read at length (home, banners): the condensed sans, regular.
import '@fontsource/ibm-plex-sans-condensed/latin-400.css';
// The pixel lettering of the banners, for short titles only.
import '@fontsource/silkscreen/latin-400.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/glass.css';
import './styles/lab.css';
import './styles/home.css';
import { SessionArchive } from './core/archive';
import { BUILD } from './core/ascii';
import { createLab } from './core/lab/context';
import { App } from './ui/App';

// Sessions are recorded in this browser (IndexedDB), or in memory when the
// browser refuses storage. Opening the archive takes a few milliseconds.
// The lab (Flipper, Bluetooth, the companion TV) is created once, for every screen.
const reduced = () => document.documentElement.dataset['motion'] === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
void Promise.all([SessionArchive.open(), createLab(`hwdog-web ${BUILD}`, reduced)]).then(([archive, lab]) => render(<App archive={archive} lab={lab} />, document.getElementById('app')!));
