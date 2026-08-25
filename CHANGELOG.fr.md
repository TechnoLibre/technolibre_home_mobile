
# Journal des modifications

Tous les changements notables de ce projet sont consignés dans ce fichier.

Le format suit [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Non publié]

### Ajouté
- **Bundle de test** — une troisième cible dans Options › Code, après Mobile
  et ERPLibre. 52 fixtures d'affichage sous 400 Ko : PNG en couleur, avec
  alpha et en niveaux de gris, plus le cas dégénéré 1×1, BMP, GIF fixe et
  animé, trois SVG, WAV, et les JPEG, WebP, MP3, OGG et ICO empruntés ;
  markdown, JSON, CSV, XML, YAML, TOML, texte brut, un fichier vide et une
  feuille Unicode ; et six projets de code — Tornado, un module Odoo avec
  composant Owl, JavaScript, Rust, C++ et Java. Un format qui ne s'affiche
  pas ici ne s'affichera pas dans un vrai dépôt, et on le voit sans dérouler
  82 000 fichiers. Aucune vidéo n'est livrée : H.264 et VP9 exigent un
  encodeur que cette machine n'a pas, et `media/PROVENANCE.md` porte les
  deux commandes ffmpeg qui comblent le manque
- **Tableaux markdown dans le navigateur de code** — chaque document de
  `doc/` est fait de tableaux, et chaque rangée de barres s'affichait en
  paragraphe. Six niveaux de titre et les listes imbriquées ont suivi. Le
  rendu est passé à côté de `syntax_highlight.ts` pour être testable, y
  compris contre la documentation du dépôt

### Modifié
- **Les catalogues gettext quittent le bundle** — 41 763 fichiers et 857 Mo,
  33,5 % des fichiers et 58,7 % de la charge, contre 603 Mo pour tout le
  reste. Weblate et les robots OCA les maintiennent, et personne n'en lit un
  sur un téléphone. Les archives passent de 431 à 328 Mo, et la compilation
  dit ce qu'elle a écarté. `BUNDLE_KEEP_PO=1` les ramène,
  `BUNDLE_SKIP_IMG=1` écarte aussi les images matricielles et amène les
  archives à 115 Mo. Effet de bord bienvenu : 41 763 fichiers de moins
  ramènent la compilation de 43 s à 22 s

## [2026.08.24.01] - 2026-08-24

Résumé du développement depuis la publication `2026.04.14.01` (14 avril 2026).
Intègre la branche `quality_functionnality_test` : 160 commits fusionnés dans
`main` sous forme de dix demandes de tirage empilées, puis 11 commits de plus
portant la documentation bilingue, cette publication et les libellés
d'accessibilité. La suite de tests passe de 854 à 1000 tests répartis sur 66
fichiers.

### Ajouté
- **Prise en charge de l'Elgato Stream Deck** — une pile USB Android native,
  écrite de zéro en Java sur `UsbDeviceConnection`, sans aucune dépendance HID
  tierce :
  - **Sept modèles** dans `DeckRegistry` — Original, MK.2, XL, XL v2, Mini,
    Plus et Neo — chacun avec sa grille de touches, son format d'image, sa
    rotation et sa géométrie de bordure
  - **Deux protocoles de transport** — pagination `TransportV1` et
    `TransportV2`, choisie par modèle
  - **Chaîne d'images** — `RgbaRotator` (rotation BGR en Java pur), encodeurs
    BMP et JPEG par modèle, et `LcdEncoder` pour la bande tactile du Plus
  - **`WriterQueue`** — fusion par touche, pour qu'un deck lent laisse tomber
    les images périmées au lieu d'accumuler du retard
  - **Multi-deck** — une `DeckSession` par appareil ouvert, un `PendingIntent`
    par appareil pour la permission, et un branchement à chaud USB restreint à
    l'identifiant de fabricant Elgato
  - **Diffusion de la caméra** — la caméra arrière peinte sur chaque deck, avec
    cadence d'images, choix de caméra, qualité JPEG, saut des images fixes et
    compensation de bordure par axe
  - **Détection de visages** — ML Kit marque les tuiles qui cadrent un visage
  - **Intégration aux notes** — touches d'action et entrées de note peintes sur
    les touches ; presser une touche pilote la note
  - **Panneau de diagnostic** (`/options/streamdeck`) — luminosité par deck, un
    scanner USB listant chaque appareil, un vidage HID brut, un journal
    d'événements qui survit à la navigation, et un interrupteur de
    rafraîchissement automatique
  - **Bandeau LCD** — texte défilant sur l'écran tactile du Plus
- **Édition de code** (`/options/code`) — le navigateur devient inscriptible :
  - **`RepoExtractorService`** — extraction paresseuse de `tar.gz` vers le
    système de fichiers Capacitor, avec un analyseur ustar intégré et des
    enveloppes `DecompressionStream`, si bien qu'aucune bibliothèque d'archive
    n'est embarquée
  - **`EditableCodeService`** — édition adossée à git via `isomorphic-git` sur
    un adaptateur `Filesystem` de Capacitor ; promouvoir un dépôt en éditable
    enregistre une référence git
  - **Panneau git** — état, un vrai diff issu du paquet `diff`, et un
    avertissement quand la référence a dérivé
  - Navigation dans la **racine de l'espace de travail**, et non plus seulement
    dans les sources de l'application
- **Galerie de photos** — toutes les photos de toutes les notes en un seul
  endroit, avec zoom par pincement, une interface qui s'efface et les prises en
  paysage tournées
- **Catalogue de fonctionnalités** (`/options/features`) — un catalogue bilingue
  de chaque fonctionnalité, avec arêtes de dépendance, état par feuille, blocs
  de fonctionnement, recherche, liens profonds et vues matrice, cartes et
  tableau de bord
- **Pipeline de bundle** — les dépôts du manifeste livrés en un `tar.gz` chacun,
  construits en parallèle à la hauteur du nombre de processeurs, avec
  `BUNDLE_SKIP_REPOS` pour itérer en développement ; gabarits Owl précompilés à
  la compilation dans leur propre fragment ; `build_id.json` émis depuis le SHA
  git
- **Moteur de transcription Groq** — sur activation explicite, à côté des ponts
  SSH, HTTP et whisper sur l'appareil déjà présents
- **Écran maintenu allumé** — garder l'écran du téléphone allumé depuis Options
- **Dialogue d'appareil** — toutes les interfaces réseau listées
- **Compteur de temps de fonctionnement** à côté du temps de démarrage sur
  l'accueil
- **Documentation** — le plugin Stream Deck, le pipeline de bundle et le mode
  édition, un script de test de fumée et la matrice matérielle manuelle qu'il ne
  peut pas remplacer, et comment déboguer une compilation Android par wifi
- **Documentation bilingue** — chaque document de `doc/`, les deux README et
  ce journal ont désormais une source `.base.md` générant un fichier anglais
  et un fichier français via mmg, selon la convention du dépôt racine. La
  moitié de la documentation n'existait qu'en français et l'autre qu'en
  anglais ; aucune moitié n'était atteignable dans l'autre langue.

### Modifié
- **La couverture AOT d'Owl est désormais complète** — les gabarits de note ont
  abandonné l'interpolation, tous les gabarits sont donc précompilés ; la
  recherche se fait par source brute
- **Bundle fournisseur découpé** avec `manualChunks`
- **Compilation Android** — une seule ABI par défaut et whisper désactivable, ce
  qui raccourcit la compilation locale
- **Dépendances** — montées de version correctives, mineures et majeures ; une
  dépendance morte retirée ; `isomorphic-git` ajouté pour le mode édition
- **Couverture de tests** — le contrôleur Stream Deck, le journal d'événements,
  trois ponts, le rendu LCD, quatre services non testés, les migrations de
  schéma, les entrées-sorties chiffrées, les classes d'erreur, l'utilitaire
  WebView, la classe de base des composants, le crochet de section, et le
  générateur de vignettes vidéo comme son rattrapage
- **Les permissions du catalogue** sont maintenant auditées contre le manifeste
  Android par un test
- **Couverture de traduction** — 62 aria-label et 354 occurrences de texte
  visible qui portaient du français en dur passent désormais par les
  dictionnaires, passés de 383 à 591 clés. 86 de ces valeurs avaient déjà
  une clé définie et non employée : elles sont branchées plutôt que
  dupliquées. Un test collecte chaque appel statique à `t()` dans le code et
  échoue si une clé manque d'un côté, ce qu'aucun rendu de gabarit n'aurait
  attrapé. Le catalogue de fonctionnalités et le diagnostic Stream Deck
  gardent leurs propres chaînes : le premier a son sélecteur FR/EN, le second
  est une sortie de journal
- **Changelog intégré** — lit le `CHANGELOG.md` embarqué au lieu de porter sa
  propre copie du texte et une constante de version en dur. La version
  affichée est le premier titre daté du fichier, dans la langue du lecteur ;
  une publication n'exige donc plus de l'incrémenter à la main

### Corrigé
- **Fiabilité du Stream Deck** — des touches qui fonctionnaient une fois puis
  s'arrêtaient ; lecture déplacée vers `UsbRequest` pour passer outre le sondage
  HID du noyau, en survivant à un délai dépassé grâce à un sondage en dernier
  recours ; rapports de touches correctement analysés pour XL, MK.2 et v2 ;
  événements émis seulement au changement ; tampon de lecture ajusté à la taille
  de paquet du point de terminaison ; chaque deck réinitialisé avant le
  démontage USB, au balayage depuis les récents et à l'arrêt du flux ; decks
  atténués plutôt que réinitialisés en veille, gardant le bus vivant ; file
  d'écriture vidée à l'arrêt du flux ; pressions sur Note limitées en cadence
  pour esquiver un plantage de la WebView ; plus de peinture quand
  l'application est masquée
- **Curseur de note** — le curseur se place dans le titre de la note à
  l'autofocus, et continue d'essayer en montrant qu'il attend
- **Persistance de transcription** — une transcription est enregistrée quoi que
  fasse l'interface
- **Contraste des notes** — icônes d'entrée inversées sur les thèmes clairs, et
  libellés de boutons lisibles sur les fonds saturés
- **Les entrées Photo et Image** restent distinctes
- **`usesCleartextTraffic`** gagne la fusion du manifeste Android
- **Dépréciations Gradle** d'affectation par espace réduites au silence
- **Un lien symbolique périmé** sous `repos/` ne casse plus la compilation
- **Le `versionCode` Android** n'avait jamais bougé de 1 depuis le premier
  commit. Android refuse d'installer un APK dont le code n'est pas supérieur
  à l'installé : aucune publication n'était donc installable par-dessus la
  précédente. Il suit désormais l'entier CalVer qu'emploient déjà les
  migrations

### Retiré
- **`debug.keystore`** retiré du dépôt
- **Le mode lecteur USBDEVFS natif** — abandonné après que le chemin
  `UsbRequest` s'est révélé suffisant
- **`build_id.json` et `feature_touched.json`** quittent le contrôle de
  version. Les deux sont des sorties de compilation ; le second dérive des
  dates de modification du système de fichiers, si bien qu'un rebase
  estampillait toutes les fonctionnalités de la même date fausse

### Sécurité
- **Quatre constats d'audit critiques** clos, puis ceux de gravité moyenne et
  faible
- **Chiffrement des identifiants** et épinglage de certificat
- **CSP**, éléments PWA embarqués, réduction R8 et une fourche de JSch

## [2026.04.14.01] - 2026-04-14

Résumé du développement depuis la publication `2026.04.13.01` (13 avril 2026).
Intègre la branche `code_integration`.

### Ajouté
- **Navigateur de code** (`/options/code`) — navigateur de code source
  multi-mode, avec trois modes de connexion :
  - **Bundle** — lit les sources de l'application embarquées à la compilation
    (`src/public/repo/`), aucune connexion SSH requise
  - **SSH Chemin** — se connecte à un serveur SSH enregistré ; affiche les
    espaces de travail disponibles dans un sélecteur, puis parcourt le système
    de fichiers distant
  - **SSH URL** — lit les dépôts du manifeste ERPLibre embarqués à la
    compilation (`src/public/repos/{slug}/`) ; les puces de projet montrent le
    nom et la révision
- **Coloration syntaxique** — tokeniseur sans dépendance pour Python,
  TypeScript, JSON, SCSS et Shell ; toutes les couleurs par variables CSS
  (valeurs par défaut de style Monokai)
- **Aperçu Markdown** — bascule entre source brute et HTML rendu pour les
  fichiers `.md`
- **Visionneuse d'images** — affichage `<img>` intégré pour `.png`, `.jpg`,
  `.svg`, `.webp` et d'autres formats ; URL de données en mode SSH, URL de
  bundle en mode hors ligne
- **Éditeur intégré** — édition d'une ligne via `writeLine()` (mode SSH
  seulement) ; la ligne surlignée se rafraîchit après enregistrement sans
  recharger tout le fichier
- **Empaqueteur de sources Vite** — `bundleSourcePlugin` dans `vite.config.ts`
  copie les sources de l'application vers `src/public/repo/` et les dépôts du
  manifeste vers `src/public/repos/{slug}/` à la compilation ; génère un
  `index.json` par bundle et un `manifest.json` listant les dépôts disponibles

### Modifié
- **Empaqueteur Vite — exclusion des artéfacts** : les bundles des dépôts du
  manifeste passent désormais outre `android/`, `ios/`, `build/`, `.gradle/`,
  `__pycache__/`, `venv/` et d'autres répertoires d'artéfacts, les extensions
  binaires (`.so`, `.class`, `.jar`, `.aar`, `.dex`, `.pyc`, etc.) et les
  fichiers de plus de 1 Mo — ce qui évite les échecs d'empaquetage de l'APK
  causés par l'inclusion de 39 Mo d'artéfacts Gradle compilés
- **Diagnostics de compilation** (`BUNDLE_DEBUG=1`) : traçage détaillé par
  fichier des décisions de copie ou d'omission ; durée réelle et nombre de
  fichiers omis par projet sur chaque ligne de résumé ; avertissements
  `[bundle-warn]` sur les liens symboliques brisés ou les erreurs de permission,
  sans interrompre la compilation

## [2026.04.13.01] - 2026-04-13

Résumé du développement depuis la publication `2026.03.18.01` (20 mars 2026).
Intègre les branches `feature/local_gpt` et `feature/deploy_ssh_erplibre`
fusionnées dans `main`, ainsi que des améliorations de la branche `gpt_whisper`.

### Ajouté
- **Transcription Whisper** : transcription audio et vidéo locale, sur
  l'appareil (Android), via whisper.cpp / GGML — aucun serveur externe, aucun
  abonnement requis
- **Modèles Whisper** : 6 variantes disponibles — tiny, base, small, medium,
  large-v3-turbo et distil-large-v3 (anglais seulement) — avec taille, vitesse
  et progression affichées sur chaque carte de modèle
- **OCR** : détection de texte ML Kit sur les entrées photo (ML Kit Text
  Recognition)
- **Scan réseau** : découverte SSH sur le réseau local en /24 via
  NetworkScanPlugin (50 fils parallèles, bannière SSH confirmée)
- **Déploiement SSH** : parcours de déploiement d'ERPLibre depuis l'application
  — connexion SSH (JSch), `git clone`, `make install` — avec progression
  visuelle par étape (gris → vert) et journal en temps réel
- **Suivi des processus** : journal SQLite des transcriptions et téléchargements
  d'arrière-plan, persisté entre les redémarrages ; modal de détail avec journal
  de débogage Java-level et bouton de navigation vers la note associée
- **Moniteur de ressources** : graphiques temps réel de CPU, RAM et batterie via
  DeviceStatsPlugin (`/proc/stat` + `MemoryInfo` + `BatteryManager` en Java
  natif)
- **Tags hiérarchiques** : système de tags parent/enfant avec sélecteur de
  couleur, noms résolus dans les puces de la liste de notes, noms au-dessus du
  titre dans l'éditeur, et une vue « par tag » dédiée depuis l'accueil
- **Priorité de note** : matrice d'Eisenhower (urgent/important) avec icônes et
  filtrage dans la liste de notes
- **Tableau de bord d'accueil** : disposition en tableau de bord remplaçant les
  simples boutons

### Modifié
- **Téléchargement WakeLock** : `PowerManager.PARTIAL_WAKE_LOCK` garde le
  processeur et le réseau actifs écran éteint ; reprise par `Range: bytes=N-` sur
  le fichier `.partial`
- **Téléchargement multi-fils (×4)** : les téléchargements frais (taille connue)
  emploient 4 connexions HTTP Range parallèles écrivant dans un `FileChannel`
  préalloué — théoriquement jusqu'à 4 fois plus rapide
- **Service au premier plan** : mode alternatif avec une notification Android
  persistante et un bouton Annuler ; ré-attachement automatique à la Promise JS
  après recréation de l'Activity
- **Téléchargements parallèles** : plusieurs modèles Whisper téléchargeables
  simultanément ; si le service au premier plan est occupé, les modèles
  supplémentaires retombent automatiquement en mode wakelock
- **Thèmes** : sélecteur clair/sombre avec 4 palettes (dark, light, nord,
  solarized) ; toutes les couleurs des composants migrées vers des variables CSS
  (`vars.scss`)
- **Sélecteur de cadence** (moniteur de ressources) : boutons surdimensionnés
  remplacés par une liste de boutons radio avec des gestionnaires d'événements
  OWL nommés
- **Émoji d'Options** : icônes émoji sur tous les éléments du menu Options
- **Temps de démarrage** : affiché sur l'écran d'accueil
- **Erreurs Java** : tous les messages d'erreur de WhisperPlugin et de
  WhisperDownloadService traduits en français

### Corrigé
- Retrait du repli `fetch()` sur Android natif (causait un dépassement mémoire
  pour les modèles de plus de 200 Mo, par base64 dans la WebView)
- Fil de téléchargement du service au premier plan dupliqué à la recréation de
  l'Activity Android
- Boutons de sélection du mode de téléchargement sans effet (gestionnaire lambda
  OWL)
- Sélecteur de couleur des tags, affichage et couleurs des puces
- Visibilité des icônes et couleurs d'accentuation en thème clair
- Bouton de navigation vers le moniteur de ressources (lambda OWL)
- Visibilité des boutons noirs en thème clair

### Accessibilité
- 5 sprints d'accessibilité couvrant : l'attribut `lang` sur `<html>`, le lien
  d'évitement vers le contenu, les rôles et repères ARIA sur tous les composants
  majeurs, la prise en charge de `prefers-reduced-motion`, les régions vives,
  les rôles de dialogue, l'ARIA sur le gestionnaire de tags, les entrées de note
  (audio, photo, vidéo, géo, texte, glissement, suppression) et l'écran de
  synchronisation

## [2026.03.18.01] - 2026-03-20

### Ajouté
- Moteur de base de données SQLite avec chiffrement AES-256 (remplace
  SecureStorage)
- Protection biométrique de la clé de chiffrement de la base (sur activation)
- Système de migrations versionnées — les migrations ne s'exécutent qu'une fois
  au démarrage
- Fenêtre de notification à l'utilisateur quand une migration est effectuée
- Écran de démarrage avec progression pas à pas de l'initialisation
- Sous-pages d'Options avec navigation par fil d'Ariane
- Diagnostic de la taille de la base SQLite, avec détail par fichier
- Vidéo : lecture en surcouche HTML5 (remplace CapacitorVideoPlayer)
- Vidéo : vignette depuis la première image, mise en cache à côté du fichier
- Vidéo : migration pour rattraper les vignettes des entrées existantes
- Vidéo : ouverture automatique de la caméra à l'ajout d'une entrée
- Photo : prise en charge de la capture avec visionneuse plein écran
- Photo : ouverture automatique de la caméra à l'ajout d'une entrée
- Géolocalisation : le bouton « Ouvrir la carte » lance l'application de carte
  native

### Modifié
- Les données sont maintenant stockées en SQLite plutôt que dans SecureStorage
- La taille de la base lit les tailles réelles des fichiers par
  `Filesystem.stat()` plutôt que par PRAGMA

### Corrigé
- Écouteurs d'événements périmés à la destruction du composant de note, causant
  des entrées fantômes
- Caméra vidéo s'ouvrant automatiquement sur toutes les vues de note au lieu des
  seules nouvelles entrées
- Situation de compétition à l'ouverture de la caméra photo avant que le
  composant soit monté

## [2025.12.28.01] - 2025-12-28

### Ajouté
- Gestion des applications : ajouter, modifier et supprimer des instances Odoo
- Notes à types d'entrée multiples : texte, enregistrement audio, enregistrement
  vidéo, photo et géolocalisation
- Tags et libellés pour les notes
- Données stockées dans SecureStorage