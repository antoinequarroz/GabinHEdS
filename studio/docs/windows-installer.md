# Installer Nino sur le PC Windows 11

Le Setup Windows x64 installe Nino pour le compte qui l’exécute et crée un raccourci **Nino + OBS**. Il embarque Node.js et MediaMTX : aucune commande npm ni installation globale de Node n’est nécessaire sur ce PC.

La première préparation demande Internet pour récupérer FFmpeg et ffprobe directement chez leur fournisseur. Les versions et SHA-256 sont verrouillés dans `windows/runtime-lock.json` et vérifiés avant extraction ou exécution. Le paquet FFmpeg complet conserve ses notices et licences. Les lancements suivants réutilisent cette installation locale. Le direct et les invités demandent toujours leur propre connexion réseau.

## Obtenir le Setup

Dans GitHub Actions, ouvrir **Nino Windows Installer**, choisir une exécution verte correspondant au code souhaité et télécharger l’artefact `nino-windows-<commit>-<tentative>`. Il contient :

- `Nino-Setup-0.1.0-<commit-court>-windows-x64.exe` ;
- son fichier `.sha256` ;
- `windows-smoke.json`, le rapport des vérifications automatiques de l’installateur.

Extraire l’artefact avant de lancer le fichier `.exe`. Le SHA-256 peut être comparé avec `Get-FileHash -Algorithm SHA256` dans PowerShell. Le numéro et le commit du nom identifient la construction ; l’installateur ne récupère pas automatiquement un autre code depuis GitHub.

Cette première version n’a pas encore de signature de code éditeur. Les contrôles automatiques sur Windows ne remplacent pas la recette matérielle sur le PC Windows 11 de la salle.

## Première installation

1. Ouvrir le Setup avec le compte Windows habituel de la salle. Nino s’installe dans `%LOCALAPPDATA%\Programs\Nino` et propose le raccourci de Bureau.
2. Laisser terminer la préparation vidéo visible. Elle télécharge FFmpeg, vérifie son empreinte, extrait les outils et contrôle les encodeurs H.264/AAC. Si cette étape échoue, le message précise que la préparation est incomplète ; le prochain lancement du raccourci la réessaiera.
3. Si OBS n’est pas installé, cocher **Installer OBS si nécessaire** en fin d’installation. Son installateur officiel est téléchargé et vérifié, puis ouvert pour suivre ses étapes habituelles. Windows peut demander une autorisation administrateur pour OBS. Un OBS déjà installé est conservé.
4. Lancer **Nino + OBS**. Le raccourci démarre les composants locaux, vérifie leurs réponses réelles, ouvre OBS s’il n’est pas déjà ouvert et affiche Nino dans le navigateur. Un second clic réutilise les mêmes composants au lieu de créer une deuxième salle.
5. Installer séparément le pilote officiel RØDECaster Virtual Devices et redémarrer Windows si nécessaire. Relancer ensuite **Nino + OBS**.
6. Suivre le [guide de branchement de la salle](guides/nino-installation-salle.pdf) pour les trois Sony, les quatre Cam Link et la RØDECaster Pro II. Les sources, scènes et réglages WebSocket OBS restent à configurer ; le Setup ne les écrase pas.
7. Dans **Salle et OBS**, connecter OBS, choisir le dossier des productions et faire une prise locale de trente secondes. Attendre la confirmation OBS, arrêter et relire le MP4 avant la première vraie séance.

Le raccourci ne démarre jamais un enregistrement ou un live. Si OBS a été installé dans un dossier particulier, renseigner son chemin dans `%LOCALAPPDATA%\Nino\settings.json`, par exemple :

```json
{
  "listenOnLan": false,
  "obsPath": "D:\\Logiciels\\obs-studio\\bin\\64bit\\obs64.exe"
}
```

Ne conserver que les réglages utiles et respecter le JSON. Le lanceur signale une configuration invalide. Les journaux se trouvent dans `%LOCALAPPDATA%\Nino\logs` et dans le raccourci **Journaux Nino** du menu Démarrer.

## Utiliser l’iPad et le Stream Deck

L’installation écoute d’abord uniquement sur ce PC, à `http://127.0.0.1:4310`. Le contrôle OBS, MediaMTX et la passerelle invitée restent sur la boucle locale.

Pour le pilote iPad sur le réseau privé autorisé de la salle :

1. Terminer la production et arrêter Nino avec son raccourci d’arrêt.
2. Dans `settings.json`, passer `listenOnLan` à `true`, en conservant un éventuel `obsPath`.
3. Faire autoriser le port TCP 4310 dans le pare-feu uniquement pour le réseau privé concerné, puis relancer **Nino + OBS**. Le Setup ne crée aucune règle de pare-feu et n’ouvre aucun accès Internet.
4. Sur l’iPad, utiliser l’adresse du PC indiquée dans **Appareils**, et non `127.0.0.1`. Créer le code d’association depuis le PC et associer la tablette.

Prévoir HTTPS pour l’installation durable. Le [guide Stream Deck](stream-deck.md) explique l’accès dédié via Companion ; le raccourci Windows ne change pas le contrat authentifié utilisé par les contrôleurs. Les invitations depuis Internet et le tunnel vers le VPS se préparent séparément.

Les six pages Companion sont fournies dans `%LOCALAPPDATA%\Programs\Nino\app\config\stream-deck` avec leurs instructions. Installer Companion séparément, importer ces pages et créer l’accès opérateur. Un ancien Setup conserve le code de sa construction : utiliser un nouvel installateur contenant cette fonctionnalité pour en bénéficier.

## Accueil du Stream Deck à l’ouverture de session

Cette préparation se fait une fois, avec le compte Windows habituel de la salle :

1. Dans le Setup, conserver **Ouvrir Companion à ma connexion Windows** pour créer le raccourci de démarrage de ce compte. Le menu Démarrer → **Nino → Configurer Companion** permet ensuite de changer ce réglage et de sélectionner le fichier `Companion.exe` si sa détection ne suffit pas. Companion reste une installation séparée ; le Setup Nino ne remplace pas ses profils.
2. Ouvrir **Lancer Companion** dans le même menu. Ce raccourci prépare les services Nino en arrière-plan, puis ouvre Companion. À la première utilisation, terminer la configuration de Companion sur le port local **8000** et démarrer son serveur. La préparation vérifie sa réponse réelle ; l’ouverture du processus seule n’est pas annoncée comme un serveur prêt. Le [guide officiel Companion](https://companion.free/user-guide/v5.1/getting-started/start-the-server/) décrit cette fenêtre et l’option **Start minimized**. Utiliser le démarrage Nino plutôt qu’un second **Run at login** natif, pour conserver un seul parcours d’ouverture de session.
3. Importer les pages **Régie 2, Audio 3, Médias 4, Invités 5, Menu 6, Accueil 7**, en réutilisant la même connexion HTTP Nino. Renseigner leurs six variables de navigation avec les vrais numéros si les pages sont placées ailleurs. La page 1 peut rester personnelle.
4. Dans Nino → **Appareils**, créer l’accès opérateur Stream Deck. Saisir le jeton directement dans la variable personnalisée persistante `nino_token` de Companion. Conserver ce jeton uniquement sur ce PC ; ne pas l’inclure dans un export partagé.
5. Dans **Surfaces**, sélectionner le MK.2, choisir **Accueil** comme page au démarrage et désactiver la reprise de la dernière page utilisée. Affecter l’Accueil à la surface pour voir le logo Nino. Cette affectation USB est propre à ce PC et n’est pas incluse dans un export de pages.
6. Fermer la session Windows, puis la rouvrir pour vérifier le parcours : Companion et les services Nino démarrent ; le Stream Deck affiche l’Accueil. **OBS, le navigateur, l’enregistrement, le retour programme et le live ne démarrent pas automatiquement.**
7. Appuyer sur **Ouvrir le studio** : Nino ouvre OBS et son interface avec le lanceur installé. Si les logiciels sont déjà ouverts, ils sont réutilisés. Vérifier la connexion OBS et la salle, puis sélectionner la production avec **Utiliser cette production sur le Stream Deck**. **Tout lancer** démarre ensuite la prise et l’intro ; le live reste séparé.

Pour désactiver cette préparation, décocher l’ouverture de session dans **Configurer Companion**. La désinstallation retire uniquement le raccourci de démarrage créé par Nino et conserve les profils Companion, les projets et les réglages. Le fichier `%LOCALAPPDATA%\Nino\companion-settings.json` contient le chemin de Companion et le choix de démarrage ; les erreurs sont consignées dans `%LOCALAPPDATA%\Nino\logs\companion-launcher.log`.

Si l’Accueil indique **NINO HORS LIGNE**, ouvrir **Nino + OBS** depuis Windows puis consulter les journaux. Si Companion ne répond pas, ouvrir **Configurer Companion**, vérifier son emplacement et terminer son premier réglage. Une demande « Ouvrir le studio » ne confirme jamais à elle seule qu’OBS, les caméras et les micros sont prêts.

**VERSION NINO REQUISE** signifie que le serveur utilisé ne propose pas cette ouverture : installer le nouveau Setup Windows. L’ancien installateur et le Mac utilisé pour prévisualiser les touches ne l’activent pas.

## Arrêter, mettre à jour ou désinstaller

1. Terminer la prise et le live séparément. Couper aussi le retour programme s’il utilise encore le transport de diffusion OBS.
2. Garder OBS connecté dans Nino pour confirmer qu’aucune sortie n’est active, puis ouvrir **Arrêter Nino** dans le menu Démarrer. L’arrêt vérifie l’identité des composants lancés par ce compte et demande au serveur de confirmer l’inactivité avant de fermer ses services.
3. Si l’état OBS est incertain ou si une production reste active, l’arrêt est refusé. Reconnecter OBS et corriger l’état dans la régie avant de réessayer. Une installation vierge avant configuration OBS peut être arrêtée sans connexion OBS.
4. OBS reste ouvert et n’est jamais fermé par ce raccourci. Le fermer manuellement une fois la production terminée si souhaité.
5. Relancer le nouveau Setup, ou désinstaller depuis Windows. La mise à jour et la désinstallation refusent de remplacer des composants Nino encore actifs ; elles ne les ferment pas de force.

Les fichiers suivants restent hors du dossier du logiciel et sont conservés à la désinstallation :

| Emplacement | Contenu |
| --- | --- |
| `%LOCALAPPDATA%\Nino\data` | Base, projets, paramètres privés et médias importés. |
| `%LOCALAPPDATA%\Nino\logs` | Journaux du lanceur et des composants. |
| `%LOCALAPPDATA%\Nino\runtime` | FFmpeg et ffprobe téléchargés et vérifiés. |
| `%LOCALAPPDATA%\Nino\settings.json` | Réglages du lancement Windows. |
| Dossier de production choisi dans Nino | Enregistrements vidéo réels. |

La désinstallation ne désinstalle pas OBS, ne supprime pas son profil et ne retire pas les vidéos. Prévoir malgré cela une sauvegarde indépendante avant une mise à jour. Le démarrage à l’ouverture de session est limité aux services Nino et à Companion lorsque cette option est activée ; OBS et l’interface attendent l’appui sur **Ouvrir le studio**. Les mises à jour du logiciel se font avec un nouveau Setup.

## Passer d’une installation manuelle à ce Setup

Le nouveau lanceur ne récupère pas une instance inconnue sur un port déjà occupé. Terminer les productions, arrêter les services de l’installation manuelle, puis lancer le raccourci du Setup.

Le technicien peut transférer la base et les médias importés d’une ancienne installation vers le dossier `data` du nouveau compte, services arrêtés et après sauvegarde. Ne pas écraser une base déjà utilisée. Les vidéos doivent rester aux chemins enregistrés, ou faire l’objet d’un transfert préparé séparément. Les configurations privées du Mac et du VPS ne sont pas livrées dans l’installateur.

## Construire et vérifier

Le workflow `.github/workflows/nino-windows.yml` construit sur `windows-2025` pour obtenir les dépendances natives x64 correspondantes. Il prépare un paquet autorisé avec interface compilée, dépendances npm, Node et MediaMTX vérifiés ; FFmpeg et OBS ne sont pas redistribués dans l’EXE. Inno Setup compile ensuite l’installateur par utilisateur.

Le contrôle Windows utilise le véritable EXE : installation, vérification des raccourcis, préparation réelle de FFmpeg, démarrage réel API/MediaMTX, réutilisation au second lancement, refus de désinstallation pendant leur activité, arrêt protégé, désinstallation et conservation des données. Il ne capture aucune caméra et ne simule pas une réussite d’enregistrement OBS. Les essais API couvrent aussi l’authentification locale d’arrêt et son refus pendant une production.

Le guide [développement et livraison](development.md) décrit les autres vérifications Nino. Sur le Mac de développement, utiliser Portly pour les travaux ponctuels ; ne pas lancer le programme Windows sur le Mac.
