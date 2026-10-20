# Stream Deck et Bitfocus Companion

Le Stream Deck pilote Nino par **la même API authentifiée que le PC et l’iPad**. Il ne doit pas envoyer de commandes OBS en parallèle : Nino organise le projet actif, le dossier de destination, les prises et leurs repères.

Les profils Companion Nino utilisent le module **Generic HTTP Requests** pour les commandes et un pont local Nino pour leurs états réels. Le pont met à jour les variables des touches ; toutes les commandes de production restent authentifiées par Nino. La [documentation du module HTTP](https://github.com/bitfocus/companion-module-generic-http/blob/master/companion/HELP.md) décrit les requêtes JSON et les en-têtes.

## Arriver dans la salle : accueil et ouverture du studio

Les six pages importables, leurs variables de navigation et les étapes d’installation sont dans [`config/stream-deck`](../config/stream-deck/README.md). L’Accueil affiche le logo Nino et la touche **Ouvrir le studio**. Le Menu ouvre ensuite Régie, Audio, Médias et Invités. Les exports ne contiennent aucun jeton : créer l’accès opérateur dans Nino et le saisir directement dans Companion, dans une variable locale persistante `nino_token`.

Sur Windows, le raccourci d’ouverture de session prépare les services Nino en arrière-plan, puis ouvre Companion. Il n’ouvre pas OBS ni le navigateur et ne démarre ni prise, ni retour programme, ni live. L’Accueil reste visible même lorsqu’aucune production n’a encore été sélectionnée. Configurer la surface USB pour démarrer sur Accueil, sans reprendre la dernière page utilisée ; les numéros proposés conservent les pages 2 à 6 et ajoutent l’Accueil en page 7.

**Ouvrir le studio** appelle `POST /api/control` avec `{"action":"studio.open"}` et l’accès opérateur habituel. Sur Windows, Nino demande au lanceur installé d’ouvrir OBS et son interface, en réutilisant les composants déjà ouverts. La commande ne reçoit aucun chemin, argument de programme ni commande à exécuter. Elle ne sélectionne pas de production et ne lance pas d’enregistrement ou de live. Les états affichés restent ceux réellement observés par Nino et OBS ; une demande d’ouverture n’est pas une confirmation que la salle est prête.

Si Nino est hors ligne, utiliser le raccourci Windows **Nino + OBS**, puis vérifier la connexion. Si la touche indique **LIER LE DECK**, vérifier l’accès opérateur dans Companion. Voir la [configuration du démarrage Windows](windows-installer.md#accueil-du-stream-deck-à-louverture-de-session).

**VERSION NINO REQUISE** désactive l’ouverture lorsqu’elle n’est pas disponible sur le serveur utilisé, notamment avec une ancienne version ou sur le Mac de prévisualisation. Installer la nouvelle version Windows avant d’utiliser cette touche ; les pages de régie existantes gardent leurs commandes habituelles.

## Choisir la production et tout lancer

Les pages de contrôle conservent le style sombre, avec un bandeau d’état, un contour et un voyant pour les fonctions actives.

1. Démarrer Nino, OBS et Companion sur le même ordinateur. Companion doit être disponible sur `127.0.0.1:8000`. Importer les pages du profil Nino et renseigner son accès Stream Deck comme décrit ci-dessous.
2. Dans la production Nino, cliquer **Utiliser cette production sur le Stream Deck**. Attendre la confirmation de synchronisation avec Companion. La sélection de la production est conservée après redémarrage ; elle ne démarre aucun enregistrement.
3. Les plans et micros suivent les participants de la production. L’intro, l’outro, le logo et le son suivent ses médias associés. Une affectation absente ou ambiguë reste à configurer ; Nino ne choisit pas arbitrairement entre plusieurs intros du même projet.
4. La touche **Tout lancer**, dans le Menu du Stream Deck, démarre les vérifications, attend l’enregistrement réellement confirmé par OBS, joue l’intro si elle est associée, revient à la scène de démarrage puis active la réalisation automatique si ses réglages sont prêts. Le même lancement est disponible dans Nino sur PC/iPad.
5. **Le live se lance séparément.** Tout lancer n’envoie pas le programme à YouTube. Les boutons de diffusion restent indépendants de la prise locale.

Pendant le lancement, Nino affiche l’étape en cours. Une commande manuelle peut interrompre la suite automatique. **Annuler la séquence ne termine pas une prise déjà démarrée** : vérifier l’état dans la régie et utiliser Arrêter prise pour terminer et conserver la vidéo. Un échec ne doit jamais être présenté comme un enregistrement réussi ; une prise démarrée reste visible et contrôlable.

Les touches reflètent les observations de Nino : caméra affichée, enregistrement et compteur OBS, pause, micros coupés, état AUTO, média et invités. Le témoin LIVE suit `media.liveStatus`, qui décrit l’envoi vers la plateforme ; le transport local `obs.streaming` ne prouve pas un live YouTube. Une liaison expirée ou déconnectée doit rendre les anciens états indisponibles, jamais les laisser présentés comme actuels.

« Companion synchronisé » confirme la liaison logicielle avec Companion. Tester également les touches sur le Stream Deck branché en USB. Le pont ne démarre pas Companion à la place de l’utilisateur et ne remplace pas l’accès opérateur des boutons.

API d’affectation : `POST /api/streamdeck/select` avec `{"projectId":"ID_DU_PROJET"}` et le même en-tête Bearer opérateur que les autres commandes. Le projet doit exister et être utilisable ; changer de production pendant une prise ou une séquence est refusé.

API de lancement : `POST /api/control` avec `{"action":"production.start","projectId":"ID_DU_PROJET","includeLive":false}`. Pour interrompre la séquence sans terminer la prise : `{"action":"production.cancel"}`. Lire `streamDeck` et `launch` dans l’état Nino pour afficher les confirmations et les erreurs.

## Créer l’accès de l’appareil

Dans Nino sur le PC, ouvrir **Appareils**, puis créer un accès Stream Deck avec un nom explicite. Copier le jeton affiché une seule fois. Le rôle `operator` permet les commandes de production ; il ne donne pas les réglages techniques ni la création d’autres appareils.

L’opération correspond à cette requête API, exécutée avec un jeton **technicien**. Les valeurs en majuscules sont à remplacer ; elles ne sont pas des identifiants valides :

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/devices' \
  --header 'Authorization: Bearer JETON_TECHNICIEN' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Stream Deck régie","kind":"streamdeck","role":"operator"}'
```

La réponse `AuthResult` contient `{ "token": "…", "device": { "id": "…", "name": "…", "kind": "streamdeck", "role": "operator", "createdAt": "…", "expiresAt": null } }`. Utiliser **ce nouveau jeton**, jamais celui du technicien, dans les boutons. Révoquer l’accès depuis le PC en cas de perte ou avant de céder une configuration Companion contenant ce jeton.

## Configurer Companion

1. Ajouter la connexion **Generic HTTP Requests** et choisir l’adresse Nino comme Base URL. Sur le PC de la salle : `http://127.0.0.1:4310`. Pour une installation HTTPS, utiliser son adresse sécurisée et conserver la validation du certificat.
2. Dans chaque action POST, choisir `/api/control`, le type `application/json` et cet en-tête JSON :

   ```json
   {"Authorization":"Bearer JETON_STREAM_DECK"}
   ```

3. Renseigner le corps indiqué dans la table. Le projet est créé dans Nino ; récupérer son `id` via `/api/state`. Le nom des scènes doit correspondre exactement à une scène OBS disponible.

| Bouton | Corps JSON du POST `/api/control` |
| --- | --- |
| Ouvrir OBS et l’interface Nino sur Windows | `{"action":"studio.open"}` |
| Enregistrer | `{"action":"record.start","projectId":"ID_DU_PROJET"}` |
| Arrêter | `{"action":"record.stop"}` |
| Pause | `{"action":"record.pause"}` |
| Reprendre | `{"action":"record.resume"}` |
| Plan large | `{"action":"scene.set","sceneName":"Plan large"}` |
| Couper micro 1 | `{"action":"input.mute","inputName":"Micro 1","muted":true}` |
| Ouvrir micro 1 | `{"action":"input.mute","inputName":"Micro 1","muted":false}` |
| Repère | `{"action":"marker.add","label":"À revoir au montage"}` |
| Démarrer le retour vidéo | `{"action":"preview.start"}` |
| Arrêter le retour vidéo | `{"action":"preview.stop"}` |
| Démarrer le live | `{"action":"stream.start","projectId":"ID_DU_PROJET"}` |
| Arrêter le live | `{"action":"stream.stop"}` |
| Activer / reprendre l’automatique | `{"action":"auto.start","projectId":"ID_DU_PROJET"}` |
| Revenir en manuel | `{"action":"auto.stop"}` |
| Lancer une intro | `{"action":"media.play","assetId":"ID_DU_MEDIA","projectId":"ID_DU_PROJET","mode":"fullscreen"}` |
| Afficher un logo | `{"action":"media.play","assetId":"ID_DU_MEDIA","projectId":"ID_DU_PROJET","mode":"overlay"}` |
| Lancer un son | `{"action":"media.play","assetId":"ID_DU_MEDIA","projectId":"ID_DU_PROJET","mode":"audio"}` |
| Pause du média | `{"action":"media.pause"}` |
| Reprendre le média | `{"action":"media.resume"}` |
| Arrêter le média | `{"action":"media.stop"}` |
| Préparer les sources des invités | `{"action":"guest.prepare","projectId":"ID_DU_PROJET"}` |
| Accueillir l’invité 1 | `{"action":"guest.admit","guestId":"ID_INVITE_1"}` |
| Afficher l’invité 1 | `{"action":"guest.scene","guestId":"ID_INVITE_1"}` |
| Couper l’invité 1 | `{"action":"guest.mute","guestId":"ID_INVITE_1","muted":true}` |
| Réactiver l’invité 1 | `{"action":"guest.mute","guestId":"ID_INVITE_1","muted":false}` |
| Retirer l’invité 1 | `{"action":"guest.remove","guestId":"ID_INVITE_1"}` |
| Fermer la liaison des invités | `{"action":"guest.bridge.stop","projectId":"ID_DU_PROJET"}` |

**Le champ `requestId` est facultatif** : lorsqu’il est absent, le serveur génère un identifiant pour cette commande. Les corps fixes ci-dessus sont donc utilisables à chaque pression de bouton. Pour une intégration qui réessaie automatiquement une commande après un problème réseau, générer un UUID par pression et réutiliser ce même UUID uniquement pour les tentatives de cette pression. Un UUID déjà exécuté ne doit jamais identifier une nouvelle pression.

Éviter les boutons « toggle » qui supposent l’état de la capture. Préférer des boutons distincts Enregistrer/Arrêter et Pause/Reprendre, avec le retour d’état lu sur Nino. Le lancement peut être refusé si la préparation du projet contient un blocage, si OBS est déconnecté ou si un autre enregistrement est actif.

Les boutons live sont indépendants des boutons d’enregistrement : **Arrêter le live** conserve la prise locale et le retour vidéo. **Arrêter la prise** conserve la diffusion. **Arrêter le retour vidéo** est refusé tant qu’un live l’utilise. Le technicien configure le serveur et la clé de diffusion dans Nino ; aucun bouton ne doit contenir cette clé.

Configurer d’abord les micros distincts, leurs plans et le plan large dans la production et la régie PC/iPad. L’automatique ne démarre ni prise ni direct. Une touche de sélection de plan ou un média plein écran suspend le mode ; appuyer explicitement sur la touche d’activation pour le reprendre. Révoquer l’appareil qui l’a activé suspend immédiatement l’automatique. Après redémarrage de Nino, les réglages sont conservés mais l’activation reste éteinte.

## Lire le retour réel du studio

Les pages fournies reçoivent ces informations par le pont local Nino. Pour construire un contrôleur personnalisé, créer une action GET `/api/state` avec le même en-tête Bearer. Elle renvoie `StudioState`, dont les informations utiles sont :

| Champ | Usage |
| --- | --- |
| `obs.connected` et `obs.error` | Connexion et erreur OBS |
| `obs.recording` | Enregistrement confirmé par OBS |
| `obs.paused` | Pause confirmée par OBS |
| `obs.currentScene` | Scène réellement sélectionnée |
| `autoDirection.enabled`, `autoDirection.status`, `autoDirection.message` | Activation et état de détection ; `waiting` indique une attente de signal valide |
| `autoDirection.projectId`, `autoDirection.participantId` | Production pilotée et micro dominant confirmé |
| `obs.timecode` | Compteur retourné par OBS |
| `activeTake.projectId` | Projet de la prise en cours, si présent |
| `liveProjectId` | Projet du direct en cours ; nul sans direct |
| `takes[].outputPath` | Chemin de sortie confirmé pour la prise |
| `obs.streaming` | Transport du programme OBS vers MediaMTX local ; ce champ n’indique pas une diffusion publique |
| `media.previewReady` | Programme disponible pour le retour vidéo |
| `media.liveStatus` | État du relais public : `idle`, `starting`, `live`, `stopping` ou `error` |
| `media.liveError` | Erreur du relais de diffusion |
| `library[]` | Médias nommés et identifiants disponibles pour les boutons |
| `projectMedia[ID_DU_PROJET]` | Médias associés et leur rôle dans la production |
| `mediaPlayback.assetId` et `mediaPlayback.status` | Média contrôlé et état confirmé (`playing`, `paused`, `shown`, `stopped`, ou `unknown` si incertain) |
| `guestRooms[ID_DU_PROJET].bridge.connected` / `.mediaReady` | Connexion de liaison PC / image et son de salle prêts ; une connexion seule n’est pas un média prêt |
| `guestRooms[ID_DU_PROJET].guests[]` | Les places invitées, leurs identifiants `id`, `slot`, noms et états |
| `guests[].joined` / `.mediaReady` | Connexion de l’invité / réception image et son dans la liaison |
| `guests[].admitted` / `.sourceReady` | Admission / réception réelle par la source OBS ; attendre les deux pour sélectionner le plan |
| `guests[].muted` / `.error` | Coupure du micro / indisponibilité à afficher sur les touches |

Avec les pages Nino fournies, le pont local remplit automatiquement les variables `nino_state_*` : aucune requête GET de rafraîchissement n’est à ajouter dans Companion. Le module HTTP conserve seulement le résultat des commandes pour le diagnostic. Pour une intégration personnalisée, les champs du tableau restent disponibles dans le GET authentifié `/api/state`. Un retour de commande HTTP ne constitue pas, à lui seul, un témoin rouge d’enregistrement ; lire `obs.recording` et vérifier la connexion.

L’API possède également `/api/events` pour une intégration WebSocket dédiée. Après l’ouverture, envoyer `{"type":"auth","token":"JETON_STREAM_DECK"}` ; les messages d’état sont `{"type":"state","state":StudioState}`. Les mesures audio sont des messages distincts `{"type":"audio","frame":{"capturedAt":"…","inputs":[{"inputName":"Micro 1","rmsDb":-24,"peakDb":-18}]}}` et restent éphémères. Les secrets sont transmis dans le message d’authentification, pas dans l’URL. Le module HTTP générique n’implémente pas cette connexion persistante ; un futur module Nino pourra l’utiliser.

## Boutons pour les deux invités à distance

Créer les invitations depuis la production sur PC ou iPad. Préparer les sources OBS, puis ouvrir la liaison audio/vidéo sur le **PC de la salle** : caméra virtuelle OBS en mode Programme et entrée audio de salle sans voix distantes. Un Stream Deck ne fournit pas ce pont média. Voir le [parcours complet des invités](remote-guests.md).

Récupérer les identifiants des places avec le GET authentifié `/api/state` :

```text
guestRooms[ID_DU_PROJET].guests
  place 1 : entrée où slot === 1 et status !== "removed" → son champ id
  place 2 : entrée où slot === 2 et status !== "removed" → son champ id
```

Utiliser ces `id` comme `guestId`, jamais le jeton secret du lien d’invitation. Les noms servent à l’affichage ; ils ne remplacent pas les identifiants. Après renouvellement d’une invitation ou changement de production, relire l’état et vérifier les identifiants avant de réutiliser les touches. La page **Appareils** de Nino génère également les corps JSON pour l’invité sélectionné.

Dupliquer les touches **Accueillir**, **Afficher**, **Couper**, **Réactiver** et **Retirer** pour la seconde place, en remplaçant uniquement `guestId`. Garder des actions explicites avec `muted:true` et `muted:false` ; un toggle fondé sur le dernier état local pourrait inverser le son après une déconnexion.

Un jeu de touches utilisable en salle :

```text
┌──────────────────┬──────────────────┬──────────────────┐
│ Plan large       │ Afficher invité 1│ Afficher invité 2│
├──────────────────┼──────────────────┼──────────────────┤
│ Accueillir 1     │ Couper 1         │ Réactiver 1      │
├──────────────────┼──────────────────┼──────────────────┤
│ Accueillir 2     │ Couper 2         │ Réactiver 2      │
├──────────────────┼──────────────────┼──────────────────┤
│ Enregistrer      │ Arrêter prise    │ Fermer liaison   │
└──────────────────┴──────────────────┴──────────────────┘
```

**Accueillir** autorise la conversation ; **Afficher** sélectionne son plan seulement après réception par OBS. Une touche **Afficher** trop tôt reçoit un refus, sans simuler une réussite. Les états de la place doivent guider les voyants : « En attente », « Connexion OBS… », « Dans OBS », « Micro coupé » ou « Déconnecté ».

**Couper** agit sur le son de l’invité dans OBS et pour l’autre invité. **Retirer** coupe sa participation et révoque son accès. **Fermer la liaison** coupe le pont des invités de cette production ; cette commande n’arrête ni l’enregistrement ni le live. Prévoir des boutons distincts pour terminer ces activités.

Les invités reçus et admis rejoignent la réalisation automatique quand leur micro est ouvert. Les commandes manuelles de plan, y compris `guest.scene`, gardent la priorité et suspendent le mode automatique. Le redémarrage du serveur ou la révocation de l’accès créateur ne relance pas automatiquement un appel.

## Exemples API avec identifiants de requête

Ces exemples `curl` sont destinés à un terminal POSIX sur le PC. Remplacer les jetons, le projet et les noms de scènes. Les identifiants sont des **exemples statiques** : en générer un nouveau pour toute nouvelle action ; les conserver uniquement pour réessayer une action dont la réponse s’est perdue.

### Démarrer la production

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"record.start","projectId":"ID_DU_PROJET","requestId":"11111111-1111-4111-8111-111111111111"}'
```

### Changer de plan

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"scene.set","sceneName":"Plan large","requestId":"22222222-2222-4222-8222-222222222222"}'
```

### Pause et reprise

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"record.pause","requestId":"33333333-3333-4333-8333-333333333333"}'

curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"record.resume","requestId":"44444444-4444-4444-8444-444444444444"}'
```

### Ajouter un repère de montage

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"marker.add","label":"Début du sujet 2","requestId":"55555555-5555-4555-8555-555555555555"}'
```

### Arrêter et consulter les prises

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"record.stop","requestId":"66666666-6666-4666-8666-666666666666"}'

curl --fail-with-body 'http://127.0.0.1:4310/api/state' \
  --header 'Authorization: Bearer JETON_STREAM_DECK'
```

### Révoquer l’appareil

```sh
curl --fail-with-body --request DELETE 'http://127.0.0.1:4310/api/devices/ID_APPAREIL' \
  --header 'Authorization: Bearer JETON_TECHNICIEN'
```

Après révocation, le jeton de cet appareil est refusé, y compris pour les GET. Garder les jetons hors du dépôt Git et des exports de configuration partagés. Sur un réseau, appliquer les mêmes règles HTTPS et de restriction d’accès que dans [l’installation iPad](../README.md#contrôle-ipad-et-réseau-local).

### Démarrer puis arrêter la diffusion publique

Ces commandes exigent une destination live enregistrée et MediaMTX/FFmpeg disponibles. L’identifiant du projet définit la production diffusée ; le démarrage ne lance pas automatiquement une prise locale.

```sh
curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"stream.start","projectId":"ID_DU_PROJET","requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'

curl --fail-with-body --request POST 'http://127.0.0.1:4310/api/control' \
  --header 'Authorization: Bearer JETON_STREAM_DECK' \
  --header 'Content-Type: application/json' \
  --data '{"action":"stream.stop","requestId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}'
```

Attendre `media.liveStatus === "live"` pour le témoin de diffusion publique. L’état de la prise reste `obs.recording`. Vérifier séparément l’événement publié dans la plateforme destinataire.

Une prise et un live simultanés doivent concerner le même projet. Pour changer de production, terminer les activités du projet précédent ; le contrôleur refuse de réattribuer une prise ou un direct actif. Le bouton **Arrêter le live** reste utilisable si la connexion OBS est perdue, afin de couper le relais public depuis le Stream Deck.

### Retrouver les médias et exporter la production

L’identifiant `assetId` se retrouve dans **Bibliothèque**, dans les exemples de la page **Appareils** ou via GET `/api/state` / `/api/library`. Le bouton sélectionne un identifiant de média ; il ne reçoit jamais un chemin arbitraire vers un fichier du PC. Les PDF ne sont pas directement diffusables par cette commande.

Un POST `/api/projects/ID_DU_PROJET/export-ticket` avec le jeton de l’appareil fournit un lien temporaire de téléchargement ZIP, une fois la production arrêtée. Un contrôleur HTTP peut demander ce lien ; son téléchargement et son enregistrement se font sur l’ordinateur ou la tablette, pas sur les touches du Stream Deck. Les prises individuelles gardent leur POST `/api/takes/ID_DE_LA_PRISE/download-ticket`.
