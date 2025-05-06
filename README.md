# Gabin Desktop App

Application de gestion d'enregistrements audio/vidéo multi-modalités (podcast, interview, PowerPoint sonorisé, etc.)

## Fonctionnalités principales

- **Sélection du type de projet** : Choisissez la modalité (podcast, interview, etc.) pour adapter le parcours utilisateur.
- **Sélection des intervenants** : Choisissez le nombre d'intervenants (1 à 4) avec illustration visuelle personnalisée.
- **Positionnement** : Visualisez le schéma de placement des intervenants dans la salle, avec image dynamique selon le nombre sélectionné.
- **Configuration micro/caméra** : Vérifiez et ajustez les périphériques avant l'enregistrement.
- **Enregistrement & Contrôle du direct** : Lancez, suivez et contrôlez la session en temps réel.
- **Tableau de bord** : Accédez à la synthèse des projets et enregistrements précédents.

## Structure du projet

```
/desktop-app
├── public/
│   └── img/           # Images pour les intervenants, schémas de positionnement, etc.
├── src/
│   ├── assets/        # Styles, images additionnelles
│   ├── components/    # Composants Vue réutilisables (ParticipantCard, MicrophoneCard, etc.)
│   ├── views/         # Vues principales (ModalitySelectView, ParticipantSelectView, ...)
│   ├── router/        # Configuration des routes (index.js)
│   ├── App.vue        # Racine de l'application
│   └── main.js        # Point d'entrée
└── package.json       # Dépendances et scripts
```

## Installation & Lancement

### Prérequis
- Node.js >= 16
- npm >= 8

### Installation
```bash
npm install
```

### Lancer l'application en développement
```bash
npm run dev
```

### Générer la version de production
```bash
npm run build
```

### Lancer la version production localement
```bash
npm run preview
```

## Personnalisation des images
- Placez vos images de positionnement (ex : `1intervenantsPosition.png`, `2intervenantsPosition.png`, etc.) dans `public/img/`.
- Les images des cards intervenant sont aussi à placer dans ce dossier (`1intervenantsImg.png`, ...).

## Navigation & UX
- Chaque vue comporte un titre explicite et un sous-titre pour guider l'utilisateur.
- Navigation clavier possible sur certaines étapes (ex : touche "Entrée" pour continuer, "R" pour retour sur la vue de positionnement).
- Les étapes s'adaptent selon la modalité choisie (podcast, interview, etc.).

## Technologies utilisées
- [Vue 3](https://vuejs.org/) (Composition API)
- [Vue Router](https://router.vuejs.org/)
- [PrimeVue](https://www.primevue.org/) (UI components)
- CSS custom/scoped

## Bonnes pratiques
- Structure de code claire (components/views)
- Styles cohérents et adaptatifs
- UX pensée pour la simplicité et l'efficacité

## Origine du code

Une partie du code de cette application a été forkée depuis le projet Gabin de Micode.
Merci à Micode et à la communauté Gabin pour leur travail et leur inspiration.

## Contribution
1. Forkez le repo / clonez localement
2. Créez une branche (`feature/ma-nouvelle-fonctionnalite`)
3. Commitez vos changements
4. Ouvrez une Pull Request

## Support
Pour toute question ou bug, ouvrez une issue sur le repo ou contactez l'équipe technique.

---

© Gabin, 2025. Tous droits réservés.
