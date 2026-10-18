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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f6f3ee' : '#171619');
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
  // What is on screen at load is painted at once (the largest paint never waits for this script); the rest fades in.
  document.querySelectorAll('.reveal').forEach(el => {
    if (el.getBoundingClientRect().top < innerHeight) return;
    el.classList.add('animate');
    observer.observe(el);
  });
}
const translations: Record<string, string> = {
'Offrir un café à Seub':'Buy Seub a coffee',
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
Object.assign(translations, {
'Retour à l’accueil ↗':'Back to home ↗',
'Technique':'Engineering', 'Pensé comme un système.':'Designed as a system.', 'Construit pour être vérifié.':'Built to be verified.',
'Du navigateur au firmware : des couches séparées, un contrat commun et des preuves reproductibles. Voici le plan, l’état réel et la suite.':'From browser to firmware: separate layers, one shared contract and reproducible evidence. Here is the plan, the actual status and what comes next.',
'Une architecture. Plusieurs sources.':'One architecture. Multiple sources.', 'Matériel · Simulateur · Replay':'Hardware · Simulator · Replay',
'JSON Schema / événements':'JSON Schema / events', 'Trace · Règles':'Trace · Rules', 'Chronologie / diagnostic déterministe':'Timeline / deterministic diagnosis', 'Archive · Rapports':'Archive · Reports',
'Interface Vite, transports séparés du rendu, archive IndexedDB et replay local. Les polices et les images sont embarquées.':'Vite interface, transports separated from rendering, IndexedDB archive and local replay. Fonts and images are bundled.',
'Daemon local pour le lien matériel et les sessions. Adresse loopback par défaut, contrôle des hôtes et des origines autorisées.':'Local daemon for the hardware link and sessions. Loopback address by default, with host and allowed-origin checks.',
'ESP32-S3, INA226, UART et réseau. Le cœur est testé sur PC et en CI; les mesures et les liaisons réelles restent à valider sur carte.':'ESP32-S3, INA226, UART and networking. The core is tested on PC and in CI; actual measurements and links still need validation on a board.',
'Le plan de développement':'The development plan', 'Stabiliser le contrat.':'Stabilize the contract.',
'Valider HDP, les transports, les diagnostics, les sessions scellées et les exports contre les mêmes tests. Chaque incident enregistré peut devenir un cas de régression.':'Validate HDP, transports, diagnostics, sealed sessions and exports against shared tests. Every recorded incident can become a regression case.',
'Confronter le code au réel.':'Test the code against reality.',
'Démarrer la carte ESP32-S3, comparer les INA226 à un instrument de référence et enregistrer des pannes physiques. Le simulateur suit ensuite ces traces.':'Bring up the ESP32-S3 board, compare INA226 sensors against a reference instrument and record physical failures. Then tune the simulator to those traces.',
'Passer du prototype à l’outil.':'Turn the prototype into a tool.',
'Concevoir le PCB après les essais sur banc. Livrer schémas, BOM, Gerbers, protections, procédure de test et documentation avant la version 1.0.':'Design the PCB after bench testing. Deliver schematics, BOM, Gerbers, protection, a test procedure and documentation before version 1.0.',
'Roadmap / par niveau':'Roadmap / by level', 'VALIDATION > CALENDRIER':'VALIDATION > CALENDAR',
'Un niveau est terminé quand sa condition de validation passe. Le code seul ne suffit pas; aucune date de livraison n’est promise ici.':'A level is complete when its validation gate passes. Code alone is not enough; no delivery dates are promised here.',
'Roadmap technique':'Engineering roadmap', 'Niveau':'Level', 'Jalon':'Milestone', 'État':'Status', 'Condition de validation':'Validation gate',
'Socle logiciel & preuves':'Software foundation & evidence', 'Implémenté':'Implemented', 'Partiel':'Partial', 'Planifié':'Planned',
'Enregistrements scellés, diagnostics, cas de régression, dogd et rapports TXT / JSON / HTML / PDF.':'Sealed recordings, diagnostics, regression cases, dogd and TXT / JSON / HTML / PDF reports.',
'Prototype & banc de test':'Prototype & test bench',
'Logiciel et cœur firmware vérifiés. Bring-up, calibration, pannes physiques, Ethernet et I2C à valider sur carte.':'Software and firmware core verified. Bring-up, calibration, physical failures, Ethernet and I2C still need board validation.',
'Prototype éprouvé avant KiCad, schéma, BOM, Gerbers, assemblage et procédure de test.':'Proven prototype before KiCad, schematics, BOM, Gerbers, assembly and a test procedure.',
'Architecture de sondes':'Probe architecture',
'Étendre le système avec des sondes qui produisent le même HDP, sans complexifier le cœur.':'Extend the system with probes that produce the same HDP without complicating the core.',
'Bibliothèque d’incidents':'Incident library',
'Cas anonymisés et reproductibles, proposés par pull request et validés automatiquement avant revue.':'Anonymized, reproducible cases submitted through pull requests and automatically validated before review.',
'Matériel, logiciel, limites de mesure, récupération, sécurité et documentation validés ensemble.':'Hardware, software, measurement limits, recovery, security and documentation validated together.',
'Apprendre des incidents':'Learn from incidents',
'Plus de cas réels, de tests et de règles fiables. Une éventuelle IA locale explique les faits; elle ne remplace pas les preuves.':'More real cases, tests and reliable rules. Any future local AI explains facts; it does not replace evidence.',
'Lire le plan complet ↗':'Read the full plan ↗'
});
Object.assign(translations, {
  'LES OUTILS / DANS LE NAVIGATEUR': 'THE TOOLS / IN YOUR BROWSER',
  'Diagnostic matériel local-first.': 'Local-first hardware diagnostics.',
  'Dans votre navigateur.': 'In your browser.',
  'Camera Sniffer, Bluetooth Lab, Flipper Lab, USB, réseau et série : ce que chaque outil fait vraiment, et ses limites. Une démo fonctionne dans tous les navigateurs.': 'Camera Sniffer, Bluetooth Lab, Flipper Lab, USB, network and serial: what each tool really does, and its limits. A demo works in every browser.',
  'Caméras cachées : des indices, sans app cloud.': 'Hidden cameras: clues, without a cloud app.',
  'Repère des indices de caméras sur un réseau que vous choisissez (avec dogd), en Bluetooth et en USB, et guide une inspection physique objet par objet. Il dit ce qu’il observe : un scan sans indice ne prouve pas qu’il n’y a aucune caméra.': 'Looks for camera clues on a network you choose (with dogd), over Bluetooth and USB, and guides a physical inspection object by object. It says what it observes: a scan with no clue does not prove there is no camera.',
  'Un scanner Bluetooth LE dans le navigateur.': 'A Bluetooth LE scanner in your browser.',
  'Les appareils Bluetooth LE autour de vous, par Web Bluetooth quand le navigateur le permet, ou par dogd sous Linux.': 'The Bluetooth LE devices around you, through Web Bluetooth where the browser allows it, or dogd on Linux.',
  'Flipper Zero par Web Serial, sans app à installer.': 'Flipper Zero over Web Serial, no app to install.',
  'Lire le stockage et les captures d’un Flipper Zero depuis un navigateur Chromium sur ordinateur (Web Serial).': 'Read a Flipper Zero’s storage and captures from a Chromium browser on a computer (Web Serial).',
  'USB · RÉSEAU · SÉRIE': 'USB · NETWORK · SERIAL',
  'La console d’une carte, le réseau de cet ordinateur.': 'A board’s console, this computer’s network.',
  'La console série de n’importe quelle carte dans le navigateur ; le réseau et les périphériques USB de cet ordinateur par dogd, le daemon local optionnel. La sonde Hardware Dog est encore en développement.': 'Any board’s serial console in the browser; this computer’s network and USB devices through dogd, the optional local daemon. The Hardware Dog probe is still in development.',
  'Les outils': 'The tools',
  'Architecture.': 'Architecture.',
  'Plans & contrats.': 'Plans & contracts.',
  'Les documents du dépôt, directement. Schémas texte, couches du système, câblage et conditions de validation.': 'Straight from the repository: text diagrams, system layers, wiring and validation gates.',
  'Prototype : câblage par défaut. Bring-up et calibration sur carte encore à valider. GPIO 3.3 V; UART 5 V avec adaptation de niveau.': 'Prototype: default wiring. Board bring-up and calibration still pending. GPIO 3.3 V; 5 V UART requires a level shifter.',
});
if (language === 'en') {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const original = node.textContent || '';
    const key = original.trim();
    if (node.parentElement?.closest('pre')) continue;
    if (translations[key]) node.textContent = original.replace(key, translations[key]);
  }
  document.querySelectorAll('[alt],[aria-label]').forEach(el => {
    for (const attr of ['alt', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (value && translations[value]) el.setAttribute(attr, translations[value]);
    }
  });
  const engineering = document.body.dataset.page === 'engineering';
  document.title = engineering ? 'Hardware Dog — Architecture & roadmap' : 'Hardware Dog — Camera Sniffer & Hardware Diagnostics';
  document.querySelector('meta[name="description"]')?.setAttribute('content', engineering ? 'Hardware Dog architecture, development plan and roadmap: TypeScript, Rust, ESP32-S3 firmware and verifiable evidence.' : 'Local-first hardware diagnostic tool in your browser: hidden camera clues without a cloud app, a Bluetooth LE scanner, Flipper Zero over Web Serial. No account. No tracking.');
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
    const targets = document.querySelectorAll<HTMLElement>('.stack-card,.architecture,.roadmap,.law,.terminal,.mascot,.official-lockup,.official-dog,.creator-avatar,.creator-photo,.creator-story,.how>div,.signal-panel');
    targets.forEach(card => card.classList.add('tilt-target'));
    targets.forEach(card => {
      // Tilt only the outermost surface: nested images move with their card.
      if (card.parentElement?.closest('.tilt-target')) return;
      card.classList.add('tilt-ready');
      let rect: DOMRect;
      let targetX = 0, targetY = 0, currentX = 0, currentY = 0;
      let frame = 0;
      const render = () => {
        currentX += (targetX - currentX) * 0.16;
        currentY += (targetY - currentY) * 0.16;
        card.style.setProperty('--rx', `${currentX.toFixed(3)}deg`);
        card.style.setProperty('--ry', `${currentY.toFixed(3)}deg`);
        if (Math.abs(targetX - currentX) + Math.abs(targetY - currentY) > 0.015) frame = requestAnimationFrame(render);
        else frame = 0;
      };
      const start = () => { if (!frame) frame = requestAnimationFrame(render); };
      card.addEventListener('pointerenter', () => {
        // Freeze the unrotated bounds; transformed bounds cause feedback jitter.
        rect = card.getBoundingClientRect();
        card.classList.add('tilt-active');
      });
      card.addEventListener('pointermove', event => {
        if (!rect) return;
        const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
        card.style.setProperty('--mx', `${x * 100}%`);
        card.style.setProperty('--my', `${y * 100}%`);
        targetX = (0.5 - y) * 24;
        targetY = (x - 0.5) * 24;
        start();
      });
      const reset = () => {
        targetX = targetY = 0;
        card.classList.remove('tilt-active');
        start();
      };
      card.addEventListener('pointerleave', reset);
      card.addEventListener('pointercancel', reset);
      addEventListener('blur', reset);
    });
  }
}
