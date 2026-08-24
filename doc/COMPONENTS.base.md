<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Components

## Hierarchy

```
RootComponent
├── ContentComponent          ← router outlet (active component per route)
├── NavbarComponent           ← bottom navigation bar
├── StatusSpinner             ← loading/saving overlay
├── IntentComponent           ← receives Android intents (sharing)
└── VideoCameraComponent      ← full-screen video capture
```

## Components by route

### HomeComponent — `/`

Home screen with a dashboard.

**Layout:**
- **Statistics bar** — count of active notes, Odoo apps, SSH servers. When deployments are running, an animated dot (`home-stats__deploy-dot`) and their number are added.
- **2×2 action grid** — Notes, New note, Servers, Odoo. Each button carries a badge with the count of the matching entity.
- **Quick notes strip** — up to 4 non-archived notes, priority 1 first then reverse chronological. Each button carries a left border coloured by priority: red (1), yellow (2), blue (3), grey (4).

Statistics and quick notes are loaded on mount through `NoteService`, `AppService` and `ServerService`.

---

### ApplicationsComponent — `/applications`
Lists and manages connections to Odoo instances.

Sub-components:
- **ApplicationsItemComponent** — a single application card
- **ApplicationsAddComponent** — add form (`/applications/add`)
- **ApplicationsEditComponent** — edit form (`/applications/edit/:url/:username`)

Notable features:
- **Odoo auto-login** — JavaScript injected into the WebView to fill the Odoo login form automatically (XPath detection, loop protection)
- **Database autocompletion** — the `database` field pre-fills from `/web/database/list` as soon as a valid URL is entered
- **Odoo version detection** — the server version is read from `/web/webclient/version_info` and shown on the card
- **Odoo model explorer** — a per-application info button that lazily loads the list of installed models, their fields and record counts through `SyncService.getOdooExplorer()` and `getOdooModelInfo()`
- **Developer mode** — access to advanced technical information (detailed version, logs)

---

### NoteListComponent — `/notes` and `/notes/edit/:id`
Note list management interface.

Features:
- Pinned / unpinned notes kept apart
- Drag and drop to reorder (through `sortablejs`)
- Archived notes filtered out
- Edit mode for bulk actions
- **Cloud sync badge** — each card shows the number of synced (✓) and failing (✗) servers, fed by `DatabaseService.getNoteSyncCounts()`

Sub-components:
- **NoteListItemComponent** — a single note card with its sync badge

---

### NoteComponent — `/note/:id`
Full note editor.

Sub-components:

| Component | Role |
|-----------|------|
| `NoteTopControlsComponent` | Title, tags, archiving, pinning, "done" state |
| `NoteContentComponent` | Displays/edits the note entries |
| `NoteBottomControlsComponent` | Entry-adding buttons (text, photo, video, audio, location, date) |
| `TagManagerComponent` | Tag management (overlay) |
| `DatePickerComponent` | Date picker (overlay) |
| `NoteEntryTextComponent` | Text entry |
| `NoteEntryPhotoComponent` | Photo entry |
| `NoteEntryVideoComponent` | Video entry (playback, recapture, transcription) |
| `NoteEntryAudioComponent` | Audio entry |
| `NoteEntryGeolocationComponent` | GPS entry (lat/lon/timestamp) |
| `NoteEntryDateComponent` | Date entry |

Notable features:
- **Multi-server sync button** — long-press the sync button to pick the target servers among the configured applications; the choice is persisted in `selected_sync_config_ids`
- **Open in app** — an "Ouvrir dans app" button that launches the WebView with auto-login and navigates straight to the matching Odoo task

#### Transcription (the "T" button)

`NoteEntryAudioComponent` and `NoteEntryVideoComponent` show a **T** button when Whisper transcription is enabled and a file is present.

- While transcribing, the button shows progress (`0%`→`100%`, or `…` while still at 0).
- Transcription state is held at the service level (`TranscriptionService`): if the user navigates away and back, the component reattaches to the running transcription through `subscribeTranscriptionProgress` / `subscribeTranscription`.
- A `↗` button appears during or after transcription to navigate to **Options › Processus**.
- For video entries, the Capacitor WebView path (`https://localhost/_capacitor_file_/…`) is converted to a native absolute path by `toNativePath()` before being handed to the Java plugin.

---

### IntentComponent — `/intent/:type`
Handles content shared from other Android applications.

Sub-components, by intent type:
- **IntentHandlerTextComponent** — shared text
- **IntentHandlerImageComponent** — shared image
- **IntentHandlerVideoComponent** — shared video

Allows creating a new note or adding the content to an existing one.

---

### ServersComponent — `/servers`

Lists and manages SSH servers.

Sub-components:
- **ServersAddComponent** — add form (`/servers/add`)
- **ServersEditComponent** — edit form (`/servers/edit/:host/:username`)
- **ServersItemComponent** — a single server card with its deployment badge

---

### ServersSettingsComponent — `/servers/:host/:username`

Server detail page. Shows the discovered workspaces and gives access to the sub-pages.

Features:
- **Start a deployment** — kicks off an ERPLibre deployment over SSH
- **Workspace management** — lists and deletes the persisted workspaces
- **Navigation** to the SSH terminal and the resource monitor
- **Running-deployment badge** — a visual indicator when a deployment is active

---

### ServersWorkspaceComponent — `/servers/:host/:username/workspace/:path`

Built-in SSH terminal and deployment logs for a given workspace.

Features:
- **Interactive SSH terminal** — sends commands through `SshPlugin`
- **Deployment logs** — shows the steps with a coloured status and a duration
- **Resume a deployment** — a button to restart from the failed step
- **Auto-scroll** — follows the latest lines automatically, can be turned off by hand
- **Up/down navigation** — shortcuts to reach the start/end of the logs
- **Breadcrumbs** — a trail back to the server list

---

### ServersDeployComponent — `/servers/:host/:username/deploy`

Progress view of the deployment currently running on a server.

---

### ServersResourcesComponent — `/servers/:host/:username/resources`

Real-time system resource monitor, fed over SSH.

Metrics shown:
- **CPU** — usage bar (user + sy + io) and load average (1/5/15 min)
- **RAM** — two-segment bar (green = used, yellow = cache/buffers) + detailed metrics
- **Swap** — usage bar and size
- **Temperatures** — lm-sensors readings, grouped by chip, coloured against the high/crit thresholds
- **Disks** — `df -hP` partitions, 🔒 badge for LUKS and LVM-over-LUKS
- **Network** — instantaneous RX/TX rate (1 s delta through `/proc/net/dev`)
- **Uptime** — how long the machine has been running
- **Users** — active sessions, counted per name

The SSH parsing functions are extracted into `src/utils/serverResourceParsers.ts` and covered by unit tests.

---

### OptionsComponent — `/options`
Application settings.

Features:
- Enable/disable biometric authentication
- **Graphic preferences** — a dedicated sub-component to choose:
  - The font family: Sans-serif, Serif, Mono
  - The font size: 5 levels from Very small to Very large (factor 0.8 to 1.3)
  - Preferences are persisted in SQLite and applied through CSS variables (`--app-font-family`, `--app-font-scale`)
- View the changelog
- Clear the cache
- Data migration history
- **ERPLibre page** (`/options/erplibre`) — project information, logo, official links
- **Error buttons in the application dialog** — copy the error message to the clipboard, open a pre-filled GitHub issue

---

### OptionsProcessesComponent — `/options/processes`

Log of transcription and model-download processes.

Features:
- Lists every `ProcessRecord` (most recent first), with an icon per type and a coloured status.
- While running: shows a spinner and the percentage when above 0.
- Clicking an item opens a **detail modal**: status, start and end timestamps, duration, error message, result (transcribed text or URL), debug panel (timestamped JSON log, green monospace style).
- **Navigation button** `›`: for a transcription, navigates to the associated note (`/note/:noteId`); for a download, navigates to `/options/transcription`.
- **Clear the history** — a confirmation, then deletion of every record through `ProcessService.clearAll()`.

---

### OptionsCodeComponent — `/options/code`

Multi-mode source code browser: walks and displays code files with syntax highlighting, Markdown rendering and image display.

#### Connection modes

| Mode | Button | Description |
|------|--------|-------------|
| **Bundle** | 💾 Bundle | The app's own sources, bundled at build time under `/repo/`. No connection required. |
| **SSH Path** | 🔑 SSH Chemin | An SSH server picked from the list, with a workspace chosen from a picker or a free-form path. |
| **SSH URL** | 🔗 SSH URL | ERPLibre manifest repos bundled at build time under `/repos/{slug}/`. Picked by chip (name + revision). |

#### Configuration panel (`code-setup`)

- **Mode picker** — 3 toggle buttons.
- **Bundle**: connects immediately to `/repo/index.json`.
- **SSH Path**:
  - Server picker (the list of registered servers).
  - Once a server is picked: a clickable list of SSH workspaces (`ServerService.getWorkspaces`), then a free-form path field with `~/` expansion.
  - A "Connecter" button.
- **SSH URL**:
  - Chips for the bundled manifest projects (name + revision), read from `/repos/manifest.json`.
  - Picking a chip connects immediately to the `/repos/{slug}/` bundle.

#### Explorer panel (`code-explorer`)

File tree: 📁/📄 icon, click to enter a directory or open a file. The current path is shown, and an "↑ Parent" button walks back up.

#### Viewer panel (`code-viewer`)

Shown when a file is opened:

| Control | Condition | Action |
|---------|-----------|--------|
| Language badge | always | Shows the detected language (python, typescript, json, scss, shell, markdown, image) |
| 🖼 Image button | image file | Toggles between hexadecimal code and an `<img>` display |
| 👁 Render button | `.md` file | Toggles between raw source and HTML rendering through `innerHTML` |
| ✎ Edit button | SSH mode only | Makes the active line editable through `writeLine()` |

**Syntax highlighting** (`src/components/options/code/syntax_highlight.ts`):

No external dependency. A character-by-character tokeniser for:
- **Python**: keywords, builtins, strings (`f/b/r/u` prefixes, triple quotes), `@` decorators, numbers, `def`/`class` names.
- **TypeScript/JS**: keywords, types (`string`, `number`…), builtins, template literals, `//` and `/* */` comments, function calls (`(` lookahead).
- **JSON**: keys (`hl-key`) vs values (`hl-str`), negative numbers, `null`/`true`/`false`.
- **SCSS**: `--css-vars`, `$variables`, `@rules`, hex colours, numbers+units.
- **Shell**: keywords, `$VAR`/`${VAR}`, strings, `#` comments.

Every colour goes through a CSS variable (`--hl-kw`, `--hl-str`, `--hl-comment`, etc.) defined in `options_code_component.scss` with Monokai-style defaults.

## The `EnhancedComponent` base class

Every component inherits from `EnhancedComponent`, which provides:
- Dependency injection (access to the services)
- Access to the `EventBus`
- Common helpers

<!-- [fr] -->
# Composants

## Hiérarchie

```
RootComponent
├── ContentComponent          ← outlet du router (composant actif selon la route)
├── NavbarComponent           ← barre de navigation inférieure
├── StatusSpinner             ← overlay chargement/sauvegarde
├── IntentComponent           ← réception des intents Android (partage)
└── VideoCameraComponent      ← capture vidéo plein écran
```

## Composants par route

### HomeComponent — `/`

Écran d'accueil avec tableau de bord.

**Disposition :**
- **Barre de statistiques** — compte de notes actives, d'apps Odoo, de serveurs SSH. Si des déploiements sont en cours, un point animé (`home-stats__deploy-dot`) et leur nombre sont ajoutés.
- **Grille 2×2 d'actions** — Notes, Nouvelle note, Serveurs, Odoo. Chaque bouton porte un badge avec le compte de l'entité correspondante.
- **Bande de notes rapides** — jusqu'à 4 notes non archivées, triées par priorité 1 en tête puis chronologie inverse. Chaque bouton porte une bordure gauche colorée selon la priorité : rouge (1), jaune (2), bleu (3), gris (4).

Les statistiques et les notes rapides sont chargées au montage via `NoteService`, `AppService` et `ServerService`.

---

### ApplicationsComponent — `/applications`
Liste et gestion des connexions aux instances Odoo.

Sous-composants :
- **ApplicationsItemComponent** — carte individuelle d'une application
- **ApplicationsAddComponent** — formulaire d'ajout (`/applications/add`)
- **ApplicationsEditComponent** — formulaire d'édition (`/applications/edit/:url/:username`)

Fonctionnalités notables :
- **Auto-login Odoo** — injection de JavaScript dans la WebView pour remplir automatiquement les champs du formulaire de connexion Odoo (détection XPath, protection anti-boucle)
- **Autocomplétion de la base de données** — le champ `database` se pré-remplit depuis `/web/database/list` dès qu'une URL valide est saisie
- **Détection de version Odoo** — la version du serveur est récupérée via `/web/webclient/version_info` et affichée sur la carte
- **Explorateur de modèles Odoo** — bouton info par application qui charge lazily la liste des modèles installés, leurs champs et le nombre d'enregistrements via `SyncService.getOdooExplorer()` et `getOdooModelInfo()`
- **Mode développeur** — accès à des informations techniques avancées (version détaillée, logs)

---

### NoteListComponent — `/notes` et `/notes/edit/:id`
Interface de gestion de la liste des notes.

Fonctionnalités :
- Séparation notes épinglées / non épinglées
- Glisser-déposer pour réordonner (via `sortablejs`)
- Filtrage des notes archivées
- Mode édition pour actions groupées
- **Badge de synchronisation cloud** — chaque carte affiche le nombre de serveurs synchronisés (✓) et en erreur (✗), alimenté par `DatabaseService.getNoteSyncCounts()`

Sous-composants :
- **NoteListItemComponent** — carte individuelle d'une note avec badge de synchro

---

### NoteComponent — `/note/:id`
Éditeur complet d'une note.

Sous-composants :

| Composant | Rôle |
|-----------|------|
| `NoteTopControlsComponent` | Titre, tags, archivage, épinglage, état "done" |
| `NoteContentComponent` | Affichage/édition des entrées de la note |
| `NoteBottomControlsComponent` | Boutons d'ajout d'entrée (texte, photo, vidéo, audio, localisation, date) |
| `TagManagerComponent` | Gestion des tags (overlay) |
| `DatePickerComponent` | Sélecteur de date (overlay) |
| `NoteEntryTextComponent` | Entrée texte |
| `NoteEntryPhotoComponent` | Entrée photo |
| `NoteEntryVideoComponent` | Entrée vidéo (lecture, recapture, transcription) |
| `NoteEntryAudioComponent` | Entrée audio |
| `NoteEntryGeolocationComponent` | Entrée GPS (lat/lon/timestamp) |
| `NoteEntryDateComponent` | Entrée date |

Fonctionnalités notables :
- **Bouton de synchro multi-serveurs** — appui long sur le bouton de sync pour choisir les serveurs cibles parmi les applications configurées ; le choix est persisté dans `selected_sync_config_ids`
- **Ouvrir dans l'app** — bouton "Ouvrir dans app" qui lance la WebView avec auto-login et navigue directement vers la tâche Odoo correspondante

#### Transcription (bouton "T")

`NoteEntryAudioComponent` et `NoteEntryVideoComponent` affichent un bouton **T** lorsque la transcription Whisper est activée et qu'un fichier est présent.

- Pendant la transcription, le bouton affiche la progression (`0%`→`100%`, ou `…` si encore à 0).
- L'état de transcription est maintenu au niveau du service (`TranscriptionService`) : si l'utilisateur navigue et revient, le composant se reconnecte à la transcription en cours via `subscribeTranscriptionProgress` / `subscribeTranscription`.
- Un bouton `↗` apparaît pendant ou après la transcription pour naviguer vers **Options › Processus**.
- Pour les entrées vidéo, le chemin Capacitor WebView (`https://localhost/_capacitor_file_/…`) est converti en chemin absolu natif par `toNativePath()` avant d'être passé au plugin Java.

---

### IntentComponent — `/intent/:type`
Gestion du contenu partagé depuis d'autres applications Android.

Sous-composants selon le type d'intent :
- **IntentHandlerTextComponent** — texte partagé
- **IntentHandlerImageComponent** — image partagée
- **IntentHandlerVideoComponent** — vidéo partagée

Permet de créer une nouvelle note ou d'ajouter le contenu à une note existante.

---

### ServersComponent — `/servers`

Liste et gestion des serveurs SSH.

Sous-composants :
- **ServersAddComponent** — formulaire d'ajout (`/servers/add`)
- **ServersEditComponent** — formulaire d'édition (`/servers/edit/:host/:username`)
- **ServersItemComponent** — carte individuelle d'un serveur avec badge de déploiement

---

### ServersSettingsComponent — `/servers/:host/:username`

Page de détail d'un serveur. Affiche les workspaces découverts et offre un accès aux sous-pages.

Fonctionnalités :
- **Lancement du déploiement** — démarre un déploiement ERPLibre via SSH
- **Gestion des workspaces** — liste et suppression des workspaces persistés
- **Navigation** vers le terminal SSH et le moniteur de ressources
- **Badge de déploiement en cours** — indicateur visuel si un déploiement est actif

---

### ServersWorkspaceComponent — `/servers/:host/:username/workspace/:path`

Terminal SSH intégré et logs de déploiement pour un workspace donné.

Fonctionnalités :
- **Terminal SSH interactif** — envoi de commandes via `SshPlugin`
- **Logs de déploiement** — affichage des étapes avec statut coloré et durée
- **Reprise de déploiement** — bouton pour relancer depuis l'étape en échec
- **Auto-scroll** — suivi automatique des dernières lignes, désactivable manuellement
- **Navigation haut/bas** — raccourcis pour atteindre le début/fin des logs
- **Breadcrumbs** — fil d'Ariane vers la liste des serveurs

---

### ServersDeployComponent — `/servers/:host/:username/deploy`

Vue de progression du déploiement en cours sur un serveur.

---

### ServersResourcesComponent — `/servers/:host/:username/resources`

Moniteur de ressources système en temps réel, alimenté via SSH.

Métriques affichées :
- **CPU** — barre d'utilisation (user + sy + io) et charge moyenne (1/5/15 min)
- **RAM** — barre double segment (vert = utilisé, jaune = cache/buffers) + métriques détaillées
- **Swap** — barre d'utilisation et taille
- **Températures** — capteurs lm-sensors, groupés par puce, colorés selon les seuils high/crit
- **Disques** — partitions `df -hP`, badge 🔒 pour LUKS et LVM-over-LUKS
- **Réseau** — vitesse RX/TX instantanée (delta sur 1 s via `/proc/net/dev`)
- **Uptime** — durée de fonctionnement
- **Utilisateurs** — sessions actives avec comptage par nom

Les fonctions de parsing SSH sont extraites dans `src/utils/serverResourceParsers.ts` et couvertes par des tests unitaires.

---

### OptionsComponent — `/options`
Paramètres de l'application.

Fonctionnalités :
- Activer/désactiver l'authentification biométrique
- **Préférences graphiques** — sous-composant dédié permettant de choisir :
  - La famille de police : Sans-sérif, Sérif, Mono
  - La taille de police : 5 niveaux de Très petit à Très grand (facteur 0.8 à 1.3)
  - Les préférences sont persistées en SQLite et appliquées via des variables CSS (`--app-font-family`, `--app-font-scale`)
- Voir le changelog
- Vider le cache
- Historique des migrations de données
- **Page ERPLibre** (`/options/erplibre`) — informations sur le projet, logo, liens officiels
- **Boutons d'erreur dans le dialogue d'application** — copier le message d'erreur dans le presse-papier, ouvrir un ticket GitHub pré-rempli

---

### OptionsProcessesComponent — `/options/processes`

Journal des processus de transcription et de téléchargement de modèle.

Fonctionnalités :
- Liste tous les enregistrements `ProcessRecord` (plus récent en tête), avec icône selon le type et statut coloré.
- Pendant l'exécution : affiche un spinner et le pourcentage si > 0.
- Clic sur un élément → **modal de détail** : statut, horodatage de démarrage et de fin, durée, message d'erreur, résultat (texte transcrit ou URL), panneau de débogage (log JSON horodaté, style monospace vert).
- **Bouton de navigation** `›` : pour une transcription, navigue vers la note associée (`/note/:noteId`) ; pour un téléchargement, navigue vers `/options/transcription`.
- **Nettoyer l'historique** — confirmation puis suppression de tous les enregistrements via `ProcessService.clearAll()`.

---

### OptionsCodeComponent — `/options/code`

Navigateur de code source multi-mode : parcourt et affiche des fichiers de code avec coloration syntaxique, rendu Markdown et affichage d'images.

#### Modes de connexion

| Mode | Bouton | Description |
|------|--------|-------------|
| **Bundle** | 💾 Bundle | Sources de l'app bundlées à la compilation dans `/repo/`. Aucune connexion requise. |
| **SSH Chemin** | 🔑 SSH Chemin | Serveur SSH sélectionné depuis la liste, workspace choisi dans un sélecteur ou chemin libre. |
| **SSH URL** | 🔗 SSH URL | Dépôts du manifeste ERPLibre bundlés à la compilation dans `/repos/{slug}/`. Sélection par chip (nom + révision). |

#### Panneau de configuration (`code-setup`)

- **Sélecteur de mode** — 3 boutons toggle.
- **Bundle** : connexion immédiate à `/repo/index.json`.
- **SSH Chemin** :
  - Sélecteur de serveur (liste des serveurs enregistrés).
  - Une fois le serveur sélectionné : liste des workspaces SSH (`ServerService.getWorkspaces`) cliquable, puis champ de chemin libre avec expansion `~/`.
  - Bouton « Connecter ».
- **SSH URL** :
  - Chips des projets du manifeste bundlés (nom + révision) lus depuis `/repos/manifest.json`.
  - Sélection d'un chip → connexion immédiate au bundle `/repos/{slug}/`.

#### Panneau explorateur (`code-explorer`)

Arborescence de fichiers : icône 📁/📄, clic pour entrer dans un dossier ou ouvrir un fichier. Chemin actuel affiché, bouton « ↑ Parent » pour remonter.

#### Panneau de visualisation (`code-viewer`)

Affiché lors de l'ouverture d'un fichier :

| Contrôle | Condition | Action |
|----------|-----------|--------|
| Badge langue | toujours | Indique la langue détectée (python, typescript, json, scss, shell, markdown, image) |
| Bouton 🖼 Image | fichier image | Bascule entre code hexadécimal et affichage `<img>` |
| Bouton 👁 Rendu | fichier `.md` | Bascule entre source brute et rendu HTML via `innerHTML` |
| Bouton ✎ Modifier | mode SSH uniquement | Rend la ligne active éditable via `writeLine()` |

**Coloration syntaxique** (`src/components/options/code/syntax_highlight.ts`) :

Sans dépendance externe. Tokeniseur caractère par caractère pour :
- **Python** : mots-clés, builtins, chaînes (préfixe `f/b/r/u`, triple quotes), décorateurs `@`, nombres, noms de `def`/`class`.
- **TypeScript/JS** : mots-clés, types (`string`, `number`…), builtins, template literals, commentaires `//` et `/* */`, appels de fonction (lookahead `(`).
- **JSON** : clés (`hl-key`) vs valeurs (`hl-str`), nombres négatifs, `null`/`true`/`false`.
- **SCSS** : `--css-vars`, `$variables`, `@rules`, couleurs hex, nombres+unités.
- **Shell** : mots-clés, `$VAR`/`${VAR}`, chaînes, commentaires `#`.

Toutes les couleurs passent par des variables CSS (`--hl-kw`, `--hl-str`, `--hl-comment`, etc.) définies dans `options_code_component.scss` avec des valeurs par défaut style Monokai.

## Classe de base `EnhancedComponent`

Tous les composants héritent d'`EnhancedComponent` qui fournit :
- Injection de dépendances (accès aux services)
- Accès à l'`EventBus`
- Helpers communs
