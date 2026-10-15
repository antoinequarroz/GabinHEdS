# Médias et récupération d’une production

La bibliothèque appartient au PC de la salle. Les appareils autorisés retrouvent les mêmes fichiers et les mêmes associations aux productions. Un fichier importé depuis l’iPad est envoyé au PC ; il reste disponible après la déconnexion de l’iPad.

## Préparer les médias

1. Ouvrir **Bibliothèque**, puis importer une image, une vidéo, un son ou un PDF. Chaque fichier est limité à **1 Go**. Attendre la fin du transfert et la confirmation de l’import.
2. Donner un nom reconnaissable à chaque média : « Intro épisode 3 », « Logo invité », « Musique de fin ».
3. Ouvrir une production, à l’étape de préparation, et associer ses médias avec leur rôle : introduction, logo, présentation, conclusion, musique ou autre.
4. Dans la régie, sélectionner le média à diffuser. Les fichiers vidéo et images peuvent occuper le programme ; les sons peuvent accompagner la scène en cours. Les PDF sont conservés et exportés ; préparer leur affichage dans PowerPoint/OBS.

Le navigateur propose une consultation du fichier quand son format est compatible. La commande de régie agit sur **OBS sur le PC** ; écouter un aperçu dans le navigateur ne diffuse pas ce média dans la production.

La lecture dans OBS exige une connexion confirmée. Le contrôleur vérifie la source et son état, et refuse de remplacer une source qui ne lui appartient pas. Une seule commande média est active à la fois. Pour superposer un logo, utiliser le mode prévu dans la régie ; pour des compositions avancées, préparer les scènes dans OBS.

Arrêter un média en plein écran retrouve la scène précédente si elle est encore celle choisie par Nino. À la fin d’un clip, le bouton **Revenir au plan précédent** reste disponible pour retrouver ce plan. Si un opérateur a changé de plan entre-temps, sa sélection est conservée. Les boutons d’enregistrement et de live gardent leur fonctionnement indépendant. Un média doit être associé à cette production avant de le lancer avec son identifiant de projet, y compris depuis le Stream Deck.

Archiver un média le retire des nouvelles sélections. Son fichier et ses associations existantes sont conservés afin de récupérer les anciennes productions. Restaurer le média le rend à nouveau disponible. Modifier son nom ne modifie pas les vidéos déjà enregistrées.

## Lire et récupérer les prises

1. Terminer la prise et attendre la confirmation d’OBS.
2. Ouvrir les prises de cette production et lancer la lecture de la prise terminée.
3. Si nécessaire, attendre la préparation de la copie MP4 de lecture. FFmpeg doit être installé sur le PC. Cette préparation ne modifie pas l’original.
4. Choisir **Télécharger en MP4** pour obtenir un fichier vidéo compatible à copier sur une clé USB, **Télécharger le fichier** pour conserver l’original OBS, ou **Récupérer le dossier complet** pour réunir les pièces de la production.
5. Attendre la fin du téléchargement dans le navigateur. Sur iPad, retrouver le fichier dans **Fichiers → Téléchargements**. Décompresser le ZIP si vous avez choisi le dossier complet.

**Télécharger en MP4** prépare uniquement la prise choisie, sans ZIP ni timeline. Le PC réutilise la copie MP4 compatible déjà disponible ou la prépare avec le même traitement que la lecture et Resolve. Attendre **Préparation du MP4…** si nécessaire ; **Annuler l’attente** arrête l’attente du navigateur, sans toucher à la prise originale. Le message de lancement ne confirme pas la fin du transfert : vérifier les téléchargements, puis copier le fichier `.mp4` sur la clé USB. DaVinci n’est pas nécessaire sur le PC de la salle.

Le ZIP regroupe les prises terminées originales, les médias associés, les métadonnées de la production, les repères et le journal `scene-changes.json` des plans confirmés par OBS.

Le bouton **Télécharger pour DaVinci Resolve** prépare un second paquet avec les mêmes originaux et médias, des copies MP4 compatibles dans `resolve-media/`, et une timeline `.otio` par prise. Une vidéo terminée suffit : le mode automatique n’est pas requis. Le paquet contient la vidéo du programme et son audio liés, les repères et les changements de plans dont la position a été confirmée pendant l’enregistrement. Les originaux restent inchangés.

Décompresser tout le ZIP puis, dans Resolve, choisir **Fichier → Importer → Timeline**, sélectionner une timeline `.otio` à la racine du paquet et indiquer `resolve-media/` si le logiciel demande les fichiers. Le script Python fourni constitue une méthode optionnelle pour créer un nouveau projet et importer toutes les timelines. L’import et le déplacement du paquet ont été vérifiés dans DaVinci Resolve Studio 21.1 avec un média de test.

Les changements de caméra sont déjà présents dans l’image du programme enregistré. Le journal sert à les retrouver ; il ne recrée pas des angles caméra séparés qui n’ont pas été capturés. Les changements pendant une pause n’ont pas de position vidéo inventée : le plan à la reprise est ancré sur le timecode OBS réel.

Un fichier original déplacé ou supprimé bloque l’export complet avec une erreur. Les prises interrompues sont signalées dans les métadonnées ; elles ne sont pas présentées comme des vidéos terminées. Terminer l’enregistrement et le live de la production avant de l’exporter.

Les liens de lecture et de téléchargement sont temporaires et liés à l’accès de l’appareil. Révoquer l’appareil invalide ses liens. Un transfert déjà commencé peut se poursuivre ; demander un nouveau lien pour une nouvelle lecture ou un téléchargement expiré.

## Emplacements sur le PC

Les originaux OBS gardent la racine d’enregistrement réglée dans **Salle et OBS**. La bibliothèque est privée dans `studio/.data/library/` et les copies de lecture dans `studio/.data/playback/` (ou dans le dossier `GABIN_DATA_DIR` configuré). Ces dossiers ne sont pas servis publiquement et ne sont jamais ajoutés au dépôt Git.

Le cache de lecture est limité à 20 Go par défaut et ses copies inutilisées vieillissent après sept jours ; une session de lecture valide protège sa copie. La préparation utilise un seul traitement à la fois et conserve une réserve de 1 Go sur le disque. Une conversion qui dépasse trente minutes, manque d’espace ou tronque la vidéo est refusée avec un message : télécharger l’original reste possible. Le technicien peut adapter le budget avec `GABIN_PLAYBACK_CACHE_MAX_BYTES`, exprimé en octets, avant le démarrage du serveur.

Le ZIP ne contient ni base de données privée, ni mot de passe OBS, ni clé de live, ni jeton d’appareil. Il constitue un dossier de production partageable. Pour sauvegarder toute la salle et ses réglages, réaliser séparément une copie du dossier de données à l’arrêt et des originaux OBS.

## Stream Deck

La page **Appareils** donne les requêtes pour lancer un média, le mettre en pause, reprendre ou l’arrêter. Les commandes passent par `/api/control` avec le jeton opérateur dédié. Consulter [le guide Stream Deck](stream-deck.md) pour les en-têtes, les identifiants et les retours d’état.
