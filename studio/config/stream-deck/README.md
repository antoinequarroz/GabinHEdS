# Stream Deck MK.2 — Nino

Ces six pages utilisent le style sombre Nino et les états réels du studio. Elles ciblent **Companion 5.1**, au format de pages 12. Les pictogrammes et le logo sont intégrés aux fichiers ; aucun dossier privé ou police locale n’est nécessaire. Le logo `nino-logo.png` provient du SVG de marque `apps/web/public/brand/nino-mark.svg`.

Les exports ne contiennent ni jeton Nino, ni clé de diffusion, ni enregistrement, ni configuration de surface USB. Toutes les commandes de production passent par l’API authentifiée de Nino. Le pont intégré à Nino alimente les variables publiques `nino_state_*` : aucun GET de rafraîchissement supplémentaire n’est à programmer dans Companion.

## Installation

1. Installer Nino, OBS et Companion sur le même ordinateur. Pour la configuration initiale, ouvrir le raccourci Windows **Nino + OBS**. Le pont utilise par défaut `ws://127.0.0.1:8000/trpc` ; `NINO_COMPANION_URL` permet de choisir un autre port local. Il ne se connecte pas à un Companion distant.
2. Importer chaque fichier `.companionconfig` dans une page existante ou nouvelle. Les numéros suggérés sont : **2 Régie, 3 Audio, 4 Médias, 5 Invités, 6 Menu, 7 Accueil**. Ne pas remplacer une page personnelle sans en conserver une copie.
3. Lors des imports, réutiliser **la même connexion Generic HTTP Requests** pour les six pages. Sa Base URL doit être `http://127.0.0.1:4310`, ou le port local sur lequel Nino écoute. Ne pas créer six connexions indépendantes.
4. Dans Nino → Appareils, créer un accès opérateur Stream Deck. Dans Companion → Variables personnalisées, créer `nino_token`, y saisir ce jeton directement et activer sa persistance pour conserver l’association après un redémarrage. Il reste dans cette installation ; ne pas l’ajouter aux fichiers versionnés ou à un export partagé.
5. Créer les six variables décrites dans `variables-navigation.json`, avec les valeurs correspondant aux **vrais numéros des pages importées**, puis activer leur persistance. Ce JSON est une référence à recopier, pas un fichier de configuration Companion à importer.
6. Dans les réglages de la surface Stream Deck USB de Companion, choisir **Accueil** comme page au démarrage et désactiver la réutilisation de la dernière page. Tester Accueil → Menu → Accueil, puis Régie → Menu. Les pages personnelles restent disponibles.
7. Dans la production Nino, cliquer **Utiliser cette production sur le Stream Deck** et attendre la confirmation de synchronisation. Les autres affectations publiques sont créées et synchronisées par Nino.

Les actions de navigation utilisent des variables de numéros de pages. **Companion ne peut pas remapper automatiquement ces numéros dans une expression lors d’un import.** Si les pages ne sont pas en positions 2 à 7, adapter les six variables. Les nouveaux accès Accueil/Menu/Régie possèdent une valeur par défaut pour fonctionner avant la création des variables, lorsque les numéros proposés sont utilisés. La page 1 et les autres pages de Companion peuvent être conservées.

## Accueil et ouverture du studio sur Windows

Lorsque le démarrage automatique de la salle est configuré, l’ouverture de session Windows prépare Nino et MediaMTX en arrière-plan, puis Companion. Ce démarrage ne lance ni OBS, ni navigateur, ni enregistrement, ni live. Companion 5.1 démarre son serveur lorsque son application s’ouvre ; vérifier une première fois son accès local sur le port 8000.

L’Accueil affiche le logo Nino même avant la première synchronisation. **Ouvrir le studio** demande au lanceur Windows de montrer Nino et OBS. Cette touche ne démarre aucune prise, intro ou diffusion et ne nécessite aucune production sélectionnée. Les indicateurs Nino et OBS suivent uniquement les confirmations reçues ; une réponse HTTP ne suffit pas à annoncer qu’OBS est connecté.

La touche utilise l’accès opérateur du Stream Deck et Nino en arrière-plan. Elle s’active uniquement si cette installation annonce sa capacité d’ouverture Windows. **VERSION NINO REQUISE** indique une ancienne version ou une installation sans lanceur Windows compatible ; la touche reste désarmée. **LIER LE DECK** invite à terminer l’étape d’association initiale. **NINO HORS LIGNE** signifie que le service ne répond plus : ouvrir alors manuellement le raccourci Windows **Nino + OBS**. La page d’accueil et sa navigation restent visibles lorsque Nino est éteint.

## Utilisation

Le Menu ouvre Régie, Audio, Médias et Invités ; sa touche Accueil retrouve le logo et l’ouverture logicielle. La dernière touche en haut est **Tout lancer** : vérification de la salle, retour local, enregistrement confirmé par OBS, intro éventuelle, retour au plan et réalisation automatique si la configuration est prête. **Le live reste séparé** ; cette touche envoie explicitement `includeLive: false`. Arrêter prise et Arrêter live restent deux commandes distinctes.

Un bandeau de grande taille montre l’état observé. Le contour et le voyant indiquent le plan à l’image, REC, le micro ou la fonction active. La pause confirmée utilise l’ambre. Les cinq touches de la rangée d’enregistrement n’ont pas toutes un voyant REC actif.

- **NINO HORS LIGNE** : les nouvelles de Nino ont plus de quatre secondes ; les commandes sont désarmées.
- **OBS DÉCONNECTÉ** : OBS ne confirme pas son état ; aucun ancien état REC n’est présenté comme actuel.
- **AUTRE PRODUCTION** : une autre production utilise une prise, un lancement ou un live, ou OBS enregistre hors d’une prise connue. Revenir dans Nino pour contrôler la production concernée.
- **À CONFIGURER** : une scène, un micro, un média ou une place invitée manque. Une affectation média ambiguë reste désarmée.

Le live affiché suit `media.liveStatus`, le relais public, et non `obs.streaming`, le transport local du programme. « Companion synchronisé » confirme la liaison logicielle ; vérifier également le Stream Deck branché en USB.

## Régénérer les fichiers hors ligne

Depuis `studio/` :

```sh
node scripts/build-streamdeck.mjs
```

Les pages, le logo et ce guide sont écrits dans `studio/build/stream-deck/`, sans contacter OBS, Nino, Companion ou un service extérieur. `--output DOSSIER` permet une autre destination. Le générateur utilise ces six modèles complets et le code lisible de `scripts/companion-profile.mjs` pour réappliquer les gardes et les états. Les identifiants internes des calques peuvent être renouvelés ; les actions et expressions restent équivalentes.

Les tests `tests/companion-profile.test.ts` vérifient les gardes et les états. `tests/streamdeck-export.test.ts` contrôle les vrais exports, leur navigation, l’authentification par variable et une régénération dans un dossier temporaire. Aucun de ces tests n’appuie sur une touche réelle.
