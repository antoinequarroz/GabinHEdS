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

Playwright **1.64.0** et ses navigateurs doivent être installés pour ce parcours. Le workflow GitHub installe son propre module dans un dossier temporaire, sans dépendance au runtime Codex. Sur un autre poste, indiquer ce module avec `GABIN_PLAYWRIGHT_MODULE` et installer les navigateurs avec la commande Playwright `install --with-deps`. Sur le Mac Codex, le script peut retrouver le runtime déjà fourni.

Sur le Mac, après construction et installation de MediaMTX :

```sh
job_id="$(portly temp 'npm run test:browser' --path "$PWD" --timeout 10m)"
portly wait "$job_id"
job_id="$(portly temp 'GABIN_TEST_BROWSER=webkit npm run test:browser' --path "$PWD" --timeout 10m)"
portly wait "$job_id"
```

`GABIN_TEST_BROWSER` accepte `chromium` ou `webkit`. Pour Chromium, `GABIN_CHROMIUM_CHANNEL=chrome` sélectionne Chrome officiel installé par Playwright, utile pour les codecs H.264/AAC. `GABIN_CHROMIUM_PATH` peut fournir un exécutable précis. `GABIN_SCREENSHOT_DIR` choisit le dossier des preuves de test ; conserver ce dossier hors des médias de la salle. WebKit utilise une deuxième origine du poste pour exercer l’association distante ; `GABIN_IPAD_HOST` permet de choisir son adresse explicitement.

Pour la validation matérielle, terminer par un test avec le vrai OBS de la salle, une courte prise, la lecture du fichier récupéré et, lorsqu’il est disponible, le vrai iPad. Une destination YouTube reste une configuration de salle ; les tests automatisés diffusent uniquement vers leur propre destination locale.

## Contrôles GitHub Actions

Le workflow [Nino CI](../../.github/workflows/nino-ci.yml) est déclenché par les push et pull requests modifiant `studio/` ou le workflow, et peut être lancé manuellement. Un nouveau run annule le run précédent sur la même branche.

| Contrôle | Environnement | Ce qui est vérifié |
| --- | --- | --- |
| Types, build et tests API / OBS | Ubuntu 24.04, Node.js 24, FFmpeg | Contrats, compilation, authentification, prises, affiches et protocole OBS |
| Parcours Chromium | Ubuntu 24.04, Chrome officiel, MediaMTX et FFmpeg | Parcours PC/iPad, HLS décodé, AAC et relais live local |
| Parcours WebKit | macOS 15, WebKit, MediaMTX et FFmpeg | Lecture HLS native et mêmes commandes |
| Archive locale validée | Ubuntu 24.04, après succès des contrôles | Code, interface construite et empreinte SHA-256 de l’archive |

Les binaires de navigateurs correspondent au module Playwright installé. Chrome officiel est choisi pour les codecs média ; WebKit est exécuté sur macOS pour la lecture native proche de Safari. Ce test ne remplace pas un iPad physique. Voir [les navigateurs et codecs Playwright](https://playwright.dev/docs/browsers) et [l’installation en CI](https://playwright.dev/docs/ci).

Les actions sont fixées à des SHA de commits vérifiés des publications officielles : [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node 7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) et [upload-artifact 7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2). Les permissions du workflow se limitent à la lecture du dépôt. Les runs de pull request ne produisent pas d’archive de distribution.

Les preuves navigateur sont conservées pendant **7 jours** : captures PNG et journal du test isolé. Les bases, tokens et médias temporaires ne sont pas téléversés. Les vrais identifiants OBS/YouTube et les secrets de la salle ne sont pas utilisés. Le token GitHub du run est fourni uniquement au téléchargement des métadonnées MediaMTX pour éviter la limite anonyme de l’API ; il n’est pas transmis au téléchargement de l’archive.

## Récupérer une version locale validée

Après un push ou un lancement manuel réussi, télécharger l’artefact **nino-local-<commit>** dans le run Actions. Il contient une archive `nino-studio-<commit>.zip` et son fichier `.sha256`, conservés pendant **14 jours**. Le fichier `release.json` à l’intérieur indique le commit construit et la date de construction.

L’archive est créée dans un dossier neuf depuis une liste de fichiers autorisés. Elle contient les workspaces API/contrats, les sources et la construction du navigateur, les scripts MediaMTX, les tests et la documentation. Elle exclut les bases locales, les fichiers `.env`, les vidéos, les caches, `node_modules` et les sorties historiques. L’API utilise encore `tsx` pour démarrer : installer toutes les dépendances avec **`npm ci`**, sans `--omit=dev`. MediaMTX, FFmpeg et OBS s’installent sur le poste cible ; aucun binaire macOS n’est réutilisé pour Windows.

Consulter `INSTALLATION.txt` puis `README.md` dans l’archive. Le guide PDF lié dans le README se récupère depuis le dépôt source. Sur une salle déjà installée, conserver la base et les chemins des prises, terminer les captures et le direct avant de remplacer le code, puis vérifier OBS et relire une courte prise après le redémarrage.

Cette livraison fournit une archive de code utilisable localement. L’installateur natif, les mises à jour automatiques et le déploiement cloud ne sont pas configurés. Le premier run GitHub doit confirmer les environnements des runners après ajout du workflow au dépôt ; un résultat local ne doit pas être présenté comme un run CI réussi.
