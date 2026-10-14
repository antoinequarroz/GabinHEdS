# Inviter deux personnes à distance

Nino réunit jusqu’à **quatre personnes dans la salle et deux invités à distance**. Chaque invité rejoint depuis un navigateur avec son lien personnel. La régie PC, l’iPad et le Stream Deck utilisent les mêmes commandes d’admission, de micro et de plan.

Le PC assure la liaison pendant l’appel : il transmet l’image du programme OBS et une entrée audio contenant les voix de la salle. L’iPad pilote la régie ; il ne devient pas la liaison audio/vidéo du studio.

**Avant une utilisation sur Internet, l’adresse HTTPS des invités et le relais TURN doivent être configurés et testés par l’administrateur.** Le mode par défaut `http://127.0.0.1:4312` permet un essai sur le PC ; ce lien ne donne pas accès à la salle depuis un autre ordinateur. Ce chapitre complète les [guides PDF](guides/) déjà livrés.

## Préparer le premier appel

1. Ouvrir ou créer la production dans Nino. Associer les personnes présentes à leurs micros et plans OBS.
2. Dans **Invités à distance**, donner un nom à la première personne puis choisir **Créer un lien d’invitation**. Copier le lien personnel. Répéter pour la seconde place si nécessaire.
3. Choisir **Préparer les sources OBS**. Nino crée les sources navigateur et plans réservés à cette production, vérifie leur présence dans OBS et démarre la caméra virtuelle. Cette opération ne démarre ni enregistrement ni live et ne change pas le plan affiché.
4. Vérifier dans OBS que la caméra virtuelle transmet le **Programme**, et non l’aperçu du mode Studio ou une scène fixe. Les modes de sortie sont décrits dans le [guide officiel de la caméra virtuelle OBS](https://obsproject.com/kb/virtual-camera-guide).
5. Sur le PC de la salle, choisir **Ouvrir la liaison de la salle**. Autoriser les fenêtres de Nino si le navigateur les bloque. Garder cette fenêtre ouverte pendant l’appel.
6. Dans la fenêtre de liaison, choisir **Ouvrir caméra et micro**. Autoriser la caméra et le micro pour cette page.
7. Choisir **OBS Virtual Camera** comme image du programme. Pour **Entrée audio de la salle**, choisir le mixage des micros locaux sur l’interface audio : cette entrée doit contenir toutes les personnes présentes et aucune voix distante. Après un changement d’appareil, choisir **Actualiser l’aperçu**.
8. Vérifier l’image et les deux confirmations sous les sélecteurs, puis choisir **Connecter la salle aux invités**. Attendre **Liaison de la salle prête** dans la régie.
9. Envoyer les invitations personnelles aux invités. Le logiciel crée les liens ; il n’envoie pas automatiquement de messages.

Une seule entrée audio dans la liaison peut être le mixage de plusieurs micros fourni par l’interface de la salle. Un micro unique de Mac ne devient pas quatre micros séparés. Les canaux distincts restent nécessaires dans OBS pour choisir automatiquement le plan de chaque personne présente.

Ne pas sélectionner le mixage final OBS, le son système ou une boucle audio qui inclut les invités comme entrée de la salle. Cette erreur remettrait leur propre voix dans leur retour. Utiliser un casque pour l’écoute sur le PC et pour chaque invité. La fonction **Écouter les invités au casque** est explicite ; la fenêtre de liaison ne joue aucun son sur les haut-parleurs avant cette action.

## Ce que fait l’invité

1. Ouvrir son lien personnel dans un navigateur à jour, sur ordinateur, tablette ou téléphone.
2. Saisir ou vérifier son nom. Brancher des écouteurs ou un casque.
3. Choisir **Vérifier caméra et micro** et autoriser les appareils. L’aperçu reste sur cet appareil tant que l’invité ne rejoint pas l’appel.
4. Choisir la caméra et le micro souhaités, puis actualiser l’aperçu après un changement.
5. Choisir **Rejoindre la salle**. L’invité passe en **Salle d’attente** : son image arrive à la régie ; le retour sonore et vidéo de la conversation commence après admission.
6. Après admission, vérifier l’image du programme et le son de la salle. Si le navigateur affiche **Activer le son de la salle**, choisir ce bouton.
7. Utiliser **Couper mon micro** pour couper son propre envoi et **Réactiver mon micro** pour le reprendre. La régie conserve son propre contrôle du micro, indépendant de cette action.
8. Choisir **Quitter l’appel** pour arrêter la caméra et le micro. Une nouvelle invitation sera nécessaire pour un nouvel appel après cette sortie volontaire.

La capture caméra/micro d’un navigateur demande un contexte sécurisé et une autorisation de l’utilisateur ; l’adresse publique doit donc être HTTPS avec un certificat accepté par l’appareil. Le test local sur localhost bénéficie d’une exception du navigateur. Voir [la documentation `getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Après une actualisation de la page, la session de reprise reste dans l’onglet pendant sa durée de validité. La page propose de rejoindre à nouveau : elle ne rallume pas la caméra ou le micro sans action. Si cette session a expiré, si le serveur a redémarré ou si l’accès a été retiré, demander un nouveau lien à la salle.

## Accueillir, écouter et afficher

Dans la régie, chaque place indique son état réel :

| État affiché | Ce qu’il permet |
| --- | --- |
| Invitation créée | Lien créé ; la personne n’est pas encore connectée. |
| Vérification caméra et micro… | Connexion ouverte ; la réception des médias n’est pas encore confirmée. |
| Prêt en salle d’attente | La liaison reçoit réellement l’image et le son de l’invité. |
| Connexion OBS… | L’invité est admis ; la réception de sa source OBS est encore en cours. |
| Dans OBS | La source reçoit les médias ; le bouton **Afficher l’invité** devient utilisable. |
| Déconnecté | Le signal ou la session n’est plus disponible. Vérifier la connexion avant d’admettre à nouveau. |

Choisir **Accueillir dans la conversation** lorsque l’invité et la liaison sont prêts. La réception dans OBS peut demander quelques secondes. Attendre **Dans OBS**, puis choisir **Afficher l’invité** si son plan doit passer au programme. Admission et sélection du plan sont deux opérations distinctes : accueillir une personne ne coupe pas automatiquement le plan en cours.

**Couper le micro** et **Réactiver le micro** agissent sur le son de l’invité dans OBS et dans le retour des autres personnes. Les boutons sont également accessibles sur iPad et via l’API Stream Deck. **Retirer l’invité** coupe sa participation et révoque son accès. Pour une place non connectée, **Révoquer l’invitation** invalide le lien.

Le changement automatique de caméra inclut un invité quand il est admis, reçu dans OBS et non muet. Un invité en attente, muet ou déconnecté est écarté. Le vumètre de sa place vient d’OBS ; une connexion WebSocket seule n’est jamais annoncée comme une caméra prête.

Si une source perd ses médias, la page OBS affiche une attente au lieu de conserver une image gelée. Nino bloque la sélection d’un plan invité indisponible et coupe le son devenu indisponible. Revenir explicitement au plan large depuis la régie ; contrôler aussi l’image et le son dans OBS avant de reprendre la conversation.

## D’où vient le retour sans sa propre voix ?

```text
Micro(s) de salle ── entrée audio de salle ───────┐
Caméra virtuelle OBS ── programme vidéo ────────┤
                                                ▼
                                        Liaison navigateur PC
                                          │             │
                     retour invité A      │             │      retour invité B
                     image programme      │             │      image programme
                     voix salle + B       ▼             ▼      voix salle + A
                                       invité A       invité B

Caméra + micro A ───── WebRTC ──► source OBS A ──┐
Caméra + micro B ───── WebRTC ──► source OBS B ──┼─► OBS ─► prise / live
Caméras + micros de salle ──────────────────────┘
```

Le retour A exclut le micro A ; le retour B exclut le micro B. Les invités en attente et les micros coupés sont exclus du mixage envoyé à l’autre personne. Les sources OBS reçoivent séparément les médias de chaque invité admis. Le HLS de la régie sert au contrôle du programme sur PC/iPad ; il ne sert pas à la conversation, afin de ne pas réintroduire son délai et le mixage complet.

Cette exclusion électronique ne corrige pas une mauvaise entrée audio de salle ou un retour joué à fort volume dans un micro. Vérifier le casque, l’interface audio et le mixage de salle pendant la recette.

## Enregistrer, diffuser puis récupérer

1. Vérifier le son de la salle et des deux invités dans OBS, puis sélectionner le plan souhaité ou activer la réalisation automatique.
2. Démarrer **l’enregistrement** depuis Nino et attendre la confirmation OBS.
3. Pour un live, démarrer aussi **la diffusion** avec la destination déjà configurée. Contrôler l’événement sur la plateforme. Enregistrement et live restent indépendants.
4. Pendant la production, changer de plan, couper un micro, ajouter un repère ou suspendre l’automatique depuis le PC, l’iPad ou le Stream Deck.
5. Terminer la prise et arrêter le live séparément. La fermeture de la liaison ne termine pas ces deux activités.
6. Dans **Les prises**, relire la vidéo, récupérer le fichier individuel, **Récupérer le dossier complet** ou **Télécharger pour DaVinci Resolve**. Les voix et plans des invités présents dans le programme font partie de cette vidéo.
7. Choisir **Fermer la liaison** dans la régie, puis vérifier l’arrêt de la caméra et du micro de la fenêtre PC. Retirer les invités ou révoquer les invitations inutilisées.

La récupération conserve la captation du programme. Cette version ne produit pas un fichier isolé de chaque caméra distante ou locale, ni un projet multicaméra permettant de retrouver les angles non sélectionnés. Voir [la bibliothèque et la récupération](media-library.md) et les [commandes Stream Deck](stream-deck.md).

## Configuration réseau pour l’administrateur

Le processus Nino sert deux applications séparées :

| Accès | Destination | Usage |
| --- | --- | --- |
| Réseau privé de salle | Contrôleur sur 4310 | PC, iPad, API Stream Deck, projets et téléchargements authentifiés. |
| Adresse publique HTTPS dédiée | Proxy vers la passerelle locale sur 4312 | Page d’invitation et signalisation des invités uniquement. |
| Boucle locale | WebSocket OBS sur 4455 | Contrôle OBS par Nino ; ne pas publier. |
| Relais TURN configuré | Adresse et ports du relais | Transport WebRTC lorsque la connexion directe est impossible. |

Ne pas publier le contrôleur 4310 ni OBS 4455 sur Internet. La passerelle 4312 n’enregistre aucune route d’administration : les jetons d’invitation et de session n’autorisent ni les projets ni les commandes du contrôleur. L’adresse publique exige un proxy HTTPS et la transmission WebSocket de `/api/guest/events`. Le proxy doit conserver le nom d’hôte public et les informations de client distant ; il ne doit pas présenter ses clients comme des requêtes locales autorisées à ouvrir les sources OBS ou la liaison PC.

Variables lues au démarrage :

| Variable | Valeur / fonction |
| --- | --- |
| `NINO_GUEST_PUBLIC_URL` | Origine HTTPS publique, sans chemin, paramètres, identifiants ou fragment. Sans valeur : `http://127.0.0.1:4312`. |
| `NINO_GUEST_HOST` | Écoute de la passerelle ; `127.0.0.1` par défaut. Conserver la boucle locale derrière le proxy sur ce PC. |
| `NINO_GUEST_PORT` | Port local de passerelle, `4312` par défaut. |
| `NINO_GUEST_STUN_URLS` | Adresses `stun:`, séparées par des virgules. |
| `NINO_GUEST_TURN_URLS` | Adresses `turn:` / `turns:`, séparées par des virgules. |
| `NINO_GUEST_TURN_SECRET` | Secret partagé avec un relais compatible TURN REST ; au moins 16 caractères, stocké uniquement dans la configuration privée. |
| `NINO_GUEST_TRUST_LOCAL_PROXY` | `1` uniquement derrière le tunnel en boucle locale et un proxy de confiance qui écrase `X-Nino-Client-IP`. Permet des quotas distincts par invité ; désactivé par défaut. |

Exemple de forme pour un fichier local `studio/.env.local` — les hôtes et le secret sont fictifs et doivent être remplacés :

```dotenv
NINO_GUEST_HOST=127.0.0.1
NINO_GUEST_PORT=4312
NINO_GUEST_PUBLIC_URL=https://invites.nino.example
NINO_GUEST_STUN_URLS=stun:turn.nino.example:3478
NINO_GUEST_TURN_URLS=turn:turn.nino.example:3478?transport=udp,turns:turn.nino.example:5349?transport=tcp
NINO_GUEST_TURN_SECRET=REMPLACER_PAR_UN_SECRET_LONG_ALEATOIRE
```

Le secret TURN sert à générer des identifiants temporaires liés aux sessions. Il n’est pas envoyé tel quel au navigateur. Le relais doit utiliser le même secret et la méthode TURN REST : avec coturn, les options concernées sont `use-auth-secret` et `static-auth-secret`. Configurer également ses certificats, plages de ports et quotas selon l’installation ; voir la [documentation officielle coturn](https://github.com/coturn/coturn/blob/master/README.turnserver). Aucun relais public ni compte d’hébergement n’est créé automatiquement par Nino.

Pour le tunnel inversé en boucle locale, le proxy doit écraser `X-Nino-Client-IP` avec l’adresse réelle de sa connexion cliente, par exemple `header_up X-Nino-Client-IP {remote_host}` dans le bloc `reverse_proxy` Caddy. Activer alors `NINO_GUEST_TRUST_LOCAL_PROXY=1`. Nino vérifie le pair local et l’hôte HTTPS public avant de l’utiliser pour les quotas. Ce champ ne donne jamais de droit opérateur ou de source OBS ; les vérifications locales de ces rôles restent indépendantes. Ne pas activer ce réglage avec un proxy qui conserve un en-tête client fourni par Internet.

`npm start` ne charge pas automatiquement `.env.local`. Sur ce Mac, conserver le fichier hors Git, limiter ses droits de lecture et charger ses valeurs avec Node lors du démarrage géré par Portly. Depuis `studio/`, après vérification du serveur existant :

```sh
portly status
chmod 600 .env.local
portly update-server GabinHEdS/studio --command 'node --env-file=.env.local --import tsx apps/api/src/index.ts'
portly restart GabinHEdS/studio
```

Le chemin du serveur Portly doit être `studio/`. Garder dans ce fichier les autres variables nécessaires à l’installation avant de remplacer une commande qui les définissait auparavant. Le chargement `--env-file` est documenté dans [la référence Node](https://nodejs.org/api/cli.html#--env-filefile). Cette opération de maintenance doit se faire hors prise et hors live ; le redémarrage termine les sessions invitées.

## Accès et durées

- Lien personnel : 24 heures maximum, une seule utilisation pour rejoindre. Une nouvelle invitation révoque le précédent accès de cette place.
- Session de conversation ou de source : 6 heures maximum, révocable et liée à la production et à l’appareil qui l’a créée. Une reprise dans le même onglet ne transforme pas l’invité en opérateur.
- Ticket de source OBS : 5 minutes, une seule utilisation. Nino le crée lors de la préparation et l’échange contre une session réservée à la source locale.
- Les secrets d’invitation et de source sont dans le fragment du lien, puis transmis dans le corps POST. Le secret de session authentifie le WebSocket par son premier message ; aucun jeton opérateur n’est mis dans un lien d’invitation.

Les invitations, sessions et permissions ne redémarrent jamais un appel automatiquement après redémarrage de Nino. Les champs de disponibilité reviennent à un état déconnecté ; préparer les sources, créer de nouveaux accès si nécessaire et réadmettre explicitement les personnes.

## Recette et dépannage

Tester d’abord avec des liens locaux et des appareils synthétiques ou de test, puis effectuer une recette depuis un autre réseau sur l’adresse HTTPS réelle. Un essai localhost ne valide pas le NAT, le pare-feu, les certificats, le relais TURN ou les casques de la salle.

| Vérification | Résultat attendu |
| --- | --- |
| Ouvrir l’adresse publique sans invitation | Page invitée ; aucun écran d’administration. |
| Entrer avec chaque lien personnel | Deux places distinctes, aperçu puis salle d’attente. |
| Admettre A puis B | Conversation autorisée ; attente OBS puis sources réellement prêtes. |
| Parler dans la salle | A et B entendent la salle. |
| A parle | B et le programme entendent A ; A ne reçoit pas sa propre voix par le retour. |
| B parle | A et le programme entendent B ; B ne reçoit pas sa propre voix par le retour. |
| Couper A depuis l’iPad, puis depuis Stream Deck | Son A coupé dans OBS et pour B ; statut cohérent sur les appareils. |
| Afficher B | Le plan B est confirmé dans OBS et dans le programme. |
| Retirer A / fermer la liaison | Accès coupé ; aucune image figée ni micro caché de la fenêtre de liaison. |
| Enregistrer une courte conversation | Fichier complet relu, voix et plans présents ; dossier / Resolve récupérables après arrêt. |

Si la connexion est ouverte mais **Prêt** ne s’affiche pas, vérifier les permissions caméra/micro, la liaison PC, les sources OBS et le réseau TURN. Un lien `127.0.0.1` envoyé à distance vise l’ordinateur de l’invité et ne peut pas rejoindre la salle.

Si le son revient avec un écho, vérifier en priorité que l’entrée audio de salle exclut les voix distantes et que les écoutes utilisent des casques. Ne pas activer en plus le son HLS sur les haut-parleurs pendant l’appel.

Si la vidéo s’arrête, vérifier la fenêtre de liaison, la veille du PC, la caméra virtuelle OBS et la connexion de l’invité. Maintenir le PC éveillé ; une fenêtre fermée ou suspendue coupe la liaison des invités, même si OBS continue une prise ou un live. Après une panne, attendre la réception des médias et réadmettre explicitement avant de sélectionner le plan.
