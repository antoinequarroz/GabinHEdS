# Identité Nino

Le symbole représente un N fait d’un ruban continu et de deux retours arrondis : plusieurs sources réunies dans une même régie. Il accompagne le nom **Nino** en Geist, la police de la Suite Media, intégrée localement. La marque reste calme pour laisser les états REC et LIVE porter les couleurs de production.

## Design de la Suite Media

Nino reprend le design commun des apps de la suite (Lamio, Cairn, Metricove) : fond papier chaud, encre presque noire, léger grain, polices Geist (texte), Geist Mono (chiffres et minutage) et Instrument Serif (titres de page). Chaque app garde sa couleur d’accent ; celle de Nino est le **bleu-vert pétrole** (`#0B7480` en clair, `#4EC4CD` en sombre). Le rouge reste réservé à l’enregistrement et aux erreurs.

Les couleurs sont des variables CSS en tête de `apps/web/src/styles.css` (`--bg`, `--surface`, `--ink`, `--line`, `--accent`, `--danger`…). Ne pas réintroduire de couleur codée en dur : utiliser une variable, ou `color-mix()` à partir d’une variable pour une teinte intermédiaire.

Trois apparences, au choix dans **Accès de cet appareil** : **Sombre** (par défaut dans la salle), **Clair** et **Auto** (suit le système). Le choix est gardé par appareil. Les vidéos restent sur un fond noir dans les deux apparences.

Les polices sont servies depuis `apps/web/public/fonts` (licence OFL), sans réseau. Manrope y reste pour les guides PDF générés par `scripts/generate-guides.py`.

## Fichiers

Depuis le 17.11.2026, l'interface et la page vitrine utilisent les pictos du kit d'identité Postmelo (N en ruban bleu-vert, version claire et sombre) : `icon-light-128.png`, `icon-dark-128.png`, `favicon.ico` et `apple-touch-icon.png`, dans `apps/web/public/brand/` et `site/brand/`. Les SVG ci-dessous restent la source des pages Stream Deck et des guides PDF.

- `apps/web/public/brand/nino-mark.svg` : symbole transparent pour les interfaces et les supports sombres, sans dépendance externe. En apparence claire, il est posé sur une tuile anthracite.
- `apps/web/public/brand/nino-icon.svg` : icône avec fond sombre pour l’onglet du navigateur.
- `apps/web/src/components/StudioBrand.vue` : signature Nino et affiliation de la salle, utilisée à la connexion et dans la régie. Le symbole est décoratif ; le nom reste un vrai texte accessible.

Palette : ivoire `#F1F3F7`, ardoise `#8994AF`, charbon `#17171B`. Conserver l’espace intérieur du N et une taille d’au moins 24 px. Pas d’animation, ni de couleur rouge ou verte permanente qui pourrait être confondue avec l’état de la capture.

## Création

Exploration par l’outil intégré **imagegen**, sans clé API fournie par l’utilisateur, puis reconstruction géométrique en SVG pour la version utilisée dans l’application. Les contours et les transparences du SVG sont définis dans le code ; le grain reste dans le fond de l’interface.

Prompt de création :

> Create a finished, original standalone brand symbol for Nino, a local video production and podcast control-room app with PC, iPad and Stream Deck controls. Design a geometric capital N as two softly rounded vertical pillars joined by a diagonal flowing ribbon, subtly suggesting two video/audio channels meeting in a switcher. Strong silhouette at 24px, generous negative space, precise optical balance. Near-white #f1f3f7 with subtle slate #8f98ad inner faces, matching Manrope and charcoal #17171b surfaces. Flat vector-like graphic, crisp edges, transparent background. No typography, camera/reel/microphone/play-button cliché, neon, ground shadow, watermark or mockup.

Prompt de finition :

> Keep the N silhouette, rounded pillar proportions, diagonal flowing ribbon and subtle slate inner surfaces. Remove fragments, specks and distressed edges. Areas outside the N must be transparent, with crisp antialiased boundaries. No black matte, background, texture, debris or typography.
