# Développer et livrer Nino

La nouvelle application est dans `studio/`. Le contrat PC, iPad et Stream Deck est défini dans `packages/shared/src/index.ts` ; ces trois interfaces utilisent la même API authentifiée. Les dossiers historiques `desktop-app/` et `gabinOneclick/` restent des références : leurs scripts ne servent pas au développement de Nino.

## Travailler sur une modification

Utiliser une branche `codex/<sujet>` pour une modification isolée. Décrire le comportement attendu, puis vérifier le parcours touché : création du projet, préparation, régie, direct ou récupération. Une interface peut présenter une action comme disponible uniquement si le serveur l’autorise ; l’enregistrement est confirmé par OBS et le live par le relais média.

Node.js **24 ou supérieur** et npm sont requis. FFmpeg est également nécessaire aux tests des affiches de prises. Installer les dépendances depuis le lockfile avec `npm ci`. MediaMTX sert au parcours navigateur complet ; `npm run setup:media` télécharge sa version fixe et vérifie le SHA-256 officiel.

Sur le Mac de développement, commencer par `portly status`, réutiliser les serveurs sains et employer Portly pour les commandes ponctuelles. Si la commande n’est pas dans le PATH, utiliser `/Applications/Portly.app/Contents/Resources/portly-cli`.

Depuis `studio/` :

```sh
portly status
job_id="$(portly temp 'npm ci' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
job_id="$(portly temp 'npm run check' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
```

`npm run check` lance les vérifications TypeScript, construit l’interface et exécute les tests API ainsi que le serveur de protocole OBS de test. Les tests utilisent une base et des ports temporaires ; ils ne pilotent pas l’OBS de la salle. Les tests d’affiches décodent un court média généré par FFmpeg. Une réussite logicielle ne valide pas les caméras ou les microphones physiques.

Pour développer l’interface et l’API en parallèle, enregistrer les commandes `npm run dev:web` et `npm run dev:api` comme serveurs Portly, respectivement sur les ports **4311** et **4310**. Pour utiliser la version construite, le serveur `npm start` sur **4310** sert l’interface et l’API ensemble. Consulter les logs avec `portly logs GabinHEdS/studio --tail 100` ; ce nom technique conserve le projet Portly existant.

## Vérifier le parcours navigateur

Le script `npm run test:browser` utilise l’interface compilée, l’API réelle, le protocole OBS de test, MediaMTX et FFmpeg. Il couvre le PC, l’association opérateur iPad, l’enregistrement, les repères, les plans, l’audio, le direct indépendant, l’accès Stream Deck et le téléchargement. Les images et l’audio du retour sont réellement décodés ; l’enregistrement OBS reste une simulation de protocole marquée comme telle.

Le parcours `npm run test:guests:browser` exerce deux invités et un pont de salle avec de vrais `RTCPeerConnection`, les API de signalisation, les sources navigateur et WebAudio. Seuls les appareils de capture et le protocole OBS sont des fixtures : trois sinusoïdes et des mires animées permettent de vérifier les trames reçues et de mesurer chaque retour. Le retour A doit contenir la salle et B, sans A ; le retour B doit contenir la salle et A, sans B. Le test vérifie aussi les micros OBS, les commandes PC/iPad/Deck, le retrait et la nouvelle invitation, le retour après passage en arrière-plan, les petits écrans et l’isolation de la passerelle publique.

Le PC, le pont, les deux invités et l’iPad utilisent le moteur choisi par `GABIN_TEST_BROWSER`. Les seules pages représentant les sources OBS utilisent toujours Chromium avec `--autoplay-policy=no-user-gesture-required`, comme [le navigateur CEF d’OBS](https://github.com/obsproject/obs-browser/blob/master/browser-app.cpp#L150). Elles ne capturent aucun périphérique ; leur lecture, leurs images décodées et leur audio restent réellement vérifiés. Le journal et le JSON de preuve indiquent `sourceEngine: chromium`. Ce choix reproduit le récepteur de production : [WebKit applique une politique distincte aux flux reçus sans capture ni geste utilisateur](https://webkit.org/blog/7763/a-closer-look-into-webrtc/), observée par un vrai rejet `NotAllowedError` lors d’une nouvelle invitation. Installer Chromium en plus de WebKit pour le parcours macOS.

Les régressions de retrait vérifient les messages média et ICE encore en vol : l’autre invité reste actif, les anciens accès restent révoqués et les messages inconnus ou d’un autre projet sont refusés. Les tests couvrent aussi la reconnexion après une interruption temporaire, sans prolonger le droit d’accès ni réadmettre automatiquement les invités.

Le test retarde aussi la livraison d’un vrai `getStats()` natif jusqu’à ce qu’un snapshot plus récent ait confirmé de nouvelles images : le résultat ancien ne doit pas retirer une admission valide. Un autre retrait intervient pendant un appel natif en attente, puis vérifie que le pont et l’autre invité restent actifs. Les valeurs RTC, les seuils de réception et les retours audio ne sont pas simulés.

Les pairs Nino utilisent la politique `max-bundle` : audio et vidéo partagent un transport ICE/DTLS dès la première offre, au lieu de créer puis fusionner plusieurs transports. Le test garde les deux arrivées concurrentes et observe les objets de transport natifs avant réponse, puis leur état connecté des deux côtés. La disponibilité exige toujours une connexion confirmée et la réception réelle de nouvelles images et de données audio. En cas d’échec, les journaux incluent les états ICE/DTLS ; une réception de paquets ne suffit pas à déclarer un invité prêt. Voir la [politique BUNDLE du standard WebRTC](https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum).

Utiliser `GABIN_GUEST_TEST_STUN=1` pour ce parcours : un petit serveur STUN de test répond réellement aux requêtes Binding sur un port UDP temporaire en boucle locale. WebKit requiert des candidats réflexifs dans ce test sans capture matérielle ; les négociations ICE, paquets vidéo/audio et analyses FFT restent natifs. Aucun appareil du Mac ni service STUN externe n’est utilisé. `GABIN_GUEST_SCREENSHOT_DIR` choisit le dossier de preuves. Le workflow exécute ce test dans les deux navigateurs, après le parcours HLS habituel.

```sh
job_id="$(portly temp 'GABIN_GUEST_TEST_STUN=1 npm run test:guests:browser' --path "$PWD" --timeout 10m)"
portly wait "$job_id"
job_id="$(portly temp 'GABIN_TEST_BROWSER=webkit GABIN_GUEST_TEST_STUN=1 npm run test:guests:browser' --path "$PWD" --timeout 10m)"
portly wait "$job_id"
```

La validation extérieure demande ensuite le vrai HTTPS et TURN de l’installation, des personnes avec casques et des réseaux différents. Voir [le guide invités](remote-guests.md). Une simulation de périphérique tactile WebKit ne remplace pas la recette sur l’iPad et le Stream Deck physiques.

Playwright **1.64.0** et ses navigateurs doivent être installés pour ce parcours. Le workflow GitHub installe son propre module dans un dossier temporaire, sans dépendance au runtime Codex. Sur un autre poste, indiquer ce module avec `GABIN_PLAYWRIGHT_MODULE` et installer les navigateurs avec la commande Playwright `install --with-deps`. Sur le Mac Codex, le script peut retrouver le runtime déjà fourni.

Sur le Mac, après construction et installation de MediaMTX :

```sh
job_id="$(portly temp 'npm run test:browser' --path "$PWD" --timeout 10m)"
portly wait "$job_id"
job_id="$(portly temp 'GABIN_TEST_BROWSER=webkit npm run test:browser' --path "$PWD" --timeout 10m)"
portly wait "$job_id"
```

`GABIN_TEST_BROWSER` accepte `chromium` ou `webkit`. Pour Chromium, `GABIN_CHROMIUM_CHANNEL=chrome` sélectionne Chrome officiel installé par Playwright, utile pour les codecs H.264/AAC. `GABIN_CHROMIUM_PATH` peut fournir un exécutable précis. `GABIN_SCREENSHOT_DIR` choisit le dossier des preuves de test ; conserver ce dossier hors des médias de la salle. WebKit utilise une deuxième origine du poste pour exercer l’association distante ; `GABIN_IPAD_HOST` permet de choisir son adresse explicitement.

Les captures WebKit attendent une géométrie et une position de défilement stables pendant deux frames, après activation de la page. La cible est recalculée si le document change de hauteur ; une navigation recrée la sonde dans le nouveau document. Les gardes du parcours reproduisent une contraction de page, une restauration tardive du défilement et une navigation pendant le rendu. Elles continuent de refuser les débordements, images manquantes et échecs persistants de capture. Un échec de ces contrôles ne doit pas être contourné par une relance automatique du parcours entier.

Pour la validation matérielle, terminer par un test avec le vrai OBS de la salle, une courte prise, la lecture du fichier récupéré et, lorsqu’il est disponible, le vrai iPad. Une destination YouTube reste une configuration de salle ; les tests automatisés diffusent uniquement vers leur propre destination locale.

## Contrôles GitHub Actions

Le workflow [Nino CI](../../.github/workflows/nino-ci.yml) est déclenché par les push et pull requests modifiant `studio/` ou le workflow, et peut être lancé manuellement. Un nouveau run annule le run précédent sur la même branche.

| Contrôle | Environnement | Ce qui est vérifié |
| --- | --- | --- |
| Types, build et tests API / OBS | Ubuntu 24.04, Node.js 24, FFmpeg | Contrats, compilation, authentification, prises, affiches et protocole OBS |
| Parcours Chromium | Ubuntu 24.04, Chrome officiel, MediaMTX et FFmpeg | Parcours PC/iPad, HLS décodé, relais live, invités WebRTC et retours mesurés |
| Parcours WebKit | macOS 15, WebKit, sources OBS Chromium, MediaMTX et FFmpeg | HLS natif, mêmes commandes, invités WebRTC et retours mesurés |
| Archive locale validée | Ubuntu 24.04, après succès des contrôles | Code, interface construite et empreinte SHA-256 de l’archive |

Les binaires de navigateurs correspondent au module Playwright installé. Chrome officiel est choisi pour les codecs média ; WebKit est exécuté sur macOS pour la lecture native proche de Safari. Ce test ne remplace pas un iPad physique. Voir [les navigateurs et codecs Playwright](https://playwright.dev/docs/browsers) et [l’installation en CI](https://playwright.dev/docs/ci).

Les actions sont fixées à des SHA de commits vérifiés des publications officielles : [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node 7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) et [upload-artifact 7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2). Les permissions du workflow se limitent à la lecture du dépôt. Les runs de pull request ne produisent pas d’archive de distribution.

Les preuves navigateur sont conservées pendant **7 jours** : captures PNG et journal du test isolé. Les bases, tokens et médias temporaires ne sont pas téléversés. Les vrais identifiants OBS/YouTube et les secrets de la salle ne sont pas utilisés. Le token GitHub du run est fourni uniquement au téléchargement des métadonnées MediaMTX pour éviter la limite anonyme de l’API ; il n’est pas transmis au téléchargement de l’archive.

## Récupérer une version locale validée

Après un push ou un lancement manuel réussi, télécharger l’artefact **nino-local-<commit>-<tentative>** dans le run Actions. Il contient une archive `nino-studio-<commit>.zip` et son fichier `.sha256`, conservés pendant **14 jours**. Le fichier `release.json` à l’intérieur indique le commit construit et la date de construction. Chaque relance possède ses propres artefacts.

L’archive est créée dans un dossier neuf depuis une liste de fichiers autorisés. Elle contient les workspaces API/contrats, les sources et la construction du navigateur, les scripts MediaMTX, les tests et la documentation. Elle exclut les bases locales, les fichiers `.env`, les vidéos, les caches, `node_modules` et les sorties historiques. L’API utilise encore `tsx` pour démarrer : installer toutes les dépendances avec **`npm ci`**, sans `--omit=dev`. MediaMTX, FFmpeg et OBS s’installent sur le poste cible ; aucun binaire macOS n’est réutilisé pour Windows.

Consulter `INSTALLATION.txt`, puis `README.md` et les trois guides PDF dans `docs/guides/` de l’archive. Sur une salle déjà installée, conserver la base et les chemins des prises, terminer les captures et le direct avant de remplacer le code, puis vérifier OBS et relire une courte prise après le redémarrage. La réalisation automatique reste désactivée après redémarrage ; vérifier ses micros et plans avant de l’activer.

Cette livraison fournit une archive de code utilisable localement. L’installateur natif, les mises à jour automatiques et le déploiement cloud ne sont pas configurés. Le premier run GitHub doit confirmer les environnements des runners après ajout du workflow au dépôt ; un résultat local ne doit pas être présenté comme un run CI réussi.
