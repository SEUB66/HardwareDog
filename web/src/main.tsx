import { render } from 'preact';
// Fonts are bundled, never fetched from a CDN: the interface must work
// offline, served from the device itself (spec 38, local first).
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './ui/App';

render(<App />, document.getElementById('app')!);
