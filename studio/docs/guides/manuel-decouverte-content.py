"""Opening and closing chapters for Nino's complete beginner manual.

These pages teach normal production work. Hardware and external services are
checked where used; a screenshot is never presented as proof of a room test.
The parent generator owns navigation, pagination, illustration and rendering.
"""


def P(text): return {'kind': 'p', 'text': text}
def H(text): return {'kind': 'heading', 'text': text}
def B(text, title='', tone='dark'): return {'kind': 'box', 'text': text, 'title': title, 'tone': tone}
def S(*items): return {'kind': 'steps', 'items': items}
def T(headers, rows, ratios=None): return {'kind': 'table', 'headers': headers, 'rows': rows, 'ratios': ratios}
def C(*rows): return {'kind': 'checklist', 'rows': rows}
def D(name): return {'kind': 'diagram', 'kind_name': name}
def SCREEN(key, fallback, limit=190): return {'kind': 'screen', 'key': key, 'fallback': fallback, 'limit': limit}
def PAGE(tag, title, lead, *blocks): return {'tag': tag, 'title': title, 'lead': lead, 'blocks': list(blocks)}


PAGES_BEGIN = [
 PAGE('Bien commencer / Ce manuel', 'Vous accompagner du début à la vidéo',
      'Ce manuel explique comment utiliser une salle déjà installée. Il sert à produire votre contenu, puis à retrouver vos fichiers.',
      D('flow'),
      S(('Commencer par les repères',
         'Lisez les premières pages pour comprendre le rôle du PC, les mots affichés et les boutons. Vous pouvez ensuite suivre le chapitre de votre contenu : podcast, discussion ou présentation.'),
        ('Suivre une tâche à la fois',
         'Chaque suite de gestes commence par l’écran à ouvrir. Cliquez une fois, regardez le résultat, puis continuez. Les captures servent de repères ; votre titre et vos plans peuvent être différents.'),
        ('Ajouter seulement les options utiles',
         'Vous pouvez commencer sur le PC seul. L’iPad, le Stream Deck, les invités, le direct et la réalisation automatique ont leurs propres chapitres. Utilisez-les quand la salle est équipée.')),
      B('Si Nino ou OBS ne sont pas installés, demandez au technicien de préparer la salle. Vous n’avez pas besoin de programmer pour suivre ce manuel.',
        'Avant votre première utilisation', 'light')),

 PAGE('Bien commencer / Les outils', 'Qui fait quoi dans la salle ?',
      'Le PC fixe reçoit les caméras et les micros. Il conserve les vidéos enregistrées.',
      T(['Outil', 'À quoi il vous sert'], [
       ['Le PC de la salle', 'Il reçoit le matériel et conserve les fichiers. Il reste allumé pendant la production.'],
       ['Nino, dans le navigateur', 'Vous nommez votre projet, préparez la salle, choisissez les plans et commandez les prises.'],
       ['OBS, sur ce PC', 'Il compose l’image, mélange les sons et écrit la vidéo lorsque vous enregistrez.'],
       ['iPad et Stream Deck', 'Ils commandent la même salle avec leur propre accès. Ils ne remplacent pas le PC.']],[1,2.6]),
      S(('Ouvrir le bon Nino',
         'Utilisez le raccourci de la salle ou l’adresse donnée par le technicien. Le nom de la salle s’affiche en haut. Sur le PC, l’adresse locale habituelle est http://127.0.0.1:4310.'),
        ('Garder les outils nécessaires ouverts',
         'OBS doit rester ouvert. Si vous recevez des invités, conservez aussi la fenêtre de liaison de la salle. Fermer le navigateur n’arrête pas automatiquement une prise ou un direct.')),
      B('Le téléchargement crée une copie sur votre appareil. Les originaux restent sur le PC de la salle.',
        'Où vivent les fichiers ?', 'light')),

 PAGE('Bien commencer / Les mots à l’écran', 'Projet, prise et plan : trois choses différentes',
      'Imaginez que vous préparez « Présentation du service ». Vous pouvez recommencer son enregistrement sans recréer tout le projet.',
      T(['Mot affiché', 'Exemple dans votre travail'], [
       ['Production / projet', '« Présentation du service » : le sujet, les personnes, les médias et les prises réunis sous un nom.'],
       ['Prise', 'Vous cliquez Enregistrer, vous parlez, puis vous terminez. Une deuxième tentative devient une autre prise du même projet.'],
       ['Scène / plan', '« Plan large » ou « Présentation » : une composition déjà préparée dans OBS.'],
       ['Source', 'La caméra, le micro, la fenêtre d’un logiciel ou un fichier qu’OBS utilise.'],
       ['Programme', 'Le résultat choisi : cette image et ce son vont vers la prise et, si lancé, le direct.'],
       ['Retour', 'L’aperçu du programme sur votre écran Nino. Il peut arriver avec quelques secondes de retard.']],[1,2.7]),
      B('Passer du plan caméra à la présentation change le programme. Cela ne crée pas une nouvelle prise. Pause puis Reprendre continue aussi la même prise.',
        'Un exemple à retenir', 'light')),

 PAGE('Bien commencer / Votre contenu', 'Choisir votre format et votre diffusion',
      'Choisissez le format qui ressemble à ce que vous allez faire. Il propose une scène au démarrage ; les sources sont préparées dans OBS.',
      T(['Votre contenu', 'Format à choisir'], [
       ['Une émission centrée sur la voix', 'Podcast : seul, en entretien ou à plusieurs. La sortie du fichier dépend des réglages OBS.'],
       ['Une discussion filmée', 'Table ronde : personnes en salle, plan large et, si préparés, plans individuels.'],
       ['Un contenu que vous montrez', 'Présentation et partage d’écran : diaporama, document, navigateur, logiciel ou ordinateur en HDMI.']],[1.1,2.5]),
      S(('Pour garder une vidéo',
         'Utilisez Enregistrer, repéré par REC. La prise est écrite sur le PC. Après son arrêt confirmé, vous pouvez la relire et la télécharger.'),
        ('Pour montrer en direct',
         'Utilisez Diffuser en direct, repéré par LIVE, lorsque la destination est préparée. Cela envoie le programme à la plateforme. Démarrez aussi REC si vous voulez une copie locale.')),
      B('Vous pouvez enregistrer sans diffuser, diffuser sans enregistrer, ou faire les deux. Terminer une prise et arrêter un direct sont deux actions distinctes.',
        'REC et LIVE restent séparés', 'light')),

 PAGE('Bien commencer / Les écrans', 'Vous repérer et comprendre votre accès',
      'Le menu permet de changer de tâche. Dans une production, les trois onglets vous font avancer de la préparation aux fichiers.',
      T(['Dans le menu', 'Ce que vous y faites'], [
       ['Productions', 'Créer, retrouver et ouvrir vos projets ; accéder à leurs prises.'],
       ['Bibliothèque', 'Ajouter et organiser les images, vidéos, sons et documents de la salle.'],
       ['Salle et OBS', 'Vérifier la connexion et les sources ; le technicien y prépare les réglages communs.'],
       ['Appareils', 'Associer un iPad et préparer un accès Stream Deck avec la personne autorisée.']],[1,2.7]),
      H('Dans votre production'),
      P('<b>Préparer la salle</b> : personnes, sources, fichiers et contrôles.<br/>'
        '<b>Enregistrer et diffuser</b> : la régie pour conduire votre contenu.<br/>'
        '<b>Retrouver les prises</b> : relire et récupérer les enregistrements.'),
      B('Un accès Consultation permet de regarder et de télécharger les prises terminées. Un accès Préparation et contrôle permet de produire. Les réglages communs demandent un accès technicien. Si une commande reste grisée, vérifiez votre accès, la connexion et le message affiché.',
        'Pourquoi mes boutons sont-ils différents ?', 'light')),

 PAGE('Bien commencer / Votre première minute', 'Prendre vos repères avec une courte vidéo',
      'Avant une vraie séance, faites une prise d’environ trente secondes. Les chapitres suivants détaillent chaque écran et chaque commande.',
      S(('Installer votre écoute et votre image',
         'Ouvrez OBS et Nino. Branchez un casque. Vérifiez le cadrage et dites une phrase : le bon vumètre doit réagir. Écoutez la voix ; le technicien vous aide si elle est faible ou déformée.'),
        ('Créer un essai identifiable',
         'Dans Productions, choisissez Nouvelle production et donnez-lui un nom clair. Ajoutez votre micro. Dans Préparer la salle, cliquez Vérifier et faites corriger les blocages.'),
        ('Enregistrer calmement',
         'Ouvrez la régie, choisissez le bon plan puis Enregistrer. Confirmez et attendez OBS avant de parler. Présentez votre sujet, puis faites un geste ou changez une page.'),
        ('Terminer puis regarder votre fichier',
         'Cliquez Terminer la prise, confirmez et attendez l’arrêt. Ouvrez Retrouver les prises, puis Lire la prise. Vérifiez le début et la fin avec le son. Vous êtes prêt à suivre votre recette de production.')),
      B('Pour cet essai, laissez LIVE arrêté. Un retour reçu ne prouve pas qu’une prise est enregistrée : regardez REC et lisez ensuite le fichier.',
        'Votre premier résultat', 'light')),
]


PAGES_END = [
 PAGE('Après la production / Ranger et conserver', 'Quitter la salle avec vos fichiers',
      'Prenez le temps de fermer la production proprement. Vous devez savoir quelle vidéo conserver et où se trouve sa copie.',
      S(('Terminer les sorties',
         'Terminez la prise et attendez la confirmation d’OBS. Si vous avez diffusé, arrêtez aussi le direct et vérifiez la plateforme. Fermez la liaison invités après la conversation.'),
        ('Choisir les prises utiles',
         'Dans Retrouver les prises, relisez les vidéos à garder. Choisissez Télécharger en MP4 pour emporter une vidéo simple, Télécharger le fichier pour l’original ou le dossier complet pour toutes les pièces. Attendez la fin du téléchargement.'),
        ('Ouvrir vos copies',
         'Copiez le MP4 sur votre clé USB, puis vérifiez image et son depuis cette copie. Éjectez la clé avant de la retirer. Le paquet Resolve avec timelines et repères reste une option : si vous le choisissez, gardez-le entier après extraction.'),
        ('Prévoir deux emplacements',
         'Conservez les originaux sur le PC et une copie vérifiée sur un disque ou un emplacement indépendant autorisé. Deux dossiers sur le même disque ne protègent pas contre sa panne.')),
      B('La sauvegarde complète du logiciel, de sa base et des profils OBS revient au technicien. Rangez le matériel selon les consignes de la salle ; ne supprimez pas les fichiers d’une autre personne.',
        'Avant de partir', 'light')),

 PAGE('Besoin d’aide / OBS et la prise', 'Quand l’enregistrement ne se confirme pas',
      'Commencez par regarder OBS sur le PC. Ne relancez pas Enregistrer pour réparer un état inconnu dans Nino.',
      T(['Ce que vous voyez', 'Ce que vous faites'], [
       ['OBS déconnecté', 'Ouvrez OBS. Avec le technicien, vérifiez sa connexion dans Salle et OBS. Attendez OBS connecté avant une nouvelle prise.'],
       ['État incertain pendant une prise', 'Regardez si OBS enregistre encore. S’il tourne, terminez-y la capture avec le technicien, puis récupérez le fichier à son emplacement.'],
       ['Prise Interrompue', 'Le fichier final n’est pas confirmé dans Nino. Faites vérifier le disque ; cette étiquette ne signifie pas que tout a été effacé.'],
       ['Espace disque insuffisant', 'Arrêtez la préparation. Faites libérer de l’espace ou choisir un autre disque, puis relancez Vérifier.'],
       ['OBS enregistre hors de Nino', 'Faites terminer cette capture dans OBS. Elle n’est pas automatiquement rattachée à votre projet.']],[1.1,2.6]),
      B('Notez le titre du projet, l’heure et le message. Évitez les redémarrages pendant une activité. Le technicien doit vérifier l’état réel avant de relancer la salle.',
        'Pour garder une suite claire', 'light')),

 PAGE('Besoin d’aide / Image et son', 'Remonter du résultat vers sa source',
      'Une fenêtre fermée peut produire une image noire. Un retour muet peut simplement avoir son écoute désactivée.',
      S(('Retour reçu, mais image noire',
         'Regardez la scène dans OBS. Ouvrez le document ou le logiciel et faites rechoisir sa fenêtre dans la source de capture. Vérifiez l’autorisation de capture macOS avec le technicien. Attendez une image correcte avant d’enregistrer.'),
        ('Image visible, mais vous n’entendez pas le retour',
         'Branchez le casque, vérifiez son volume puis cliquez Écouter le retour. Regardez le vumètre du bon micro. Pour une lecture bloquée, utilisez Lire le retour ou Actualiser le lecteur si proposé.'),
        ('La voix manque dans le fichier',
         'Vérifiez dans OBS le micro réellement utilisé, son état et ses niveaux. Faites corriger son routage, puis enregistrez et relisez une courte phrase.'),
        ('La voix revient en écho',
         'Coupez les haut-parleurs près des micros. Pendant un appel, gardez le retour HLS de régie muet et écoutez les invités dans la liaison PC, au casque.')),
      B('Le retour Nino arrive avec un décalage. Pour voir immédiatement un changement, regardez OBS ; patientez avant de répéter une commande.',
        'Un retard n’est pas une panne', 'light')),

 PAGE('Besoin d’aide / iPad et invités', 'Retrouver la connexion sans refaire la prise',
      'Le PC continue à faire fonctionner OBS. Commencez par retrouver la bonne salle et la bonne production sur l’appareil concerné.',
      T(['Situation', 'Geste utile'], [
       ['Nino ne s’ouvre pas sur iPad', 'Utilisez l’adresse fournie par Appareils sur le PC et le réseau autorisé. localhost sur la tablette désigne la tablette elle-même.'],
       ['L’iPad a perdu le réseau', 'Rouvrez Nino et la production. Vérifiez la prise actuelle sur le PC ; ne relancez pas REC pour réparer l’écran.'],
       ['Vous pouvez lire, mais pas commander', 'Demandez un accès Préparation et contrôle pour produire. Consultation permet de lire et de télécharger les prises terminées.'],
       ['Un invité reste en attente', 'Sur le PC, vérifiez la liaison ouverte, le bon aperçu et la connexion. Accueillez seulement lorsque son image et son son arrivent.'],
       ['Invitation expirée ou retirée', 'Créez un nouveau lien pour cette personne. Après une coupure, attendez aussi le retour des médias avant de l’accueillir à nouveau.']],[1.1,2.6]),
      B('Si un appel reste muet, activez Écouter les invités au casque dans la liaison PC. Pour les appels extérieurs, faites vérifier l’accès HTTPS et le relais réseau par le technicien.',
        'La bonne écoute', 'light')),

 PAGE('Besoin d’aide / Direct et fichiers', 'Vérifier la destination et les originaux',
      'Après l’envoi ou le téléchargement, vérifiez ce qui a réellement été reçu ou ouvert.',
      T(['Situation', 'Geste utile'], [
       ['LIVE indiqué, mais rien sur YouTube', 'Vérifiez l’événement et son écran de réception. Faites contrôler la destination et la publication sur YouTube.'],
       ['La copie de lecture ne s’ouvre pas', 'Renouvelez la lecture ou utilisez Télécharger en MP4. Télécharger le fichier récupère l’original ; un autre lecteur peut être nécessaire.'],
       ['Le dossier complet est indisponible', 'Terminez REC et LIVE de cette production. Faites vérifier les originaux : un fichier déplacé peut bloquer le ZIP.'],
       ['Le téléchargement est introuvable', 'Cherchez dans les téléchargements du navigateur. Sur iPad : Fichiers puis Téléchargements. Le MP4 s’ouvre directement ; décompressez seulement les ZIP.'],
       ['Resolve : le MP4 est hors ligne', 'Copiez le MP4 dans le dossier de travail de l’ordinateur de montage. Dans Resolve, reliez le média à ce fichier local.'],
       ['Resolve : les médias OTIO manquent', 'Pour le paquet Resolve, gardez resolve-media avec les timelines décompressées. Reliez les médias à ce dossier.']],[1.1,2.6]),
      B('Gardez les originaux jusqu’à vérification de leur copie. Transmettez le message au technicien, sans clé de diffusion ni jeton d’accès.',
        'Ce qu’il faut transmettre', 'light')),

 PAGE('Besoin d’aide / MP4 et clé USB', 'Quand le téléchargement ou la copie bloque',
      'Un téléchargement et une copie sur clé sont deux opérations. Vérifiez leur résultat avant de quitter la salle.',
      T(['Situation', 'Geste utile'], [
       ['Le bouton MP4 manque', 'Ouvrez Retrouver les prises. Choisissez une prise Terminée avec son fichier confirmé. Pour une prise Interrompue, faites vérifier l’original.'],
       ['Préparation du MP4… reste affiché', 'Gardez le PC allumé. Une longue vidéo prend du temps. Annuler l’attente libère votre écran ; le PC peut continuer la préparation. En cas d’erreur, transmettez le message au technicien.'],
       ['Nino annonce le lancement', 'Cela ne confirme pas la fin du transfert. Ouvrez les téléchargements du navigateur, attendez la fin, puis lisez le fichier .mp4 avec le son. Si le lien expire, redemandez-le depuis la prise.'],
       ['La clé refuse le fichier', 'Vérifiez son espace libre. Une clé FAT32 limite chaque fichier à 4 Go environ. exFAT convient aux fichiers plus grands sur Mac et Windows : demandez une clé adaptée au technicien.']],[1.1,2.6]),
      B('Ne formatez pas la clé pour résoudre un blocage : cela peut effacer son contenu. Gardez l’original sur le PC. Après copie, ouvrez la vidéo depuis la clé, vérifiez le son, puis éjectez-la.',
        'Garder une copie vérifiée', 'light')),

 PAGE('Retrouver un mot / Lexique', 'Les mots utiles pendant votre production',
      'Revenez ici lorsqu’un mot de l’écran ou du manuel vous arrête. Les noms de vos scènes et de vos fichiers restent ceux de votre salle.',
      T(['Mot', 'Sens dans Nino'], [
       ['Production', 'Votre contenu nommé, avec ses personnes et ses prises.'],
       ['Prise', 'Un enregistrement complet, du démarrage à l’arrêt.'],
       ['Scène / plan', 'Une composition préparée dans OBS que vous sélectionnez.'],
       ['Source', 'Une image ou un son utilisé par OBS.'],
       ['Programme', 'L’image et le son choisis pour la production.'],
       ['Retour', 'L’aperçu du programme sur votre appareil, avec retard.'],
       ['REC', 'L’enregistrement local sur le PC de la salle.'],
       ['LIVE', 'L’envoi du programme vers une plateforme de direct.'],
       ['Bibliothèque', 'Les médias disponibles sur le PC pour vos productions.'],
       ['Repère', 'Une note placée à un moment de la prise pour le montage.']],[1.1,2.9]),
      B('Enregistrer crée la prise. Télécharger crée une copie sur votre appareil. Copier sur une clé USB crée ensuite une autre copie ; l’original reste sur le PC.',
        'Trois gestes différents', 'light')),

 PAGE('Retrouver un mot / Fichiers et montage', 'Comprendre les fichiers que vous emportez',
      'Pour une seule vidéo à lire ou à monter, le MP4 suffit. Les autres fichiers servent à conserver davantage d’informations.',
      T(['Mot', 'Sens dans votre travail'], [
       ['MP4', 'Un fichier vidéo contenant l’image et le son du programme. Télécharger en MP4 conserve la prise entière dans une copie compatible.'],
       ['ZIP', 'Un dossier compressé à décompresser. Nino l’utilise pour le dossier complet ou le paquet Resolve ; un MP4 simple n’en a pas besoin.'],
       ['Export', 'Une sortie préparée pour être récupérée : un fichier vidéo ou un ensemble de fichiers, selon votre choix.'],
       ['Importer un média', 'Ajouter une vidéo, par exemple votre MP4, dans un projet de montage. Cela ne lance pas un enregistrement Nino.'],
       ['Timeline / OTIO', 'Une organisation du montage importable dans Resolve. Le paquet Nino ajoute les repères ; il ne réalise pas les coupes à votre place.'],
       ['Caméra virtuelle', 'Le programme OBS proposé comme caméra dans un appel. Elle ne crée pas de fichier supplémentaire.']],[1.1,2.9]),
      B('Le MP4 rassemble les plans choisis pendant la prise. Il ne fournit ni caméras séparées ni repères OTIO. Choisissez le paquet Resolve seulement si vous souhaitez aussi ces timelines et repères.',
        'Choisir selon votre besoin', 'light')),

 PAGE('À garder près de vous / Aide-mémoire', 'Votre séance en quelques gestes',
      'Cette liste sert pour une vraie production. Les chapitres expliquent les gestes ; cochez les lignes au moment où vous les effectuez.',
      H('Avant de commencer'),
      C('J’ai ouvert la bonne production et vérifié son nom.','OBS est connecté ; la salle est prête et le disque disponible.','J’ai regardé mon cadrage, écouté les micros et préparé mes supports.'),
      H('Pendant la production'),
      C('J’attends la confirmation REC avant de commencer la prise.','Si je diffuse, je vérifie aussi l’image et le son reçus sur la plateforme.','Je choisis mes plans et je note les passages utiles avec des repères.'),
      H('Pour terminer'),
      C('J’arrête et vérifie séparément la prise et le direct.','Je relis le fichier avec le son, y compris son début et sa fin.','Je récupère ma copie. Si j’utilise une clé USB, j’ouvre sa copie avec le son, puis j’éjecte la clé.'),
      P('Ma production : ......................................................................................<br/>'
        'Ma copie se trouve ici : .........................................................................')),

 PAGE('Pour aller plus loin / Passer le relais', 'Savoir quand demander de l’aide',
      'Nino conduit une production préparée avec OBS. Certaines demandes nécessitent du matériel, un réglage de salle ou un travail de montage.',
      T(['Vous souhaitez', 'À prévoir'], [
       ['Changer le cadrage selon la voix', 'Un micro et un plan distincts par personne ; la réalisation utilise les niveaux, sans reconnaître les identités.'],
       ['Reprendre un autre angle au montage', 'Des caméras séparées enregistrées en plus du programme ; Nino ne les fabrique pas à partir de la vidéo finale.'],
       ['Monter automatiquement le contenu', 'Le paquet Resolve garde le programme et les repères. Les coupes éditoriales, titres et finitions se font ensuite dans Resolve.'],
       ['Accueillir plus de personnes', 'Le périmètre actuel est de quatre personnes en salle et deux invités à distance.']],[1.1,2.6]),
      H('À transmettre au technicien'),
      P('Production / prise : ................................................................................<br/>'
        'Appareil et navigateur : .........................................................................<br/>'
        'Ce que je voulais faire : .........................................................................<br/>'
        'Ce qui s’affiche ou s’entend : ..................................................................<br/>'
        'Heure et message exact : .......................................................................'),
      B('Ajoutez une capture de l’écran utile si elle ne montre pas de clé, de jeton ou de lien personnel. Gardez le fichier concerné disponible pour la vérification.',
        'Pour une aide concrète', 'light')),
]
