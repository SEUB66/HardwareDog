import { render } from 'preact';
// Fonts are bundled, never fetched from a CDN: the interface must work
// offline, served from the device itself (spec 38, local first).
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import './styles/tokens.css';
import './styles/app.css';
import { SessionArchive } from './core/archive';
import { App } from './ui/App';

// Sessions are recorded in this browser (IndexedDB), or in memory when the
// browser refuses storage. Opening the archive takes a few milliseconds.
void SessionArchive.open().then((archive) => render(<App archive={archive} />, document.getElementById('app')!));
