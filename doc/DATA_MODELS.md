
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
