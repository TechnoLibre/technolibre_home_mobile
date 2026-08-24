<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Data models

## Application

```typescript
interface Application {
  url: string              // URL of the Odoo instance
  username: string         // User identifier
  password: string         // Password
  database: string         // Odoo database name (optional)
  odooVersion: string      // Detected server version (e.g. "17.0+e")
  autoSync: boolean        // Automatic synchronisation enabled
  pollIntervalMinutes: number  // Polling interval in minutes
  ntfyUrl: string          // ntfy server URL (push notifications)
  ntfyTopic: string        // ntfy topic
}
```

Composite primary key: `(url, username)`

---

## Note

```typescript
interface Note {
  id: string           // UUID v4
  title: string
  date?: string        // ISO 8601 format
  done: boolean
  archived: boolean
  pinned: boolean
  priority?: 1 | 2 | 3 | 4  // Eisenhower matrix (optional)
  tags: string[]
  entries: NoteEntry[]
}
```

### Eisenhower priority

The `priority` field stands for the four quadrants of the Eisenhower matrix:

| Value | Quadrant |
|-------|----------|
| `1` | Urgent + Important |
| `2` | Not urgent + Important |
| `3` | Urgent + Not important |
| `4` | Not urgent + Not important |

The value is `undefined` when no priority is assigned.

---

## NoteSyncInfo

Synchronisation metadata attached to every note.

```typescript
interface NoteSyncInfo {
  odooId: number | null           // ID of the matching Odoo task
  odooUrl: string | null          // URL of the source Odoo server
  syncStatus: SyncStatus          // Overall status: "local" | "pending" | "synced" | "error"
  lastSyncedAt: string | null     // ISO 8601 timestamp of the last sync
  syncConfigId: string | null     // Config identifier: "${url}|${username}"
  selectedSyncConfigIds: string[] | null  // Servers picked for multi-server sync
}
```

The per-server status is stored separately (column `sync_per_server_status`) as a JSON object
`{ [syncConfigId]: "synced" | "error" }`, to render the badge in the note list.

---

## GraphicPrefs

The user's display preferences.

```typescript
type FontFamily = "sans" | "serif" | "mono";

interface GraphicPrefs {
  fontFamily: FontFamily     // Font family
  fontSizeScale: number      // Scale factor: 0.8 | 0.9 | 1 | 1.15 | 1.3
}
```

Defaults: `fontFamily: "sans"`, `fontSizeScale: 1`.

Persisted in the SQLite table `user_graphic_prefs` (text key/value).

---

## NoteEntry

A note is made of an ordered list of entries of different types:

### Text entry

```typescript
interface NoteEntryText {
  type: 'text'
  text: string
  readonly: boolean
}
```

### Photo entry

```typescript
interface NoteEntryPhoto {
  type: 'photo'
  path: string    // Local file path
}
```

### Video entry

```typescript
interface NoteEntryVideo {
  type: 'video'
  path: string
}
```

### Audio entry

```typescript
interface NoteEntryAudio {
  type: 'audio'
  path: string
}
```

### Geolocation entry

```typescript
interface NoteEntryGeolocation {
  type: 'geolocation'
  latitude: number
  longitude: number
  timestamp: number    // Unix ms
  text?: string        // Optional label
}
```

### Date entry

```typescript
interface NoteEntryDate {
  type: 'date'
  date: string        // ISO 8601
}
```

---

## Server

Configuration of an SSH server for deployment and monitoring.

```typescript
interface Server {
  host: string                   // Host name or IP address
  port: number                   // SSH port (default 22)
  username: string               // SSH user
  authType: "password" | "key"  // Authentication mode
  password: string               // Password (when authType="password")
  privateKey: string             // PEM private key (when authType="key")
  passphrase: string             // Key passphrase (optional)
  label: string                  // Display name
  deployPath: string             // Deployment directory (default ~/erplibre)
}

type ServerID = Pick<Server, "host" | "username">
```

Composite primary key: `(host, username)`

---

## Workspace

An ERPLibre working directory deployed on a server.

```typescript
interface Workspace {
  host: string      // Parent server host
  username: string  // SSH user
  path: string      // Absolute path on the server
}
```

Composite primary key: `(host, username, path)`

---

## DeployStep / ActiveDeployment

State of a running or finished deployment, held in `DeploymentService`.

```typescript
type StepStatus = "pending" | "running" | "success" | "warning" | "error"

interface DeployStep {
  label: string
  status: StepStatus
  durationMs: number | null
  errorMessage: string | null
  logs: string[]
  autoScroll: boolean
}

interface ActiveDeployment {
  host: string
  username: string
  path: string
  server: Server
  steps: DeployStep[]
  done: boolean
  failedStepIndex: number | null
  startedAt: number    // Date.now() timestamp
}
```

---

## Android intents

```typescript
interface TextIntent {
  type: 'text'
  text: string
}

interface ImageIntent {
  type: 'image'
  path: string
}

interface VideoIntent {
  type: 'video'
  path: string
}
```

---

## ProcessRecord

Record of a transcription or model-download process, managed by `ProcessService`.

```typescript
type ProcessType   = "transcription" | "download";
type ProcessStatus = "running" | "done" | "error";

interface ProcessRecord {
  id: string;                   // Generated identifier: "${Date.now()}-${random}"
  type: ProcessType;
  status: ProcessStatus;
  label: string;                // Audio file or model name
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  noteId?: string;              // Transcription only — the note to navigate to
  model?: string;               // Download only — to navigate to /options/transcription
  percent?: number;             // Progress 0–100; not stored in the database
  result?: string;              // Transcribed text or download URL; stored in the database
  debugLog?: string[];          // Timestamped Java-level messages; not persisted across restarts
}
```

Processes still in status `"running"` when the app restarts are automatically marked `"error"` with the message `"Interrompu (redémarrage)"`.

---

## Full SQLite schema

```sql
-- Odoo applications
CREATE TABLE applications (
  url                  TEXT NOT NULL,
  username             TEXT NOT NULL,
  password             TEXT NOT NULL,
  database             TEXT NOT NULL DEFAULT '',
  auto_sync            INTEGER DEFAULT 0,
  poll_interval_minutes INTEGER DEFAULT 5,
  ntfy_url             TEXT NOT NULL DEFAULT '',
  ntfy_topic           TEXT NOT NULL DEFAULT '',
  odoo_version         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (url, username)
);

-- Enriched notes
CREATE TABLE notes (
  id                        TEXT PRIMARY KEY NOT NULL,
  title                     TEXT NOT NULL,
  date                      TEXT,
  done                      INTEGER DEFAULT 0,
  archived                  INTEGER DEFAULT 0,
  pinned                    INTEGER DEFAULT 0,
  tags                      TEXT DEFAULT '[]',
  entries                   TEXT DEFAULT '[]',
  -- Synchronisation columns (added by migration)
  odoo_id                   INTEGER,
  odoo_url                  TEXT,
  sync_status               TEXT DEFAULT 'local',
  last_synced_at            TEXT,
  sync_config_id            TEXT,
  selected_sync_config_ids  TEXT,     -- JSON array of syncConfigId
  sync_per_server_status    TEXT      -- JSON object { syncConfigId: "synced"|"error" }
);

-- User graphic preferences (key/value)
CREATE TABLE user_graphic_prefs (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- SSH servers
CREATE TABLE servers (
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL DEFAULT 22,
  username     TEXT NOT NULL,
  auth_type    TEXT NOT NULL DEFAULT 'password',
  password     TEXT NOT NULL DEFAULT '',
  private_key  TEXT NOT NULL DEFAULT '',
  passphrase   TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  deploy_path  TEXT NOT NULL DEFAULT '~/erplibre',
  PRIMARY KEY (host, username)
);

-- Deployed working directories
CREATE TABLE server_workspaces (
  host     TEXT NOT NULL,
  username TEXT NOT NULL,
  path     TEXT NOT NULL,
  PRIMARY KEY (host, username, path)
);

-- Reminders
CREATE TABLE reminders (
  id         TEXT PRIMARY KEY NOT NULL,
  note_id    TEXT NOT NULL,
  trigger_at TEXT NOT NULL,
  created_at TEXT
);

-- Process log (transcriptions and model downloads)
-- started_at and completed_at are Unix timestamps in milliseconds (INTEGER).
-- debug_log is a JSON array of timestamped strings, or NULL when there is no log.
CREATE TABLE processes (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,              -- "transcription" | "download"
  status        TEXT NOT NULL DEFAULT 'running',  -- "running" | "done" | "error"
  label         TEXT NOT NULL DEFAULT '',   -- file or model name
  started_at    INTEGER NOT NULL,           -- Unix ms
  completed_at  INTEGER,                    -- Unix ms, NULL while unfinished
  error_message TEXT,
  note_id       TEXT,                       -- transcription: the associated note
  model         TEXT,                       -- download: the model name
  result        TEXT,                       -- transcribed text or download URL
  debug_log     TEXT                        -- JSON array of timestamped messages
);
```

> The `tags`, `entries`, `selected_sync_config_ids` and `sync_per_server_status` columns hold serialised JSON. The conversion is handled by `DatabaseService`.

### `processes` migrations

| Migration | Description |
|-----------|-------------|
| `addProcessesTable` | Creates the `processes` table with every base column except `result` and `debug_log`. |
| `addProcessResultColumn` | Adds `result TEXT` (idempotent). |
| `addProcessDebugLogColumn` | Adds `debug_log TEXT` (idempotent). |

<!-- [fr] -->
# Modèles de données

## Application

```typescript
interface Application {
  url: string              // URL de l'instance Odoo
  username: string         // Identifiant utilisateur
  password: string         // Mot de passe
  database: string         // Nom de la base de données Odoo (optionnel)
  odooVersion: string      // Version détectée du serveur (ex: "17.0+e")
  autoSync: boolean        // Synchronisation automatique activée
  pollIntervalMinutes: number  // Intervalle de polling en minutes
  ntfyUrl: string          // URL du serveur ntfy (notifications push)
  ntfyTopic: string        // Topic ntfy
}
```

Clé primaire composite : `(url, username)`

---

## Note

```typescript
interface Note {
  id: string           // UUID v4
  title: string
  date?: string        // Format ISO 8601
  done: boolean
  archived: boolean
  pinned: boolean
  priority?: 1 | 2 | 3 | 4  // Matrice d'Eisenhower (optionnel)
  tags: string[]
  entries: NoteEntry[]
}
```

### Priorité Eisenhower

Le champ `priority` représente les quatre quadrants de la matrice d'Eisenhower :

| Valeur | Quadrant |
|--------|----------|
| `1` | Urgent + Important |
| `2` | Non urgent + Important |
| `3` | Urgent + Non important |
| `4` | Non urgent + Non important |

La valeur est `undefined` si aucune priorité n'est assignée.

---

## NoteSyncInfo

Métadonnées de synchronisation attachées à chaque note.

```typescript
interface NoteSyncInfo {
  odooId: number | null           // ID de la tâche Odoo correspondante
  odooUrl: string | null          // URL du serveur Odoo source
  syncStatus: SyncStatus          // Statut global : "local" | "pending" | "synced" | "error"
  lastSyncedAt: string | null     // Horodatage ISO 8601 de la dernière synchro
  syncConfigId: string | null     // Identifiant de config : "${url}|${username}"
  selectedSyncConfigIds: string[] | null  // Serveurs sélectionnés pour la synchro multi-serveurs
}
```

Le statut par serveur est stocké séparément (colonne `sync_per_server_status`) comme un objet JSON
`{ [syncConfigId]: "synced" | "error" }` pour afficher le badge dans la liste des notes.

---

## GraphicPrefs

Préférences d'affichage de l'utilisateur.

```typescript
type FontFamily = "sans" | "serif" | "mono";

interface GraphicPrefs {
  fontFamily: FontFamily     // Famille de police
  fontSizeScale: number      // Facteur d'échelle : 0.8 | 0.9 | 1 | 1.15 | 1.3
}
```

Valeurs par défaut : `fontFamily: "sans"`, `fontSizeScale: 1`.

Persistées dans la table SQLite `user_graphic_prefs` (clé/valeur texte).

---

## NoteEntry

Une note est composée d'une liste ordonnée d'entrées de types différents :

### Entrée texte

```typescript
interface NoteEntryText {
  type: 'text'
  text: string
  readonly: boolean
}
```

### Entrée photo

```typescript
interface NoteEntryPhoto {
  type: 'photo'
  path: string    // Chemin fichier local
}
```

### Entrée vidéo

```typescript
interface NoteEntryVideo {
  type: 'video'
  path: string
}
```

### Entrée audio

```typescript
interface NoteEntryAudio {
  type: 'audio'
  path: string
}
```

### Entrée géolocalisation

```typescript
interface NoteEntryGeolocation {
  type: 'geolocation'
  latitude: number
  longitude: number
  timestamp: number    // Unix ms
  text?: string        // Label optionnel
}
```

### Entrée date

```typescript
interface NoteEntryDate {
  type: 'date'
  date: string        // ISO 8601
}
```

---

## Server

Configuration d'un serveur SSH pour le déploiement et la supervision.

```typescript
interface Server {
  host: string                   // Nom d'hôte ou adresse IP
  port: number                   // Port SSH (défaut 22)
  username: string               // Utilisateur SSH
  authType: "password" | "key"  // Mode d'authentification
  password: string               // Mot de passe (si authType="password")
  privateKey: string             // Clé privée PEM (si authType="key")
  passphrase: string             // Passphrase de la clé (optionnel)
  label: string                  // Nom d'affichage
  deployPath: string             // Répertoire de déploiement (défaut ~/erplibre)
}

type ServerID = Pick<Server, "host" | "username">
```

Clé primaire composite : `(host, username)`

---

## Workspace

Répertoire de travail ERPLibre déployé sur un serveur.

```typescript
interface Workspace {
  host: string      // Hôte du serveur parent
  username: string  // Utilisateur SSH
  path: string      // Chemin absolu sur le serveur
}
```

Clé primaire composite : `(host, username, path)`

---

## DeployStep / ActiveDeployment

État d'un déploiement en cours ou terminé, stocké dans `DeploymentService`.

```typescript
type StepStatus = "pending" | "running" | "success" | "warning" | "error"

interface DeployStep {
  label: string
  status: StepStatus
  durationMs: number | null
  errorMessage: string | null
  logs: string[]
  autoScroll: boolean
}

interface ActiveDeployment {
  host: string
  username: string
  path: string
  server: Server
  steps: DeployStep[]
  done: boolean
  failedStepIndex: number | null
  startedAt: number    // Date.now() timestamp
}
```

---

## Intents Android

```typescript
interface TextIntent {
  type: 'text'
  text: string
}

interface ImageIntent {
  type: 'image'
  path: string
}

interface VideoIntent {
  type: 'video'
  path: string
}
```

---

## ProcessRecord

Enregistrement d'un processus de transcription ou de téléchargement de modèle, géré par `ProcessService`.

```typescript
type ProcessType   = "transcription" | "download";
type ProcessStatus = "running" | "done" | "error";

interface ProcessRecord {
  id: string;                   // Identifiant généré : "${Date.now()}-${random}"
  type: ProcessType;
  status: ProcessStatus;
  label: string;                // Nom du fichier audio ou du modèle
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  noteId?: string;              // Transcription uniquement — note à naviguer
  model?: string;               // Téléchargement uniquement — pour naviguer vers /options/transcription
  percent?: number;             // Progression 0–100 ; non stocké en base
  result?: string;              // Texte transcrit ou URL de téléchargement ; stocké en base
  debugLog?: string[];          // Messages horodatés Java-level ; non persistés entre redémarrages
}
```

Les processus encore en statut `"running"` lors du redémarrage de l'app sont automatiquement marqués `"error"` avec le message `"Interrompu (redémarrage)"`.

---

## Schéma SQLite complet

```sql
-- Applications Odoo
CREATE TABLE applications (
  url                  TEXT NOT NULL,
  username             TEXT NOT NULL,
  password             TEXT NOT NULL,
  database             TEXT NOT NULL DEFAULT '',
  auto_sync            INTEGER DEFAULT 0,
  poll_interval_minutes INTEGER DEFAULT 5,
  ntfy_url             TEXT NOT NULL DEFAULT '',
  ntfy_topic           TEXT NOT NULL DEFAULT '',
  odoo_version         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (url, username)
);

-- Notes enrichies
CREATE TABLE notes (
  id                        TEXT PRIMARY KEY NOT NULL,
  title                     TEXT NOT NULL,
  date                      TEXT,
  done                      INTEGER DEFAULT 0,
  archived                  INTEGER DEFAULT 0,
  pinned                    INTEGER DEFAULT 0,
  tags                      TEXT DEFAULT '[]',
  entries                   TEXT DEFAULT '[]',
  -- Colonnes de synchronisation (ajoutées par migration)
  odoo_id                   INTEGER,
  odoo_url                  TEXT,
  sync_status               TEXT DEFAULT 'local',
  last_synced_at            TEXT,
  sync_config_id            TEXT,
  selected_sync_config_ids  TEXT,     -- JSON array de syncConfigId
  sync_per_server_status    TEXT      -- JSON object { syncConfigId: "synced"|"error" }
);

-- Préférences graphiques utilisateur (clé/valeur)
CREATE TABLE user_graphic_prefs (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- Serveurs SSH
CREATE TABLE servers (
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL DEFAULT 22,
  username     TEXT NOT NULL,
  auth_type    TEXT NOT NULL DEFAULT 'password',
  password     TEXT NOT NULL DEFAULT '',
  private_key  TEXT NOT NULL DEFAULT '',
  passphrase   TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  deploy_path  TEXT NOT NULL DEFAULT '~/erplibre',
  PRIMARY KEY (host, username)
);

-- Répertoires de travail déployés
CREATE TABLE server_workspaces (
  host     TEXT NOT NULL,
  username TEXT NOT NULL,
  path     TEXT NOT NULL,
  PRIMARY KEY (host, username, path)
);

-- Rappels
CREATE TABLE reminders (
  id         TEXT PRIMARY KEY NOT NULL,
  note_id    TEXT NOT NULL,
  trigger_at TEXT NOT NULL,
  created_at TEXT
);

-- Journal des processus (transcriptions et téléchargements de modèles)
-- started_at et completed_at sont des timestamps Unix en millisecondes (INTEGER).
-- debug_log est un tableau JSON de chaînes horodatées, ou NULL si aucun log.
CREATE TABLE processes (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,              -- "transcription" | "download"
  status        TEXT NOT NULL DEFAULT 'running',  -- "running" | "done" | "error"
  label         TEXT NOT NULL DEFAULT '',   -- nom de fichier ou du modèle
  started_at    INTEGER NOT NULL,           -- Unix ms
  completed_at  INTEGER,                    -- Unix ms, NULL si non terminé
  error_message TEXT,
  note_id       TEXT,                       -- transcription : note associée
  model         TEXT,                       -- téléchargement : nom du modèle
  result        TEXT,                       -- texte transcrit ou URL de téléchargement
  debug_log     TEXT                        -- JSON array de messages horodatés
);
```

> Les colonnes `tags`, `entries`, `selected_sync_config_ids` et `sync_per_server_status` stockent du JSON sérialisé. La conversion est gérée par `DatabaseService`.

### Migrations `processes`

| Migration | Description |
|-----------|-------------|
| `addProcessesTable` | Crée la table `processes` avec toutes les colonnes de base sauf `result` et `debug_log`. |
| `addProcessResultColumn` | Ajoute `result TEXT` (idempotente). |
| `addProcessDebugLogColumn` | Ajoute `debug_log TEXT` (idempotente). |
