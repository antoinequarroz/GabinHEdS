# Stream Deck MK.2 — Nino

Ces cinq pages utilisent le style sombre Nino et les états réels du studio. Elles ont été exportées avec **Companion 5.1**, au format de pages 12. Les pictogrammes sont intégrés aux fichiers ; aucun dossier privé, police locale ou image supplémentaire n’est nécessaire.

Les exports ne contiennent ni jeton Nino, ni clé de diffusion, ni enregistrement, ni configuration de surface USB. Toutes les commandes de production passent par l’API authentifiée de Nino. Le pont intégré à Nino alimente les variables publiques `nino_state_*` : aucun GET de rafraîchissement supplémentaire n’est à programmer dans Companion.

## Installation

1. Installer et ouvrir Nino, OBS et Companion sur le même ordinateur. Le pont utilise par défaut `ws://127.0.0.1:8000/trpc` ; `NINO_COMPANION_URL` permet de choisir un autre port local. Il ne se connecte pas à un Companion distant.
2. Importer chaque fichier `.companionconfig` dans une page existante ou nouvelle. Les numéros suggérés sont : **2 Régie, 3 Audio, 4 Médias, 5 Invités, 6 Menu**. Ne pas remplacer une page personnelle sans en conserver une copie.
3. Lors des imports, réutiliser **la même connexion Generic HTTP Requests** pour les cinq pages. Sa Base URL doit être `http://127.0.0.1:4310`, ou le port local sur lequel Nino écoute. Ne pas créer cinq connexions indépendantes.
4. Dans Nino → Appareils, créer un accès opérateur Stream Deck. Dans Companion → Variables personnalisées, créer `nino_token` et y saisir ce jeton directement. Il reste dans cette installation ; ne pas l’ajouter aux fichiers versionnés ou à un export partagé.
5. Créer les cinq variables décrites dans `variables-navigation.json`, avec les valeurs correspondant aux **vrais numéros des pages importées**, puis activer leur persistance. Ce JSON est une référence à recopier, pas un fichier de configuration Companion à importer.
6. Dans Companion, affecter la page Menu à la surface Stream Deck USB. Tester Régie → Menu, puis Audio → Menu.
7. Dans la production Nino, cliquer **Utiliser cette production sur le Stream Deck** et attendre la confirmation de synchronisation. Les autres affectations publiques sont créées et synchronisées par Nino.

Les actions de navigation utilisent des variables de numéros de pages. **Companion ne peut pas remapper automatiquement ces numéros dans une expression lors d’un import.** Si les pages ne sont pas en positions 2 à 6, adapter les cinq variables. La page 1 et les autres pages de Companion peuvent être conservées.

## Utilisation

Le Menu ouvre Régie, Audio, Médias et Invités. La dernière touche en haut est **Tout lancer** : vérification de la salle, retour local, enregistrement confirmé par OBS, intro éventuelle, retour au plan et réalisation automatique si la configuration est prête. **Le live reste séparé** ; cette touche envoie explicitement `includeLive: false`. Arrêter prise et Arrêter live restent deux commandes distinctes.

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

Les pages et ce guide sont écrits dans `studio/build/stream-deck/`, sans contacter OBS, Nino, Companion ou un service extérieur. `--output DOSSIER` permet une autre destination. Le générateur utilise ces cinq modèles complets, qui contiennent les pictogrammes, et le code lisible de `scripts/companion-profile.mjs` pour réappliquer les gardes et les états. Les identifiants internes des calques peuvent être renouvelés ; les actions et expressions restent équivalentes.

Les tests `tests/companion-profile.test.ts` vérifient les gardes et les états. `tests/streamdeck-export.test.ts` contrôle les vrais exports, leur navigation, l’authentification par variable et une régénération dans un dossier temporaire. Aucun de ces tests n’appuie sur une touche réelle.
