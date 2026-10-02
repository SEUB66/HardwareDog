import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import './styles/landing.css';
const themeButton = document.querySelector<HTMLButtonElement>('#theme')!;
const language = (navigator.languages[0] || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
document.documentElement.lang = language;
const systemTheme = matchMedia('(prefers-color-scheme: light)');
let light = systemTheme.matches;
let manualTheme = false;
function applyTheme() {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  themeButton.textContent = light ? (language === 'fr' ? '☾ Sombre' : '☾ Dark') : (language === 'fr' ? '☀ Clair' : '☀ Light');
  themeButton.setAttribute('aria-label', language === 'fr' ? (light ? 'Activer le mode sombre' : 'Activer le mode clair') : (light ? 'Switch to dark mode' : 'Switch to light mode'));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f3f4f0' : '#0b0d0f');
}
applyTheme();
themeButton.addEventListener('click', () => {
  light = !light;
  manualTheme = true;
  applyTheme();
});
systemTheme.addEventListener('change', event => { if (!manualTheme) { light = event.matches; applyTheme(); } });
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  document.querySelectorAll('.reveal').forEach(el => { el.classList.add('animate'); observer.observe(el); });
}
const translations: Record<string, string> = {
'Gratuit pour usage personnel · Code public':'Free for personal use · Public source',
'Du code.':'Code.', 'Des circuits.':'Circuits.', 'Du concret.':'Real things.',
'Créateur de Hardware Dog. Une idée simple : comprendre les machines avec des outils qui restent entre vos mains.':'Creator of Hardware Dog. One simple idea: understand machines with tools that stay in your hands.',
'Découvrir seub.net':'Discover seub.net', 'Hardware Dog sur GitHub':'Hardware Dog on GitHub',
'Seub à son bureau avec son chien':'Seub at his desk with his dog',
'Seub dans son atelier, devant un projet mécanique':'Seub in his workshop with a mechanical project',
'Avatar officiel du chien Hardware Dog':'Official Hardware Dog avatar',
'Aller au contenu':'Skip to content', 'Les lois':'The laws', 'Le principe':'How it works', 'Ouvrir l’outil ↗':'Open the tool ↗',
'Votre matériel.':'Your hardware.', 'Vos données.':'Your data.', 'Vos règles.':'Your rules.',
'Un compagnon de diagnostic qui cherche ce qui s’est réellement passé. Pas votre adresse courriel.':'A diagnostic companion that investigates what actually happened. It never asks for your email.',
'Ouvrir le diagnostic ↗':'Open diagnostics ↗', 'Lire les lois ↓':'Read the laws ↓',
'Sans compte. Sans abonnement. Démo dans le navigateur.':'No account. No subscription. Try it in your browser.',
'compte requis':'account required', 'abonnement':'subscription', 'données':'data', 'contrôle':'control', 'NON':'NO', 'LOCALES':'LOCAL', 'VOUS':'YOU',
'01 / AUCUN COMPTE':'01 / NO ACCOUNT', '02 / AUCUN ABONNEMENT':'02 / NO SUBSCRIPTION', '03 / AUCUN CLOUD OBLIGATOIRE':'03 / NO REQUIRED CLOUD', '04 / VOS PREUVES RESTENT À VOUS':'04 / YOUR EVIDENCE IS YOURS',
'LE MANIFESTE / 05 LOIS':'THE MANIFESTO / 05 LAWS', 'Le logiciel vous sert.':'Software serves you.', 'Il ne vous retient pas.':'It never holds you hostage.',
'Des limites d’architecture, pas des promesses marketing. Les lois vérifiables sont testées dans le projet.':'Architecture boundaries, not marketing promises. The project tests the laws that can be verified.',
'Une seule chronologie.':'One shared timeline.',
'Le matériel, le simulateur et les enregistrements parlent le même langage. Un modèle d’événement, une horloge, une timeline pour comprendre l’incident.':'Hardware, the simulator and recordings speak the same language. One event model, one clock, one timeline to understand the incident.',
'Une panne. Un test.':'One failure. One test.',
'Un incident enregistré peut devenir un test reproductible. Une panne rencontrée une fois aide à améliorer le diagnostic pour la suite.':'A recorded incident can become a reproducible test. A failure encountered once makes future diagnostics better.',
'Local, par principe.':'Local, by principle.',
'Aucun compte. Aucun abonnement. Aucune télémétrie par défaut. Capturer, diagnostiquer, enregistrer, rejouer et exporter sans cloud obligatoire.':'No account. No subscription. No telemetry by default. Capture, diagnose, record, replay and export without a required cloud.',
'Pas de courriel':'No email required', 'Pas de paywall à l’export':'No export paywall', 'Pas de serveur de licence requis':'No required license server',
'Pas de fausse certitude.':'No fake certainty.',
'Des faits observés, une corrélation, une cause possible et un prochain contrôle. Un diagnostic explique sa confiance et ses limites.':'Observed facts, a correlation, a possible cause and a next check. A diagnosis explains its confidence and its limits.',
'Les preuves restent des preuves.':'Evidence stays evidence.',
'Les enregistrements sont scellés par SHA-256. Une source simulée reste étiquetée SIMULATED. Un fichier altéré est signalé MODIFIED.':'Recordings are sealed with SHA-256. A simulated source stays labeled SIMULATED. An altered file is flagged MODIFIED.',
'BROWSER DIRECT / ZÉRO INSCRIPTION':'BROWSER DIRECT / ZERO SIGN-UP', 'Ouvrez.':'Open.', 'Explorez.':'Explore.', 'Comprenez.':'Understand.',
'Ouvrir la démo':'Open the demo',
'L’interface et ses scénarios simulés fonctionnent dans le navigateur. Aucun logiciel à installer pour les essayer.':'The interface and its simulated scenarios run in your browser. No software installation needed to try them.',
'Suivre les événements':'Follow the events',
'Alimentation, USB, série et réseau : les événements se retrouvent sur une chronologie commune.':'Power, USB, serial and network: events come together on one shared timeline.',
'Garder le contrôle':'Stay in control',
'Vos sessions restent locales. Le daemon Rust dogd est optionnel et local. Le matériel physique est encore en développement.':'Your sessions stay local. The Rust daemon dogd is optional and local. Physical hardware is still in development.',
'Lancer les scénarios simulés →':'Run the simulated scenarios →', 'Un outil.':'A tool.', 'Pas une dépendance.':'Not a dependency.',
'Entrer dans Hardware Dog ↗':'Enter Hardware Dog ↗', 'Code public · Licence PolyForm Noncommercial 1.0.0':'Public source · PolyForm Noncommercial 1.0.0 license',
'Explorer le repo GitHub ↗':'Explore the GitHub repo ↗', 'Les lois ↑':'The laws ↑',
'Navigation principale':'Main navigation', 'Hardware Dog — hardware companion':'Hardware Dog — hardware companion',
'Bannière officielle Hardware Dog : chien robot, câble USB et SNIFF THE PROBLEM':'Official Hardware Dog banner: robotic dog, USB cable and SNIFF THE PROBLEM',
'Illustration officielle du chien Hardware Dog':'Official Hardware Dog illustration'
};
if (language === 'en') {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const original = node.textContent || '';
    const key = original.trim();
    if (translations[key]) node.textContent = original.replace(key, translations[key]);
  }
  document.querySelectorAll('[alt],[aria-label]').forEach(el => {
    for (const attr of ['alt', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (value && translations[value]) el.setAttribute(attr, translations[value]);
    }
  });
  document.title = 'Hardware Dog — Your hardware. Your rules.';
  document.querySelector('meta[name="description"]')?.setAttribute('content', 'Hardware Dog: local hardware diagnostics. No account, no subscription, no required cloud.');
}
const motion = matchMedia('(prefers-reduced-motion: reduce)');
if (!motion.matches) {
  const progress = document.createElement('div');
  progress.className = 'reading-progress';
  progress.setAttribute('aria-hidden', 'true');
  document.body.append(progress);
  let ticking = false;
  const updateProgress = () => {
    const range = document.documentElement.scrollHeight - innerHeight;
    progress.style.transform = `scaleX(${range > 0 ? scrollY / range : 0})`;
    ticking = false;
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateProgress); } }, { passive: true });
  updateProgress();
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.querySelectorAll<HTMLElement>('.law,.terminal,.mascot').forEach(card => {
      card.addEventListener('pointermove', event => {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        card.style.setProperty('--mx', `${x * 100}%`);
        card.style.setProperty('--my', `${y * 100}%`);
        card.style.setProperty('--rx', `${(0.5 - y) * 5}deg`);
        card.style.setProperty('--ry', `${(x - 0.5) * 5}deg`);
      });
      card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
    });
  }
}
