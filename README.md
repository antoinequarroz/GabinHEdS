# GabinHEdS – Guide de prise en main

Ce projet est une application Electron/Vue.js destinée à simplifier la gestion de podcasts, de présentations sonorisées (PowerPoint), et de tables rondes, avec intégration OBS pour l'enregistrement audio/vidéo.

## Fonctionnalités principales

- **Interface utilisateur moderne** basée sur Vue.js et PrimeVue pour une expérience fluide et professionnelle.
- **Gestion de plusieurs modalités** :
  - **Podcast** : Enregistrement audio multi-microphones (Rodecaster Pro).
  - **PowerPoint sonorisé** : Capture audio et vidéo synchronisée avec une présentation.
  - **Table ronde** : Enregistrement multi-intervenants.
- **Contrôle d'OBS Studio** intégré via WebSocket (démarrage, arrêt, pause, reprise de l'enregistrement depuis l'UI).
- **Enregistrement audio au format MP3** (avec lamejs).
- **Gestion des assets/images** :
  - Les images sont placées dans `public/img/` et référencées via `import.meta.env.BASE_URL + 'img/...'` pour garantir leur accessibilité en développement, build web, et Electron.
  - Attention à la casse et à la taille des images (évitez les PNG > 10 Mo).
- **Sécurité** :
  - Accès micro contrôlé via permissions navigateur/Electron.
  - OBS doit être lancé avec WebSocket activé sur le port 4455.

## Structure du projet

- `desktop-app/` : Code source principal (Vue, Electron, scripts de contrôle OBS).
- `public/img/` : Images statiques utilisées dans l'interface (podcast.png, powerpoint.png, roundtable.png, etc.).
- `src/components/` : Composants Vue réutilisables (MicrophoneCard, ModalityCard, LogoSplash, etc.).
- `src/views/` : Vues principales de l'application (PodcastView, ModalitySelectView, CameraSetupView, etc.).
- `obsControl.js` : Script Node.js pour piloter OBS Studio via WebSocket.

## Installation & Lancement

1. **Pré-requis** : Node.js 18+, OBS Studio (avec WebSocket activé), Rodecaster Pro (pour le mode podcast).
2. **Installation des dépendances** :
   ```sh
   cd desktop-app
   npm install
   ```
3. **Lancement en développement** :
   ```sh
   npm run dev
   ```
4. **Build production/Electron** :
   ```sh
   npm run build
   ```
   Le build Electron se trouve dans `desktop-app/dist/`.

## Points d'attention

- **Images manquantes** :
  - Vérifiez que toutes les images nécessaires sont bien dans `public/img/` ET que leur nom correspond exactement (casse comprise).
  - Utilisez toujours `import.meta.env.BASE_URL + 'img/...'` pour référencer une image dans le code Vue.
- **Problèmes de chargement d'image** :
  - Si une image ne s'affiche pas après build, vérifiez sa taille, son nom, et la présence dans `dist/img/`.
  - Pour des images très lourdes, privilégiez des PNG/JPG optimisés (< 2 Mo si possible).
- **OBS** :
  - L'application nécessite qu'OBS Studio soit lancé avec le plugin WebSocket (port 4455).
  - Les fonctions d'enregistrement (start/pause/stop) sont pilotées via le script `obsControl.js`.

## Dépannage rapide

- **Image ne s'affiche pas** :
  - Ouvrez la console devtools dans Electron ou le navigateur, vérifiez le chemin de l'image et essayez d'ouvrir ce chemin directement.
  - Remplacez temporairement l'image par une version plus légère pour tester.
- **Erreur OBS** :
  - Vérifiez que le WebSocket OBS est bien activé et écoute sur le bon port.
  - Vérifiez la connexion réseau localhost.

## Contribution

- Merci de faire un `git add .` puis `git commit -m "message"` et `git push` pour toute modification.
- Documentez les changements importants dans ce README.

---

Pour toute question ou bug, contactez antoine.quarroz@hesge.ch ou ouvrez une issue sur le dépôt GitHub.
