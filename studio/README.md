# Nino — première version

Nino transforme le PC fixe de la salle en contrôleur de studio. Le navigateur du PC, l’iPad et le Stream Deck utilisent la même API authentifiée. OBS reste le moteur de capture et d’enregistrement sur le PC ; fermer un navigateur ne lui demande pas d’arrêter la prise.

Domaine prévu pour l’identité publique de Nino : **ninostudio.ch**.

Cette version constitue une première chaîne utilisable : création d’un projet nommé, préparation de la salle, retour vidéo et son, deux invités à distance, changement de plan, enregistrement OBS, diffusion live, pause/reprise, repères et récupération de la prise complète. Aucun enregistrement n’est annoncé comme réussi sans retour d’OBS.

Trois guides illustrés accompagnent la salle : [installation (PDF)](docs/guides/nino-installation.pdf), [tests complets (PDF)](docs/guides/nino-guide-tests.pdf) et [tutoriel utilisateur (PDF)](docs/guides/nino-guide-utilisateur.pdf). Ils expliquent la préparation, chaque format, le live, l’iPad, le Stream Deck et la récupération jusqu’à DaVinci Resolve.

Le [guide des invités à distance](docs/remote-guests.md) complète ces PDF avec le nouveau parcours d’appel, le retour sans sa propre voix, les commandes de régie et la configuration HTTPS/TURN encore à réaliser pour les appels sur Internet.

## Périmètre livré

- Projets podcast, table ronde et PowerPoint sonorisé, titre, responsable, description et jusqu’à quatre intervenants présents.
- Association des intervenants aux micros et scènes déjà configurés dans OBS.
- Préparation : connexion OBS, scène choisie, micros, dossier de destination et espace disque.
- Commandes centralisées de démarrage, arrêt, pause, reprise, changement de scène, mute et ajout de repères.
- Retour du programme OBS en HLS sur PC/iPad, activation du son par l’utilisateur et vumètres provenant des événements OBS.
- Diffusion RTMP/RTMPS vers une destination configurée par le technicien, avec des commandes séparées de l’enregistrement.
- Historique des prises, chemin du fichier retourné par OBS et téléchargement authentifié du fichier complet.
- Bibliothèque locale d’images, vidéos, sons et PDF, import depuis PC/iPad, noms, archivage et association aux productions.
- Lecture des médias dans OBS depuis la régie et l’API Stream Deck, avec confirmation de leur état.
- Lecture des prises terminées sur PC/iPad et récupération d’un ZIP contenant les originaux, les médias associés et les repères de montage.
- Réalisation automatique locale : sélection du plan à partir des micros distincts, confirmation de parole, durée minimale des plans, retour au plan large après silence ou voix simultanées, reprise manuelle prioritaire.
- Journal des plans confirmés par OBS avec les positions réelles dans les prises ; export portable pour DaVinci Resolve, vidéo et son liés, timeline OTIO par prise, repères et originaux conservés.
- Deux places d’invités à distance : invitations personnelles, aperçu caméra/micro, salle d’attente, admission, coupure audio, retrait et plans OBS contrôlés par le PC, l’iPad et l’API Stream Deck.
- Liaison WebRTC dédiée sur le PC, image du programme OBS par caméra virtuelle, entrée audio de salle et retour individuel excluant la propre voix de chaque invité. Passerelle invitée séparée du contrôleur privé ; configuration HTTPS et TURN nécessaire pour Internet.
- Interface tactile responsive pour iPad, code d’association temporaire et révocation des appareils.
- Accès opérateur pour Stream Deck via HTTP ; voir [le guide Stream Deck](docs/stream-deck.md).

La captation des caméras et micros se configure encore dans OBS. Les modes correspondent aux profils de production ; un podcast utilise également la sortie d’enregistrement OBS configurée. Cette version ne crée pas automatiquement des pistes audio ou des captures séparées de chaque caméra.

Le conducteur, la sauvegarde NAS, les angles caméra séparés et le montage éditorial IA restent des étapes suivantes. Le retour conversationnel des invités utilise WebRTC ; le lecteur de programme de la régie PC/iPad conserve le HLS. La réalisation automatique actuelle utilise les niveaux audio OBS localement ; elle ne transcrit ni ne reconnaît les personnes avec un service IA. Le [guide médias et récupération](docs/media-library.md) explique la bibliothèque et les exports.

Pour l’automatique, chaque participant possède une entrée micro et un plan distincts. Les micros doivent rester actifs dans toutes les scènes. Dans la régie, choisir le **Plan large**, ajuster la détection puis **Activer l’automatique**. Une commande manuelle, un média plein écran, une perte OBS ou une révocation suspend le mode ; sa reprise est explicite. Une mesure périmée ou manquante bloque les changements. Après redémarrage, les réglages sont conservés mais le mode reste manuel. Le même contrôle est disponible sur iPad et via les commandes Stream Deck `auto.start` / `auto.stop`.

Les invités rejoignent ce mode après admission et réception réelle par leur source OBS, avec leur micro ouvert. Un invité muet ou déconnecté en est écarté. Garder la fenêtre de liaison ouverte et le PC éveillé ; fermer la régie iPad conserve la prise, mais fermer cette fenêtre PC coupe la liaison de conversation.

## Prérequis

Installer Node.js **24 ou supérieur**, npm et OBS Studio sur le PC de la salle. Ajouter **MediaMTX** et **FFmpeg** pour le retour vidéo et la diffusion live. Vérifier `node --version` avant l’installation. Le dépôt est un workspace npm ; exécuter les commandes dans `studio/`, jamais dans les dossiers historiques `desktop-app/` ou `gabinOneclick/`.

OBS Studio intègre le contrôle WebSocket depuis la version 28. Dans **Outils → Paramètres du serveur WebSocket**, activer le serveur et l’authentification, conserver le port **4455** et choisir un mot de passe. Nino se connecte à `ws://127.0.0.1:4455` sur le même PC. Voir [le guide officiel OBS](https://obsproject.com/kb/remote-control-guide).

Créer les scènes nécessaires dans OBS, par exemple `Podcast`, `Table ronde` et `PowerPoint`, et ajouter leurs sources. Pour PowerPoint, ajouter la capture HDMI ou la fenêtre contenant la présentation. Régler la sortie d’enregistrement et effectuer un test matériel directement dans OBS avant l’utilisation en salle.

Le programme vidéo envoyé à MediaMTX doit utiliser **H.264 et AAC** pour ce parcours navigateur. MediaMTX génère le HLS ; l’interface utilise la lecture native quand elle est disponible et HLS.js sinon. Le HLS ajoute un décalage entre la capture et l’écran : vérifier le cadrage et le son, puis utiliser OBS sur le PC pour les opérations nécessitant un retour immédiat. Voir [les codecs HLS MediaMTX](https://mediamtx.org/docs/read/hls) et [la lecture navigateur](https://mediamtx.org/docs/read/web-browsers).

## Installation sur macOS

Sur ce dépôt, Portly supervise les serveurs et les travaux ponctuels. Si `portly` n’est pas dans le PATH, utiliser `/Applications/Portly.app/Contents/Resources/portly-cli` à sa place.

```sh
cd /Users/antoinequarroz/Lab/projets/GabinHEdS/studio
portly status
job_id="$(portly temp 'npm install' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
job_id="$(portly temp 'npm run build' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
job_id="$(portly temp 'npm run setup:media' --path "$PWD" --timeout 5m)"
portly wait "$job_id"
```

La construction vérifie les types et produit l’interface. Pour enregistrer durablement le serveur de la salle, réutiliser le projet Portly s’il existe ; sinon :

```sh
portly add-project --name GabinHEdS --path "$PWD" --icon video --color '#175A4B' --json
portly port 4310 --json
portly add-server --project GabinHEdS --name studio --command 'npm start' --port 4310 --start --json
portly port 1935 --json
portly add-server --project GabinHEdS --name media --command 'npm run start:media' --port 1935 --start --json
portly status
```

Le téléchargement MediaMTX utilise une version fixe et vérifie l’empreinte SHA-256 de sa publication officielle avant l’extraction. `npm run start:media` charge ensuite la configuration locale de `config/mediamtx.yml`. Réutiliser le serveur `media` déjà enregistré et sain plutôt que d’en créer un deuxième. Installer séparément [FFmpeg](https://ffmpeg.org/download.html), puis vérifier `ffmpeg -version` ; `GABIN_FFMPEG_PATH` permet d’indiquer son exécutable si nécessaire.

Ouvrir `http://127.0.0.1:4310`. Le serveur sert l’interface construite et l’API sur la même adresse. Les logs se consultent avec `portly logs GabinHEdS/studio --tail 100` et `portly logs GabinHEdS/media --tail 100` ; les commandes `portly stop` et `portly restart` ciblent le serveur concerné.

## Installation sur le PC Windows

Dans PowerShell, depuis le dépôt, adapter le chemin si nécessaire :

```powershell
Set-Location 'C:\GabinHEdS\studio'
node --version
npm install
npm run build
npm run setup:media
npm start
```

Installer [FFmpeg](https://ffmpeg.org/download.html) et rendre son exécutable accessible dans le PATH, ou définir `$env:GABIN_FFMPEG_PATH` avec son chemin complet. Dans une seconde fenêtre PowerShell ouverte dans `studio/`, exécuter `npm run start:media`. Garder les deux fenêtres ouvertes pendant l’utilisation, puis accéder à `http://127.0.0.1:4310`. Le démarrage automatique avec la session Windows et le packaging restent à préparer pour l’installation définitive. Portly est le superviseur utilisé sur le Mac de développement ; il n’est pas requis sur ce PC Windows.

## Première utilisation dans la salle

1. Lancer OBS et ouvrir Nino sur le PC à l’adresse locale ci-dessus. Le navigateur local obtient un accès technicien ; une tablette doit être associée depuis cet accès.
2. Ouvrir les réglages de la salle : nom, adresse WebSocket locale, mot de passe OBS et racine des enregistrements. Choisir un disque du PC disposant de suffisamment d’espace, par exemple `D:\Gabin\Enregistrements` sur Windows.
3. Enregistrer les réglages, connecter OBS, puis sélectionner les scènes disponibles pour les trois formats.
4. Créer une production avec un titre réel, son responsable et ses intervenants. Associer les micros et la **Scène affichée au démarrage**. Le choix « Profil de la salle » utilise la scène associée au format dans les réglages de la salle.
5. Passer à la préparation. Corriger les blocages et écouter/tester physiquement les micros et vérifier les images dans OBS. Les contrôles logiciels ne garantissent pas que la caméra est bien cadrée ni que le micro capte correctement.
6. Démarrer la prise. Le voyant d’enregistrement et le compteur proviennent de l’état OBS. Changer de scène, ajouter des repères, mettre en pause ou reprendre.
7. Arrêter et attendre la confirmation d’OBS. La prise terminée apparaît avec le fichier réellement produit ; récupérer celui-ci depuis la page du projet.

Les noms de projet organisent les dossiers et les prises. Le nom et le format du fichier média à l’intérieur du dossier restent ceux des réglages OBS. Changer le titre d’un projet ne renomme pas les fichiers déjà enregistrés.

Si la connexion OBS est interrompue, l’état de la capture devient incertain : contrôler OBS sur le PC. La prise est marquée **interrompue** ; Nino ne réattribue pas automatiquement un enregistrement OBS après une rupture de connexion ou un redémarrage du contrôleur. Si OBS enregistre toujours, terminer cette capture directement dans OBS et récupérer son fichier depuis le dossier de la prise sur le PC. Reconnecter ensuite Nino avant une nouvelle prise.

Si seule la connexion iPad est perdue, la capture continue ; retrouver le même studio permet de voir son état actuel. Ne pas lancer une seconde capture pour tenter de « réparer » un affichage déconnecté. Fermer Nino ne demande pas l’arrêt d’OBS : terminer les prises avant une maintenance du contrôleur.

## Retour vidéo, audio et live

Le retour vidéo et la diffusion publique sont deux usages du même programme :

```text
Caméras / micros → OBS → MediaMTX local → HLS authentifié → PC / iPad
                                   └→ relais FFmpeg → destination live RTMP/RTMPS
```

Démarrer le retour vidéo configure la sortie de diffusion OBS vers le serveur MediaMTX local. Cette sortie OBS sert au transport dans la salle ; les identifiants de la plateforme publique sont conservés dans Nino et utilisés par le relais FFmpeg. Une diffusion déjà démarrée directement dans OBS vers une autre destination doit être terminée dans OBS avant que Nino puisse configurer ce transport.

Les services MediaMTX écoutent uniquement sur la boucle locale du PC. Les appareils passent par l’API Nino et une session de lecture temporaire, révocable avec leur accès ; ils n’accèdent pas directement aux ports MediaMTX.

Le navigateur démarre le retour avec le son coupé. Activer le son depuis le bouton du lecteur ; utiliser un casque pour éviter les retours acoustiques dans les micros de la salle. Le vumètre représente le signal mesuré par OBS, distinct du réglage de gain. Les mesures sont envoyées en temps réel aux appareils autorisés et ne sont pas enregistrées dans la base des projets.

La configuration HLS livrée segmente le programme ; le retour arrive avec quelques secondes de retard et peut demander plusieurs secondes au premier lancement. Les vumètres et commandes OBS ont leur propre transport et ne sont pas synchronisés avec cette image retardée. Ce retour sert à vérifier le programme ; il ne remplace pas un retour de régie immédiat. Safari et les navigateurs iOS utilisent le lecteur HLS natif ; Chromium utilise HLS.js avec MediaSource. Les parcours automatisés couvrent ces deux branches dans Chromium et WebKit, puis une recette sur l’iPad réel doit confirmer Safari, le réseau Wi-Fi et l’écoute au casque.

Pour le live, configurer dans **Salle et OBS** le nom de la destination, son serveur RTMP/RTMPS et sa clé. Créer et préparer le projet, puis démarrer la diffusion depuis sa régie et attendre la confirmation du relais. La clé n’est pas exposée dans l’état envoyé aux appareils.

**Enregistrer et diffuser sont des commandes distinctes.** Arrêter le live conserve l’enregistrement et le retour local ; arrêter la prise conserve le live. Le retour local ne peut pas être arrêté pendant une diffusion publique puisqu’il l’alimente. Contrôler l’aperçu et le statut aussi sur la plateforme destinataire : un flux transmis ne prouve pas que l’événement est publié auprès des spectateurs.

Fermer ou déconnecter un navigateur PC/iPad ne coupe ni la prise ni le relais public. En revanche, arrêter ou redémarrer le serveur Nino arrête le relais FFmpeg et interrompt donc le live public ; OBS peut continuer sa prise et son transport local. Terminer le live avant cette maintenance et vérifier OBS avant de reprendre. La fermeture de MediaMTX interrompt le retour et la source du live ; la régie affiche une indisponibilité ou une erreur plutôt qu’une réussite simulée.

## Contrôle iPad et réseau local

Le serveur écoute sur `127.0.0.1` par défaut et n’est accessible que depuis le PC. Pour un pilote sur le réseau privé de la salle, le configurer avec `GABIN_HOST=0.0.0.0` et `GABIN_PORT=4310`, puis autoriser le port dans le pare-feu uniquement pour le réseau concerné.

Sur Windows, avant `npm start` :

```powershell
$env:GABIN_HOST = '0.0.0.0'
$env:GABIN_PORT = '4310'
npm start
```

Sur macOS, enregistrer ces variables dans la commande du serveur Portly, puis redémarrer :

```sh
portly update-server GabinHEdS/studio --command 'GABIN_HOST=0.0.0.0 GABIN_PORT=4310 npm start'
portly restart GabinHEdS/studio
```

Depuis l’iPad connecté au même réseau, ouvrir `http://ADRESSE-IP-DU-PC:4310` dans Safari. Sur le PC, ouvrir **Appareils**, générer un code d’association et le saisir sur l’iPad avec un nom identifiable. Le code expire après **cinq minutes** et ne sert qu’une fois ; la tablette obtient son propre accès opérateur, valable **30 jours**. Elle retrouve les mêmes projets, scènes et commandes. Révoquer une tablette dans **Appareils** invalide son jeton ; après expiration, l’associer à nouveau.

Cette association contrôle l’accès, mais HTTP ne chiffre pas les jetons ni les données sur le réseau. Pour l’installation durable, prévoir un proxy HTTPS avec un certificat approuvé par les iPad, qui transmet également `/api/events` en WebSocket (`wss` côté navigateur). Garder le contrôleur en boucle locale derrière ce proxy ; le proxy doit refuser `/api/auth/local` aux clients distants. Ne pas publier le contrôleur directement sur Internet. La connexion OBS reste locale au PC ; aucun mot de passe OBS n’est transmis à l’iPad.

## Données et récupération

La base locale `studio/.data/studio.sqlite` conserve les projets, les prises, les repères, les paramètres privés OBS/live et les empreintes des jetons d’appareils. Le dossier de données peut être déplacé avec `GABIN_DATA_DIR` avant le lancement du serveur. Cette variable ne déplace pas les vidéos : leur racine se règle séparément dans l’interface.

Par défaut, la racine des médias des nouvelles installations est `Videos/Nino` dans le dossier personnel du compte qui exécute le serveur. Les chemins déjà configurés sont conservés. OBS écrit chaque prise dans un sous-dossier propre au projet et à la prise. Le téléchargement utilise le chemin confirmé par OBS, vérifie qu’il reste dans le dossier de cette prise et exige un appareil autorisé.

Le navigateur télécharge le fichier directement en flux, sans charger toute la vidéo en mémoire. Nino délivre un lien temporaire valable cinq minutes, lié à la prise et à l’appareil ; sa révocation rend aussi ce lien inutilisable. Un transfert déjà commencé peut se poursuivre après ce délai. Les requêtes de reprise acceptent des plages d’octets tant que le lien est valide ; après expiration, demander un nouveau téléchargement.

Le stockage sur disque constitue la destination de travail ; le téléchargement n’est pas une sauvegarde automatique. Prévoir une copie indépendante des médias et de la base avant le déploiement définitif. Pour une copie simple cohérente de la base, terminer la prise et arrêter Nino avant de copier `.data/`. Une prise dont le fichier a été déplacé manuellement reste référencée mais ne peut plus être téléchargée à l’ancien emplacement.

Ne jamais versionner les bases locales, les enregistrements, les mots de passe OBS ni les jetons d’appareils. Les jetons Stream Deck sont affichés au moment de leur création ; les conserver dans la configuration locale de l’appareil et les révoquer s’ils sont perdus ou partagés.

## Développement et vérification

Le [guide de développement et de livraison](docs/development.md) décrit le travail local, les contrôles GitHub Actions et l’archive de code validée pour la salle.

Le contrat commun est dans `packages/shared/src/index.ts`. L’API TypeScript est dans `apps/api`, l’interface Vue dans `apps/web`. En production, une seule origine sert les deux ; en développement, Vite sur le port 4311 relaie `/api` et les WebSockets vers l’API sur le port 4310.

Sur le Mac, enregistrer si nécessaire deux serveurs Portly avec les commandes `npm run dev:api` (4310) et `npm run dev:web` (4311). Réutiliser ceux déjà sains. Pour les travaux ponctuels :

```sh
job_id="$(portly temp 'npm test' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
job_id="$(portly temp 'npm run build' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
```

Les tests comprennent des doubles d’OBS et un serveur de protocole WebSocket de test. Ce dernier écrit un fichier factice marqué comme tel ; il ne capture aucun média. Leur réussite valide les échanges et la gestion des prises, pas le matériel, les codecs ni la qualité de l’enregistrement réel. La recette en salle doit comprendre un vrai démarrage/arrêt OBS et la lecture du fichier obtenu.

Le contrôle navigateur `npm run test:browser` utilise l’interface compilée, l’API réelle et l’adaptateur OBS réel contre ce serveur de protocole. Il lance également un vrai MediaMTX et une source FFmpeg de mire animée avec sinus audio sur des ports temporaires. Il vérifie les trames HLS décodées et changeantes, l’audio AAC activable sur PC et au format iPad, le live réellement reçu par une deuxième destination RTMP locale, les arrêts indépendants, le contrôle Stream Deck par jeton dédié, l’association de l’iPad, la bibliothèque, la lecture et l’export. Construire l’interface et installer MediaMTX/FFmpeg avant de l’exécuter. Le test n’utilise ni caméra ni micro du poste et ne touche pas le serveur de la salle. Le protocole de capture reste un double ; les fichiers de mire des tests de lecture sont réellement encodés et décodés.

Playwright et Chromium doivent être disponibles pour ce contrôle supplémentaire. Sur le Mac Codex, le script retrouve les dépendances du runtime. Sur un autre poste, fournir un module Playwright déjà installé via `GABIN_PLAYWRIGHT_MODULE` et, si nécessaire, l’exécutable via `GABIN_CHROMIUM_PATH`. `GABIN_SCREENSHOT_DIR` permet de choisir la destination des captures ; par défaut, elles vont dans le dossier temporaire du système. Aucune nouvelle dépendance du projet n’est nécessaire pour utiliser le runtime fourni.

`GABIN_TEST_BROWSER=webkit` exécute aussi le parcours avec le moteur WebKit installé pour Playwright, afin de vérifier la branche HLS native. Ce test utilise une deuxième origine sur une adresse IPv4 du poste pour l’association distante ; `GABIN_IPAD_HOST` permet de la choisir explicitement. Le test WebKit utilise temporairement l’écoute sur les interfaces réseau et conserve sa propre base. WebKit sur le Mac ne remplace pas la recette Safari sur le véritable iPad. `GABIN_TEST_LOGGER=1` active les journaux diagnostiques du test.

```sh
job_id="$(portly temp 'npm run test:browser' --path "$PWD" --timeout 5m)"
portly wait "$job_id"
```
