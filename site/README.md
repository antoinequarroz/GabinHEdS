# Page vitrine nino-studio.postmelo.ch

Une page statique (HTML, CSS, un peu de JavaScript, sans construction) qui présente Nino, les logiciels de captation compatibles et le lien de téléchargement de l'installateur Windows. Elle suit le design de la suite PostMelo (papier chaud, Geist, Instrument Serif, clair et sombre) avec l'accent pétrole de Nino.

- `index.html`, `styles.css` : la page. Les jetons de couleur sont ceux de `studio/apps/web/src/styles.css`.
- `site.js` : bouton d'apparence (Auto, Clair, Sombre) et lien direct vers le dernier installateur, lu dans l'API publique des versions GitHub. Sans version publiée, ou si GitHub ne répond pas, le bouton mène à la page des versions.
- `theme-init.js` : applique l'apparence choisie avant l'affichage, sans script en ligne (la CSP n'autorise que `'self'`).
- `images/` : captures de la régie (clair et sombre). `fonts/`, `brand/` : copies de `studio/apps/web/public`.
- `deploy/` : conteneur nginx et bloc Caddy pour le VPS.

Aperçu local : `python3 -m http.server -d site 8080`, puis http://127.0.0.1:8080.

## Mettre la page en ligne sur le VPS

Même méthode que les autres sites de la suite (Alfred, Compte PostMelo) : un conteneur sur le VPS, joint par le Caddy déjà en place qui gère le HTTPS.

### 1. DNS

Chez le registraire de `postmelo.ch`, créer un enregistrement **A** `nino-studio` vers l'IP du VPS (la même que `compte`, `alfred`, `lamio`…). Vérifier : `dig +short nino-studio.postmelo.ch`.

### 2. Démarrer le conteneur

```bash
git clone https://github.com/antoinequarroz/nino-studio.git /opt/nino-studio
cd /opt/nino-studio/site/deploy
docker compose up -d
```

Le conteneur `nino-site` (nginx, 32 Mo de RAM au plus, en lecture seule) ne publie aucun port : il rejoint le réseau Docker de Caddy (`antoinequarroz-vitrine_appnet` par défaut, modifiable avec `CADDY_NETWORK`).

### 3. Brancher Caddy

Garder une copie du Caddyfile (`~/.config/antoinequarroz-vitrine/runtime/Caddyfile`), y ajouter le contenu de [`deploy/Caddyfile.snippet`](deploy/Caddyfile.snippet), puis :

```bash
docker exec antoinequarroz-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec antoinequarroz-caddy caddy reload --config /etc/caddy/Caddyfile
```

Ouvrir https://nino-studio.postmelo.ch. Caddy obtient le certificat tout seul à la première visite, une fois le DNS propagé.

### 4. Publier l'installateur

Le bouton de téléchargement pointe vers la dernière version GitHub. Pour la créer, voir « Obtenir le Setup » dans [`studio/docs/windows-installer.md`](../studio/docs/windows-installer.md) : pousser l'étiquette `v0.1.0` suffit.

### Au quotidien

| Besoin | Commande |
|---|---|
| Mettre à jour la page | `cd /opt/nino-studio && git pull` (rien à redémarrer) |
| Voir les journaux | `docker logs nino-site --tail 50` |
| Arrêter | `cd /opt/nino-studio/site/deploy && docker compose down` |
