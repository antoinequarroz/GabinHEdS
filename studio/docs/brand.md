# Identité Nino

Le symbole représente un N fait d’un ruban continu et de deux retours arrondis : plusieurs sources réunies dans une même régie. Il accompagne le nom **Nino** en Manrope, déjà intégrée localement. La marque reste calme pour laisser les états REC et LIVE porter les couleurs de production.

## Fichiers

- `apps/web/public/brand/nino-mark.svg` : symbole transparent pour les interfaces et les supports sombres, sans dépendance externe.
- `apps/web/public/brand/nino-icon.svg` : icône avec fond sombre pour l’onglet du navigateur.
- `apps/web/src/components/StudioBrand.vue` : signature Nino et affiliation de la salle, utilisée à la connexion et dans la régie. Le symbole est décoratif ; le nom reste un vrai texte accessible.

Palette : ivoire `#F1F3F7`, ardoise `#8994AF`, charbon `#17171B`. Conserver l’espace intérieur du N et une taille d’au moins 24 px. Pas d’animation, ni de couleur rouge ou verte permanente qui pourrait être confondue avec l’état de la capture.

## Création

Exploration par l’outil intégré **imagegen**, sans clé API fournie par l’utilisateur, puis reconstruction géométrique en SVG pour la version utilisée dans l’application. Les contours et les transparences du SVG sont définis dans le code ; le grain reste dans le fond de l’interface.

Prompt de création :

> Create a finished, original standalone brand symbol for Nino, a local video production and podcast control-room app with PC, iPad and Stream Deck controls. Design a geometric capital N as two softly rounded vertical pillars joined by a diagonal flowing ribbon, subtly suggesting two video/audio channels meeting in a switcher. Strong silhouette at 24px, generous negative space, precise optical balance. Near-white #f1f3f7 with subtle slate #8f98ad inner faces, matching Manrope and charcoal #17171b surfaces. Flat vector-like graphic, crisp edges, transparent background. No typography, camera/reel/microphone/play-button cliché, neon, ground shadow, watermark or mockup.

Prompt de finition :

> Keep the N silhouette, rounded pillar proportions, diagonal flowing ribbon and subtle slate inner surfaces. Remove fragments, specks and distressed edges. Areas outside the N must be transparent, with crisp antialiased boundaries. No black matte, background, texture, debris or typography.
