# HARDWARE DOG / AUDIT DE SÉCURITÉ — novembre 2026

```text
PÉRIMÈTRE   dogd (Linux, Windows, macOS), interface web (Netlify), installeur,
            firmware (cœur HDP + build ESP32-S3), CI / release, dépendances,
            historique git, permissions, parsing (hdlog, packs, HDP)
COMMIT      02b106b (main, 2026-11-19)
MÉTHODE     lecture du code, recherche de secrets dans les 198 commits,
            npm audit, cargo audit (RustSec), tous les tests et builds
RÈGLE       ne rien casser: seuls des correctifs petits et sans changement
            d'API sont appliqués; le reste est une recommandation
```

Ce document complète [SECURITY.md](SECURITY.md), qui décrit le modèle de
menace et les protections en place. Il ne le répète pas: il dit ce que l'audit
a vérifié, ce qu'il a trouvé, ce qui est corrigé dans cette PR, et ce qui
reste à décider.

---

## 1. VERDICT

La base est **saine et déjà durcie** : dogd n'écoute que sur 127.0.0.1, refuse
le DNS rebinding, vérifie l'Origin (fail-closed), limite connexions et
en-têtes, stocke en 0600/0700 sous un nom qu'aucun client ne choisit ; le site
a une CSP stricte sans script tiers ; les actions CI sont épinglées par commit
avec des permissions minimales ; les builds sont reproductibles et les
releases attestées (Sigstore). Aucun secret dans le dépôt ni dans son
historique.

Le risque principal n'est pas un bug, c'est **un choix de conception** :
par défaut, dogd fait confiance à la page `https://hardwaredog.org`
(constat H1). Qui contrôle ce site (compte Netlify/Cloudflare, DNS, dépôt
GitHub, une dépendance npm compromise) contrôle le dogd de chaque
utilisateur : écrire sur le matériel du banc, lire les enregistrements,
lancer des scans réseau.

| Sévérité | Nombre | Corrigé ici | Recommandation |
|---|---|---|---|
| Haute | 1 | — | 1 |
| Moyenne | 4 | 2 | 2 |
| Basse | 7 | 6 | 1 |
| Info | 4 | 1 | 3 |

---

## 2. CONSTATS

### H1 — HAUTE — Le site hébergé pilote dogd par défaut

`dogd/src/config.rs:62` (`SITE_ORIGIN`), `dogd/src/config.rs:147`
(`site_origin = true`), `dogd/src/api/mod.rs:127` (`origin_allowed`).

Toute page servie depuis `https://hardwaredog.org` peut, sans rien demander
de plus, appeler toute l'API de dogd : WebSocket HDP (commandes vers le
matériel, `uart.tx`), lecture des sessions, scan LAN, scan BLE, `probe` vers
n'importe quel nom d'hôte ou IP (`dogd/src/hostnet/parse.rs:157`). La CSP et
l'absence de script tiers limitent fortement le XSS, mais une compromission
de la chaîne de publication du site (compte d'hébergement, DNS du domaine,
token de déploiement, push sur `main`, paquet npm malveillant au build) donne
d'un coup l'accès à tous les bancs où dogd tourne.

Pas corrigé ici : changer le défaut casse le parcours « installer puis ouvrir
le site ». Options, de la plus simple à la plus forte :

1. **Appairage au premier usage** : dogd affiche un code court au démarrage ;
   la page doit le présenter une fois, puis reçoit un jeton gardé dans le
   navigateur. Le site seul ne suffit plus, il faut aussi la machine.
2. **Lecture seule par défaut pour le site** : `hardwaredog.org` lit sessions
   et état ; les écritures vers le matériel (`/v1/hdp` en émission, scans
   LAN/BLE, `probe`) demandent l'appairage ou `--allow-origin`.
3. Protéger la chaîne de publication : 2FA sur GitHub, Netlify/Cloudflare et
   le registrar ; protection de branche sur `main` (revue obligatoire, pas de
   force-push) ; verrou registrar (« transfer lock ») et DNSSEC sur le
   domaine ; déploiements uniquement depuis `main`.

Le point 3 ne touche pas le code et devrait être fait tout de suite.

### M1 — MOYENNE — Dépendance Rust : SQLite embarqué vulnérable — **CORRIGÉ**

`dogd/Cargo.toml` : `rusqlite 0.37` → `libsqlite3-sys 0.35` (RUSTSEC-2026-0459,
CVE-2026-119375 dans SQLite, 6.8). Exploitabilité faible ici (requêtes fixes,
fichier d'index local en 0600), mais la correction est sans changement de code.
**Fait** : `rusqlite 0.41` (→ `libsqlite3-sys 0.39.1`). Les 110 tests passent,
dont la lecture d'un index créé par dogd 0.1 (migration).

Dans la même passe : `tokio 1.53.1 → 1.53.3` (RUSTSEC-2026-0386, unsound) et
`rustix 1.1.5 → 1.1.6` (RUSTSEC-2026-0486, unsound), versions correctives.

### M2 — MOYENNE — Injection de séquences terminal par un appareil — **CORRIGÉ**

`dogd/src/main.rs` (commandes `devices`, `devices --known`, `status`, et les
lignes de branchement imprimées par `serve`).

Les champs du `hello` HDP (`device`, `rev`, `fw`, jusqu'à 64 KiB chacun), les
chaînes USB (produit, numéro de série) et les alias étaient imprimés tels
quels. Un appareil malveillant branché sur le banc pouvait y mettre des
séquences d'échappement : changer le titre du terminal, écrire dans le
presse-papiers (OSC 52), masquer ou falsifier des lignes, ou utiliser un
caractère de direction (U+202E) pour retourner un texte.

**Fait** : toute sortie de la CLI passe par `say!` / `shown()` : un caractère
de contrôle ou de direction est écrit en clair (`\u{1b}`). Une ligne normale
est imprimée à l'identique. Test : `terminal::device_text_cannot_drive_the_terminal`.

### M3 — MOYENNE — L'installeur ne vérifie que l'intégrité, pas l'auteur

`web/public/install:251` et `:257`.

`SHA256SUMS` est téléchargé depuis la même release que le paquet : il protège
d'un téléchargement corrompu, pas d'une release remplacée par quelqu'un qui a
accès au dépôt. Les releases ont une attestation Sigstore, mais l'installeur
ne la vérifie pas (`gh` n'est pas toujours là). De plus le script vient du
site (lien avec H1).

Recommandation : signer `SHA256SUMS` avec une clé hors CI (minisign ou
`cosign sign-blob` avec clé), publier la clé publique dans le dépôt et dans le
script, et refuser une somme non signée. Vérifier l'attestation quand `gh`
est présent.

**Fait (partiel)** : la version lue de l'API GitHub ou passée en `--version`
doit ressembler à une version (`0.1.0`, `1.2.3-rc.1`) : jamais un chemin
(`..`), une URL ou un mot shell. Testé à la main ; le test d'installation de
la CI (`dogd-v0.0.0`) reste valable.

### M4 — MOYENNE — Tout utilisateur de la machine peut piloter dogd

`dogd/src/api/mod.rs:168` (`from_this_machine`).

Sur 127.0.0.1, aucun jeton n'est demandé. Sur une machine partagée (labo,
serveur de banc, Kali multi-comptes), un autre compte peut lire les sessions
et piloter le matériel. SECURITY.md le dit pour « l'utilisateur lui-même »,
pas pour les autres comptes.

Recommandation : option `--require-token` (jeton aussi en local, lu dans un
fichier 0600 du répertoire de données par l'interface installée), ou un
socket Unix 0600 pour la CLI. À documenter dans SECURITY.md dès maintenant.

### B1 — BASSE — Réponses dogd sans `nosniff` ni `no-store` — **CORRIGÉ**

`dogd/src/api/mod.rs` (`guard`).

Une page étrangère peut toujours *demander* une URL de dogd en no-cors
(`<script src>`, `<link>`) même si elle ne peut pas lire la réponse. Sans
`X-Content-Type-Options: nosniff`, un navigateur peut tenter d'interpréter le
JSON comme autre chose ; sans `Cache-Control: no-store`, sessions et
inventaire réseau peuvent atterrir dans le cache disque.

**Fait** : chaque réponse, refus compris, porte `X-Content-Type-Options:
nosniff` et `Cache-Control: no-store`. L'interface demandait déjà
`cache: 'no-store'` : rien ne change pour elle. Test :
`every_answer_is_nosniff_and_never_cached`.

### B2 — BASSE — Dépendance npm de dev : fast-uri — **CORRIGÉ**

`web/package-lock.json` : `fast-uri 3.1.8` (via `ajv`, tests seulement),
4 avis GHSA (usurpation de schéma/hôte). **Fait** : `3.1.9`, seule entrée du
lockfile modifiée (pas de réécriture du reste). Rien de ce paquet n'est dans
le site publié ; `build:verify` confirme les mêmes octets.

### B3 — BASSE — Dépendance npm de dev : happy-dom ≤ 21.0.3 — **CORRIGÉ**

`web/package.json` (`happy-dom ^20.14.6`), GHSA-834v-8h66-3h79 (exécution de
code via alias d'import) et GHSA-c8p4-j97h-3vg8 (SSRF). Ne sert qu'à
l'environnement de test, sur du HTML du dépôt : risque faible. **Fait** :
`happy-dom 21.0.4` (la mise à jour proposée par Dependabot, #64). Les 705
tests de l'interface passent, `npm audit` : 0 vulnérabilité.

### B4 — BASSE — Toute page `http://localhost:<port>` est autorisée

`dogd/src/api/mod.rs:132`.

N'importe quel serveur local (serveur de dev, Jupyter, aperçu de fichiers,
outil qui sert du contenu non fiable sur localhost) devient une origine
autorisée. Recommandation : n'autoriser par défaut que les ports du projet
(5173, 4173) et le reste par `--allow-origin`. Changement de comportement :
non appliqué.

### B5 — BASSE — `hello` non borné stocké dans l'index

`dogd/src/storage/mod.rs:257` (`saw_device`).

`device`, `rev`, `fw` d'un `hello` peuvent faire 64 KiB chacun et un appareil
peut en annoncer autant qu'il veut avec des `device` différents : l'index
grossit sans limite. Recommandation : tronquer à 64 caractères imprimables et
plafonner la table `devices`. Changement des données stockées : non appliqué.

### B6 — BASSE — Octet NUL accepté dans un nombre (firmware) — **CORRIGÉ**

`firmware/components/hdp/hdp.c:575`.

`strchr("+-0123456789.eE", c)` trouve aussi le terminateur : un octet NUL
était accepté dans un nombre JSON (`1\0`), puis ignoré. Pas de débordement
(borné à 31 octets), mais un message mal formé passait. **Fait** : un NUL
termine le nombre, la commande est refusée. Tests du cœur (ASan + UBSan) verts.

### B7 — BASSE — Le jeton LAN part dans le journal — **INFO pour l'opérateur**

`dogd/src/main.rs:174`.

Avec `--listen-lan`, le jeton est imprimé au démarrage ; sous systemd il finit
dans `journalctl`, lisible par les membres des groupes `adm` /
`systemd-journal`. Recommandation : l'écrire aussi dans un fichier 0600 et
n'afficher que ses 4 premiers caractères quand la sortie n'est pas un
terminal.

### I1 — INFO — Unité systemd : `UMask=0077` — **CORRIGÉ**

`packaging/deb/dogd.service`. dogd met déjà 0600/0700 sur ce qu'il crée ;
`UMask=0077` le garantit aussi pour tout fichier futur. Valide dans une unité
utilisateur. À envisager ensuite (à tester sur Kali/Debian/Ubuntu, car
demande les espaces de noms utilisateur) : `ProtectSystem=strict`,
`ProtectHome=read-only` + `ReadWritePaths=%h/.local/share/hwdog`,
`PrivateTmp=yes`.

### I2 — INFO — Dependabot seulement pour les actions — **CORRIGÉ**

`.github/dependabot.yml`. **Fait** : `cargo` (`/dogd`) et `npm` (`/web`)
ajoutés, hebdomadaires, groupés (une PR par écosystème, 3 au plus). À activer
aussi dans les réglages du dépôt : *Dependabot security updates*, *Secret
scanning* + *Push protection*, *Private vulnerability reporting* (SECURITY.md
y renvoie déjà). Les actions `checkout` (v7.0.1) et `setup-node` (v7.1.0)
proposées par Dependabot sont reprises ici, épinglées par commit ; elles
tournent à chaque PR, donc la CI de celle-ci les vérifie.

### I3 — INFO — Déploiement Cloudflare : les en-têtes ne suivent pas

`netlify.toml:18`. La CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
COOP et les règles de cache sont dans `netlify.toml`. **Cloudflare Pages ne lit
pas ce fichier** : en y déplaçant le site, toutes ces protections
disparaîtraient sans erreur. Il faudra un `web/public/_headers` (même
contenu) et vérifier les en-têtes servis après le premier déploiement
(`curl -sI https://hardwaredog.org/`). Ajouter aussi
`Strict-Transport-Security: max-age=31536000` (Netlify l'ajoute seul,
Cloudflare non sans réglage).

### I4 — INFO — LAN en clair, firmware sans secure boot

Déjà dit dans SECURITY.md (« WHAT IS NOT DONE ») : `--listen-lan` est du HTTP
en clair (jeton lisible sur le réseau) ; pas de secure boot ni de chiffrement
flash sur l'ESP32-S3 ; pas d'OTA (donc pas de signature OTA à vérifier, et pas
de surface OTA). Le mot de passe Wi-Fi reste dans `sdkconfig`, ignoré par git
(vérifié : jamais commité).

---

## 3. CE QUI A ÉTÉ VÉRIFIÉ ET TENU

```text
SECRETS        198 commits, toutes branches : aucune clé, aucun jeton, aucun
               sdkconfig, .env ou clé privée ajouté puis retiré
CI             permissions contents: read ; écriture seulement dans le job
               publish ; pas de pull_request_target ; actions épinglées par
               SHA ; tag publié seulement s'il est sur main ; attestations
DOGD HTTP      Host loopback (anti-rebinding), Origin lu une fois et
               fail-closed, CORS réfléchi seulement pour une origine permise,
               pas de credentials CORS, 64 connexions, 10 s d'en-têtes,
               WebSocket 65 KiB max, jeton LAN 128 bits comparé en temps
               constant
STOCKAGE       id = 32 hex (pas de traversée), fichier final jamais réécrit,
               écriture atomique 0600, requêtes SQL toutes paramétrées
COMMANDES      ping et ip lancés sans shell ; cible validée (pas d'option
               injectable, pas de caractère spécial)
SCAN LAN       interface choisie dans la liste du système, privée, /16 max
FIRMWARE       parseur JSON borné partout (chaînes, tableaux, nombres,
               UTF-16), tests sous ASan + UBSan
INTERFACE      CSP sans 'unsafe-inline', aucun innerHTML / eval / postMessage
               reçu, rapports HTML échappés, aucune requête hors de la machine
```

## 4. TESTS DE CETTE PR

```text
dogd         cargo fmt --check, clippy -D warnings, 110 tests     OK
dogd         build release deux fois, comparé octet par octet       OK
dogd         cargo audit : 0 vulnérabilité (3 avis « unmaintained »
             sur zbus/zvariant, sans correctif publié)
web          typecheck, 705 tests, build, 18 cas, build:verify      OK
web + dogd   test/dogd.test.ts, test/firmware.test.ts (31 tests)    OK
firmware     cœur hôte, ctest (ASan + UBSan)                         OK
npm audit    0 vulnérabilité
```

## 5. À FAIRE, DANS L'ORDRE

1. **Tout de suite, sans code** : 2FA partout (GitHub, hébergeur, registrar),
   protection de branche sur `main`, verrou et DNSSEC sur le domaine, secret
   scanning + push protection + private vulnerability reporting activés.
2. Avant de passer sur Cloudflare : `web/public/_headers` + HSTS (I3).
3. Appairage dogd ↔ site, ou site en lecture seule par défaut (H1).
4. Signature de `SHA256SUMS` vérifiée par l'installeur (M3).
5. `--require-token` pour les machines partagées (M4), origines localhost
   limitées (B4), `hello` borné (B5), jeton LAN hors du journal (B7).
6. Durcissement systemd supplémentaire testé sur les trois distributions
   (I1) ; `upload-artifact` 7 et `download-artifact` 8 ensemble, testés par
   une release d'essai (ils ne tournent qu'à la publication).

```text
   ____  _____ _   _ ____
  / ___|| ____| | | | __ )
  \___ \|  _| | | | |  _ \
   ___) | |___| |_| | |_) |
  |____/|_____|\___/|____/   //Seub G.
```
