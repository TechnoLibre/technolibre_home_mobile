
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
