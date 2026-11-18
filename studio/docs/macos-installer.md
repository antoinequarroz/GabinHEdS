# Installer Nino sur un Mac

Nino pour Mac est une app, **Nino.app**, livrée dans une image `.dmg`. Elle fonctionne sur les Mac Apple Silicon (M1 et suivants) avec macOS 13.5 ou plus récent. Elle embarque Node.js et MediaMTX : aucune commande npm ni installation de Node n’est nécessaire.

Au premier lancement, Nino télécharge FFmpeg et ffprobe directement chez leur fournisseur. Les adresses et empreintes SHA-256 sont verrouillées dans `macos/runtime-lock.json` et vérifiées avant toute exécution. Les lancements suivants réutilisent cette copie locale.

## Obtenir l’app

Télécharger le `.dmg` sur [nino-studio.postmelo.ch](https://nino-studio.postmelo.ch/#installer) ou dans les [versions GitHub](https://github.com/antoinequarroz/nino-studio/releases), avec son fichier `.sha256`. Pour vérifier l’empreinte dans le Terminal : `shasum -a 256 Nino-*.dmg`.

Pour essayer un commit non publié : dans GitHub Actions, ouvrir **Nino macOS App**, choisir une exécution verte et télécharger l’artefact `nino-macos-<commit>-<tentative>`.

## Première installation

1. Ouvrir le `.dmg` et glisser **Nino** dans **Applications**.
2. Ouvrir Nino depuis Applications. Tant que l’app n’est pas notarisée par Apple, macOS affiche « Apple n’a pas pu vérifier que Nino ne contient pas de logiciel malveillant ». Cliquer sur **Terminé**, ouvrir **Réglages Système → Confidentialité et sécurité**, descendre jusqu’à Nino et cliquer sur **Ouvrir quand même**, puis confirmer. Cette étape n’a lieu qu’une fois.
3. Laisser terminer la préparation des outils vidéo (notification « Préparation des outils vidéo »). Elle demande Internet la première fois.
4. Nino ouvre OBS s’il est installé dans Applications, puis l’interface dans le navigateur, à `http://127.0.0.1:4310`. Si OBS manque, l’installer depuis [obsproject.com](https://obsproject.com/download) puis rouvrir Nino.
5. macOS demande l’autorisation d’accès à la caméra, au micro et à l’enregistrement d’écran **dans OBS**, pas dans Nino. Les accorder dans OBS.
6. Dans **Salle et OBS**, connecter OBS, choisir le dossier des productions et faire une prise de trente secondes, puis relire le MP4.

Ouvrir Nino ne démarre jamais un enregistrement ni un live.

## Rouvrir ou arrêter Nino

Si Nino tourne déjà, le rouvrir depuis Applications ou le Dock affiche **Nino est déjà ouvert** avec deux choix :

- **Ouvrir Nino** : rouvre l’interface et OBS, sans créer une seconde salle ;
- **Arrêter Nino** : demande au serveur de confirmer qu’aucune prise ni direct n’est en cours, puis ferme les services. Si l’état d’OBS est incertain, l’arrêt est refusé. OBS reste ouvert.

Pour mettre Nino à jour : arrêter Nino, remplacer l’app dans Applications par la nouvelle version, puis la rouvrir.

## Réglages et fichiers

Les fichiers de Nino restent hors de l’app et sont conservés lors d’une mise à jour ou si l’app est supprimée :

| Emplacement | Contenu |
| --- | --- |
| `~/Library/Application Support/Nino/data` | Base, projets, paramètres privés et médias importés. |
| `~/Library/Application Support/Nino/logs` | Journaux du lanceur et des services. |
| `~/Library/Application Support/Nino/runtime` | FFmpeg, ffprobe et MediaMTX prêts à l’emploi. |
| `~/Library/Application Support/Nino/settings.json` | Réglages du lancement. |

`settings.json` accepte deux réglages :

```json
{
  "listenOnLan": false,
  "obsPath": "/Applications/OBS.app"
}
```

`listenOnLan: true` rend Nino accessible à l’iPad sur le réseau local (port 4310) ; macOS demande alors d’autoriser les connexions entrantes. `obsPath` sert si OBS est installé ailleurs que dans Applications.

## Différences avec Windows

- Pas de démarrage automatique de Companion à l’ouverture de session, ni de touche **Ouvrir le studio** depuis le Stream Deck : ouvrir Nino depuis le Mac.
- L’installation optionnelle d’OBS n’est pas proposée : l’installer depuis son site.
- Mac Intel non pris en charge pour l’instant.

## Signature Apple

Sans compte Apple Developer, l’app est signée « ad hoc » et macOS demande de confirmer la première ouverture (étape 2). Pour une ouverture directe, il faut un compte [Apple Developer Program](https://developer.apple.com/programs/) (99 USD par an) et ces cinq secrets dans le dépôt GitHub (**Settings → Secrets and variables → Actions**) :

| Secret | Contenu |
| --- | --- |
| `MACOS_CERTIFICATE_P12` | Certificat **Developer ID Application** exporté en `.p12` depuis Trousseaux d’accès, puis encodé : `base64 -i certificat.p12 \| pbcopy`. |
| `MACOS_CERTIFICATE_PASSWORD` | Mot de passe choisi à l’export du `.p12`. |
| `APPLE_ID` | Adresse e-mail du compte Apple Developer. |
| `APPLE_APP_PASSWORD` | Mot de passe pour app créé sur [account.apple.com](https://account.apple.com) → Connexion et sécurité. |
| `APPLE_TEAM_ID` | Identifiant d’équipe (10 caractères) visible sur [developer.apple.com/account](https://developer.apple.com/account). |

Dès que ces secrets existent, le workflow signe chaque binaire avec le runtime renforcé, fait notariser le `.dmg` par Apple et y agrafe le ticket. Rien d’autre à changer.

## Construire et vérifier

Le workflow `.github/workflows/nino-macos.yml` construit sur `macos-15` (Apple Silicon) : `scripts/build-macos.mjs` compile l’API en un seul fichier JavaScript (pas de chargeur TypeScript sur le Mac), assemble Nino.app avec l’interface, les dépendances npm, Node.js et MediaMTX vérifiés, puis `macos/package-dmg.sh` signe et crée le `.dmg`.

`macos/smoke-test.sh` essaie ensuite le vrai `.dmg` : montage, copie dans un dossier Applications, marquage « téléchargé depuis Internet », premier lancement avec téléchargement réel de FFmpeg, encodage H.264/AAC de contrôle, réponses de l’API, des invités, de MediaMTX et de l’interface, second lancement qui réutilise les mêmes services, arrêt protégé et refus de démarrer si un autre programme occupe un port Nino. Il ne capture aucune caméra et n’ouvre pas OBS.

Sur une étiquette `vX.Y.Z`, le `.dmg` est joint à la version GitHub, à côté de l’installateur Windows. Pour joindre un `.dmg` à une version existante, lancer le workflow à la main avec `release_tag` (par exemple `v0.1.0`).
