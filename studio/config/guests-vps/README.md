# Passerelle invités sur un VPS

Ces modèles publient uniquement l’entrée des invités. Le contrôleur Nino, OBS,
les vidéos, les données de production et les clés des appareils restent sur le PC.
Les valeurs d’exemple doivent être remplacées avant installation.

```text
Navigateur invité -- HTTPS/WSS --> Caddy du VPS
                                  |
                                  +-- relais privé Docker --> SSH inversé --> PC :4312

Audio/vidéo WebRTC -- connexion directe ou TURN du VPS --> liaison sur le PC
```

## Préparation

1. Vérifier les sites existants, les ports, le pare-feu et le disque. Conserver
   leurs conteneurs et identités. Choisir un nom HTTPS dédié ; un nom temporaire
   fondé sur l’IP peut servir à la recette avant de connecter le domaine final.
2. Copier ces modèles dans un dossier privé du VPS, mode `700`. Générer un secret
   aléatoire long dans un fichier privé `600`. Ne jamais le coller dans un chat,
   une commande ou un dépôt. Le transmettre au PC par SSH ; le même secret doit
   alimenter `static-auth-secret` et `NINO_GUEST_TURN_SECRET`.
3. Identifier le réseau du conteneur Caddy. Son `localhost` est distinct de celui
   du VPS : le relais écoute uniquement sur sa passerelle Docker, par exemple
   `172.18.0.1:18413`, puis rejoint `127.0.0.1:18412` sur l’hôte.
4. Sauvegarder et calculer le hash du Caddyfile existant. Ajouter un seul bloc
   inspiré de `Caddyfile.example`. Valider le candidat dans le conteneur existant,
   puis appliquer un rechargement Caddy. Une erreur doit restaurer la sauvegarde.
   Conserver l’inode du fichier si Docker le monte comme fichier unique.
5. Renseigner `CADDY_DOCKER_GATEWAY` et `GUEST_CERTIFICATE_DIRECTORY` dans le fichier
   privé `.env` utilisé par Compose. Monter seulement le répertoire du certificat
   de cette entrée invités. `turnserver.conf` doit être lisible par l’utilisateur
   `0:0` du conteneur, avec mode `600`, et rester absent du dépôt.

Les images sont fixées par version et empreinte. Le modèle TURN conserve
uniquement la capacité `NET_BIND_SERVICE`, requise par le binaire officiel,
et n’utilise pas de conteneur privilégié.

TURN autorise 16 allocations par identité temporaire et 32 au total. Les limites
de bande passante sont exprimées en **octets par seconde** : `max-bps=1000000`
(environ 8 Mbit/s par allocation) et `bps-capacity=32000000`. La capacité doit
couvrir les réservations des 32 allocations, y compris les candidats ICE encore
inutilisés ; une capacité de 8 millions refuserait des candidats nécessaires aux
deux invités. Cela ne mesure pas le trafic consommé : les deux appels utilisent
seulement leurs paires ICE effectivement sélectionnées.

## Pare-feu et tunnel

Ajouter uniquement les accès nécessaires, sans changer SSH ni les sites existants :

- TCP `18413` : seulement le sous-réseau Docker vers son adresse de passerelle.
- TCP/UDP `3478`, UDP `49160-49200` : vers l’adresse IPv4 publique du service TURN.
- TCP `5349` : vers cette même adresse pour TURN TLS.

L’IPv6 nécessite une configuration TURN séparément validée ; ne pas ouvrir ses
ports automatiquement si le service écoute seulement en IPv4. Les plages
privées, de loopback, de multicast et de métadonnées sont interdites comme pairs
TURN. Le relais TCP de TURN est désactivé ; le transport client TCP reste actif.

Sur le Mac, enregistrer un serveur dédié dans Portly avec la commande suivante,
en remplaçant l’alias SSH. Ne pas désactiver la vérification de la clé du VPS.

```sh
ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:18412:127.0.0.1:4312 vps-alias
```

Ce tunnel ne doit jamais pointer vers le contrôleur `4310` ou OBS `4455`.
Conserver `GatewayPorts no` sur le VPS. La liaison et le tunnel doivent rester
ouverts pendant la production.

## Configuration privée du PC

Créer un fichier ignoré `studio/.env.guests`, mode `600`, avant de démarrer Nino :

```text
GABIN_HOST=0.0.0.0
GABIN_PORT=4310
NINO_GUEST_HOST=127.0.0.1
NINO_GUEST_PORT=4312
NINO_GUEST_PUBLIC_URL=https://guest.example.com
NINO_GUEST_STUN_URLS=stun:guest.example.com:3478
NINO_GUEST_TURN_URLS=turn:guest.example.com:3478?transport=udp,turn:guest.example.com:3478?transport=tcp,turns:guest.example.com:5349?transport=tcp
NINO_GUEST_TRUST_LOCAL_PROXY=1
NINO_GUEST_TURN_SECRET=REPLACE_PRIVATELY
```

Le serveur doit lire ce fichier, par exemple avec Node 24 et `--env-file`, avant
de charger l’API. Le secret n’apparaît jamais dans la commande Portly. La confiance
proxy est limitée au peer loopback, au Host public exact et à l’en-tête réécrit
par ce seul bloc Caddy ; elle ne confère aucun rôle de contrôle aux invités.

## Recette et entretien

- Vérifier DNS, certificat public et `GET /api/guest/config` avec une réponse
  `mode: guest`. `GET /api/state` et `POST /api/auth/local` doivent répondre `404`.
- Tant que le PC ou le tunnel est fermé, une réponse `502` du proxy est attendue.
- Vérifier une allocation TURN authentifiée depuis un navigateur extérieur,
  séparément en UDP, TCP et TLS. Une simple ouverture du port ne prouve pas TURN.
- Tester deux invités avec casques sur deux réseaux extérieurs, leurs retours
  sans voix propre, les commandes, l’enregistrement final et la révocation.
- Caddy renouvelle automatiquement son certificat. Après son renouvellement,
  recharger ou redémarrer uniquement le conteneur TURN hors production pour
  prendre en compte les nouvelles clés. Le montage est en lecture seule.
- La présence de TURN TLS sur `5349` ne garantit pas le passage des réseaux
  autorisant exclusivement `443` ; ce cas doit être testé avec le réseau final.
- Pour revenir en arrière, supprimer uniquement le bloc Caddy marqué Nino,
  valider/recharger, arrêter les deux conteneurs Nino et retirer leurs seules
  règles de pare-feu. Révoquer le secret partagé sur le PC et le VPS.

Références : [HTTPS Caddy](https://caddyserver.com/docs/automatic-https),
[proxy WebSocket](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[image officielle coturn](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md),
[configuration coturn](https://github.com/coturn/coturn/blob/master/README.turnserver).
