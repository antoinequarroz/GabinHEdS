# Guides Nino

Quatre guides français illustrés, avec la marque Nino et la police Manrope de l'interface :

- [Installation](nino-installation.pdf) : prérequis, services, OBS, scènes/micros, réseau, iPad, Stream Deck et sauvegardes.
- [Recette de la salle](nino-guide-tests.pdf) : manipulations, résultats attendus, appareils réels, live privé, récupération et validation à compléter.
- [Guide utilisateur](nino-guide-utilisateur.pdf) : parcours simple complet et tutoriels podcast, table ronde, présentations, live, commandes automatiques et DaVinci Resolve.
- [Le manuel complet pour débuter](nino-manuel-complet.pdf) : mode d'emploi de toutes les fonctions disponibles, avec sommaire cliquable, exemples, recettes par format, appareils, invités, live, montage et dépannage. Le parcours MP4 explique le téléchargement d'une prise, la copie sur clé USB sous Windows ou macOS, puis l'import du fichier dans DaVinci sur un autre ordinateur.

Les copies distribuables vivent dans ce dossier. Une génération pour livraison locale peut viser `output/pdf/`, sans ajouter ce dossier de sortie au dépôt.

Compatibilité des intitulés : la version actuellement publiée sur `main` affiche encore « PowerPoint sonorisé ». Le manuel complet nomme ce même format « Présentation et partage d’écran », l’intitulé utilisé dans la version locale de la salle. Les présentations et les autres contenus partagés se capturent dans OBS dans les deux cas.

## Régénération

Le contenu des trois premiers guides est dans `content.py`. La mise en page ReportLab est dans `../../scripts/generate-guides.py`. Le générateur utilise le TTF Manrope et le SVG Nino existants de l'interface. Il crée des instances de police statiques dans le dossier QA, conserve les accents et intègre des signets de navigation au PDF.

Prérequis Python : `reportlab`, `pypdf`, `Pillow`, `fonttools`, `svglib`. Prérequis de rendu : Poppler (`pdftoppm`). Dans Codex, utiliser le Python et Poppler du runtime d'artefacts ; ne pas mélanger avec une installation système. Les versions auxiliaires utilisées pour cette génération sont `fonttools==4.66.1` et `svglib==2.3.0`.

Depuis `studio/`, sur le Mac, avec le Python et `pdftoppm` appropriés :

```sh
portly status
job_id="$(portly temp 'python3 scripts/generate-guides.py --output ../output/pdf --render' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
```

Le manuel complet possède trois sources pédagogiques : `manuel-decouverte-content.py`, `manuel-production-content.py` et `manuel-options-content.py`. Son générateur compose le sommaire et ses liens à partir des pages présentes, avec le même logo, Manrope et les illustrations de démonstration. Il importe le moteur partagé sans reconstruire les autres PDF. `generate-recette-web.py` et `recette-web-content.py` sont inclus comme dépendances de ce moteur ; aucun autre PDF n’est nécessaire pour reconstruire le manuel.

Les images `assets/takes-overview-mp4.png` et `assets/takes-mp4.png` sont des recadrages de captures réelles des parcours navigateur isolés, avec noms et médias synthétiques. La seconde, capturée à densité double, montre les deux boutons de récupération en détail. Les schémas de transfert sont vectoriels ; les pages Windows, Mac, import Resolve et dépannage USB incluent un lien d'aide officiel ou du fabricant.

```sh
job_id="$(portly temp 'python3 docs/guides/generate-manuel-debutant.py --output ../output/pdf/nino-manuel-complet.pdf --render' --path "$PWD" --timeout 30m)"
portly wait "$job_id"
```

Le flag `--render-bin /chemin/vers/pdftoppm` choisit explicitement le renderer. `--qa-dir /chemin/QA` place ailleurs les instances de police, pages PNG et le rapport de construction. `--draft` permet un diagnostic de débordement ; une livraison doit être reconstruite sans ce flag. La construction normale refuse tout contenu dépassant la marge basse, toute page suspectement vide ou tout caractère de remplacement.

Avant la première création ou modification d’une nouvelle opération dans Codex, suivre aussi le contrat d'artefacts du skill PDF, avec le type d’opération et le nombre de PDF attendus. Une reconstruction dans la même opération ne répète pas son marqueur.

## Vérification visuelle et captures

Rendre puis inspecter toutes les pages, à la taille permettant de lire le corps de texte. Contrôler titres, schémas, bordures, tableaux, commandes, numérotation et légendes. Les captures dans `assets/` proviennent uniquement de tests isolés avec mire et données de démonstration ; elles ne sont pas des captures personnelles de la salle. Elles n'incluent ni caméra d'utilisateur, ni mot de passe, ni clé live, ni jeton d'appareil. La capture Resolve représente l'import réel de la fixture de test.

Après inspection, copier les PDF reconstruits dans ce dossier pour la publication. Ne pas versionner les rendus PNG de QA, les instances de police temporaires ni les fichiers de production.

## Limites décrites

- La réalisation automatique choisit des scènes à partir des niveaux de micros OBS distincts, localement. Elle ne nécessite pas de clé d'IA, ne transcrit pas les voix et ne supprime pas les silences.
- Le micro partagé du Mac ne permet pas de sélectionner une caméra par personne. Les micros doivent rester présents dans les scènes utilisées pour la réalisation automatique. Un micro associé coupé, absent ou sans mesure récente met l'ensemble de la réalisation automatique en attente.
- Une production est limitée à quatre participants en salle et deux invités depuis un navigateur. Les chapitres ajoutés à la fin des guides couvrent l’appel, les retours sans voix propre et les tests. L’accès extérieur HTTPS et TURN doit être installé et testé séparément.
- Le format Présentation et partage d’écran couvre diaporama, navigateur, démonstration de logiciel, document et entrée HDMI. La fenêtre ou l’écran se capture dans OBS ; les commandes du contenu restent dans son application. Les PDF/PPTX de bibliothèque restent de vrais documents conservés dans les exports, sans conversion automatique en vidéo. Les noms de scènes OBS existants sont préservés.
- Live et enregistrement ont des démarrages et des arrêts distincts. Les tests de navigateur/CI ne remplacent pas la recette iPad, Stream Deck et plateforme réels.
- L'export Resolve fournit une timeline OTIO par prise et sa vidéo de programme compatible ; il ne fabrique pas des caméras ISO absentes. L'import réel a été validé sur DaVinci Resolve Studio 21.1.
- La recette Windows et son démarrage définitif doivent être confirmés sur le PC de la salle.
