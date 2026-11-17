# Logiciels de captation

Chaque salle Nino pilote **un** logiciel de captation, choisi dans « Salle et … → Logiciel de captation ». Le logiciel tourne sur le même PC que Nino : les prises sont écrites sur ce disque et lues par Nino (lecture, MP4, export DaVinci).

| | OBS Studio | Maya Studio | Streamlabs Desktop |
| --- | --- | --- | --- |
| Pilote | `apps/api/src/obs.ts` | `apps/api/src/maya.ts` | à venir |
| Connexion | obs-websocket v5, `ws://127.0.0.1:4455`, mot de passe | protocole de la Suite Media v1, `ws://127.0.0.1:4460`, jeton de la suite | — |
| Plans, enregistrement, retour local, vignettes | oui | oui | — |
| Pause d'enregistrement | oui | non | — |
| Micros (liste, couper) | oui | non | — |
| Réalisation automatique (niveaux audio) | oui | non | — |
| Médias à l'antenne, invités à distance | oui | non | — |

Chaque pilote déclare ses capacités (`CaptureCapability` dans `packages/shared`). Nino refuse avant tout envoi une commande que le logiciel ne sait pas faire (`CAPTURE_UNSUPPORTED`) et l'interface masque ou désactive le contrôle correspondant. Rien n'est simulé.

## Maya Studio

1. Lancer `studiod` sur le PC de la salle avec un jeton : `studiod --token <jeton>` (voir le dépôt `maya-studio`).
2. Dans Nino, choisir « Maya Studio », garder l'adresse `ws://127.0.0.1:4460`, saisir le jeton comme mot de passe, enregistrer, puis connecter.
3. Chaque prise est enregistrée en MP4 dans le dossier de la production (`StartRecording` avec le chemin choisi par Nino).

Le changement de logiciel n'est possible que déconnecté, sans prise ni direct en cours.

## Ajouter un pilote

Implémenter `CaptureDriver` (`apps/api/src/capture.ts`), déclarer `software` et `capabilities`, l'enregistrer dans `captureDrivers` (`apps/api/src/app.ts`) et ajouter un simulateur de protocole sous `tests/` comme `tests/fake-maya.ts`.
