
# Services

## Overview

```
AppService           → Odoo application CRUD
NoteService
  ├── NoteCrudSubservice      → note CRUD
  ├── NoteEntrySubservice     → note entry factory
  └── NoteIntentSubservice    → note creation from an intent
DatabaseService      → SQLite abstraction
SyncService          → two-way Odoo synchronisation
IntentService        → listens to and parses Android intents
ServerService        → SSH server + workspace CRUD
DeploymentService    → background SSH deployment (reactive state)
TagService           → hierarchical tag CRUD with an in-memory cache
TranscriptionService → on-device audio/video transcription (Whisper)
ProcessService       → persistent log of transcriptions and downloads
CodeService          → source code navigation over SSH (listDir, readFile, git)
BundleCodeService    → offline reading of the code bundled at build time
```

## AppService (`src/services/appService.ts`)

Manages the connections to Odoo instances.

**Methods:**
- Create, read, update, delete an application
- Look up by URL + username

**Errors:**
- `AppAlreadyExistsError` — duplicate (url + username)
- `AppKeyNotFoundError` — application not found
- `NoAppMatchError` — no match

---

## DatabaseService (`src/services/databaseService.ts`)

Abstraction over the SQLite database through the `@capacitor-community/sqlite` plugin.

**Database:** `erplibre_mobile` — AES-256 encrypted (SQLCipher)

### Initialisation (`initialize(onStep?)`)

The method takes an optional callback to report each step (used by the boot screen):

1. Retrieve or generate the encryption key (SecureStorage)
2. `setEncryptionSecret` — called **only** when the key has just been created (first install)
3. `checkConnectionsConsistency` + `isConnection` — decides whether the connection already exists
4. `retrieveConnection` or `createConnection`, depending on the result
5. `open()` + table creation

### Encryption key

Generated with `crypto.getRandomValues` (256 bits / 64 hex) on first install, then persisted in `capacitor-secure-storage-plugin` under the key `db_encryption_key`. Later startups reuse the existing key without calling `setEncryptionSecret` again.

### Main methods

| Method | Description |
|--------|-------------|
| `initialize()` | Initialises the SQLite connection and creates the base tables |
| `getAllApplications()` | Lists every application |
| `addApplication(app)` | Adds an application |
| `updateApplication(url, username, app)` | Updates an application |
| `deleteApplication(url, username)` | Deletes an application |
| `setApplicationOdooVersion(url, username, version)` | Persists the detected Odoo version |
| `getAllNotes()` | Lists every note |
| `addNote(note)` | Adds a note |
| `updateNote(id, note)` | Updates a note |
| `deleteNote(id)` | Deletes a note |
| `getNoteById(id)` | Returns a note by ID, or `null` |
| `getNoteSyncInfo(id)` | Returns the sync metadata of a note |
| `setNoteSyncInfo(id, info)` | Partially updates the sync metadata |
| `getNotesByOdooUrl(url)` | Notes synced with a given Odoo server |
| `getNotesBySyncConfigId(configId)` | Notes bound to a sync configuration |
| `setNotePerServerStatus(id, configId, status)` | Per-server sync status |
| `getNoteSyncCounts()` | Aggregates the synced/error counters per note |
| `getUserGraphicPref(key)` | Reads a graphic preference |
| `setUserGraphicPref(key, value)` | Persists a graphic preference |

### Schema migrations

| Method | Description |
|--------|-------------|
| `addSyncColumnsToNotes()` | Adds the `odoo_id`, `odoo_url`, `sync_status` and `last_synced_at` columns |
| `addSyncConfigIdColumn()` | Adds the `sync_config_id` column |
| `addSelectedSyncConfigIdsColumn()` | Adds the `selected_sync_config_ids` column |
| `addSyncPerServerStatusColumn()` | Adds the `sync_per_server_status` column |
| `addOdooVersionToApplications()` | Adds the `odoo_version` column to `applications` |
| `createUserGraphicPrefsTable()` | Creates the `user_graphic_prefs` table |

Every migration is idempotent (skipped when the column/table already exists).

---

## SyncService (`src/services/syncService.ts`)

Two-way synchronisation between the local notes and Odoo's `project.task` records.
Uses JSON-RPC through the internal `rawPost()` method (see below).

### Authentication

```typescript
authenticate(creds: SyncCredentials): Promise<{ sessionId: string; odooMajorVersion: number }>
```

- Calls `/web/dataset/call_kw` with `res.users.authenticate`
- Stores the session in SecureStorage under `odoo_sync_session_${btoa(url|username)}`
- Reads `odooMajorVersion` from `server_version_info[0]`
- Throws when `uid` is falsy or when the response carries an `error` field

### Push

```typescript
pushNote(creds: SyncCredentials, noteId: string): Promise<void>
```

- Looks the note up in the database; throws `"Note not found"` when absent
- When `odoo_id` already exists → `project.task.write`; otherwise → `project.task.create`
- Converts: `pinned` → `priority` (`"1"`/`"0"`), `done` → `state` (`"done"`/`"in_progress"`)
- Updates `sync_status`, `odoo_id`, `odoo_url` and `last_synced_at` on success

### Pull

```typescript
pullNotes(creds: SyncCredentials, since: Date): Promise<number>
```

- Fetches the tasks modified since `since` through `search_read`
- For each task, finds the local note by `odoo_id` + `odoo_url`
- Updates `title`, `pinned`, `archived`, `done` (`done` on version 17+ only)
- Returns the number of notes updated

### Full synchronisation

```typescript
syncAll(creds: SyncCredentials, syncConfigId?: string): Promise<{ pushed: number; pulled: number; errors: string[] }>
```

- Pushes every `pending` note (filtered by `syncConfigId` when given)
- Then pulls every remote change
- Individual errors are captured and do not break the loop

### Polling

```typescript
pollForChanges(creds: SyncCredentials, since: Date): Promise<number[]>
```

- Returns the Odoo IDs of the tasks modified since `since`

### Server discovery

| Method | Description |
|--------|-------------|
| `listDatabases(url)` | Lists the available databases through `/web/database/list` |
| `getServerVersion(url)` | Odoo version through `/web/webclient/version_info`; returns `null` when unavailable |
| `getOdooExplorer(creds)` | Returns the version and the list of installed models (`ir.model`) |
| `getOdooModelInfo(creds, model)` | Fields and record count of a model through `ir.model.fields` |

### HTML construction

```typescript
buildHtml(entries: NoteEntry[]): string
```

Turns the entries of a note into HTML for the trip to Odoo:
- `text` → `<p>` (HTML characters escaped, empty entries skipped)
- `date` → a paragraph with the 📅 emoji
- `geolocation` → a paragraph with the 📍 emoji + coordinates
- `audio/photo/video` → an emoji line (🎙️/📷/🎥)

```typescript
buildGeoMultiPoint(entries: NoteEntry[]): string | null
```

Builds a GeoJSON `MultiPoint` (`[longitude, latitude]` order) from the geolocation entries. Returns `null` when there are none.

### HTTP transport (`rawPost`)

A private method used by every network call in `SyncService`.

- **On native Android**: uses `RawHttpPlugin`, which bypasses Android's `CookieHandler`. That preserves the `Cookie` headers on plain HTTP connections (local IP addresses), which the Android system would otherwise strip.
- **When `RawHttpPlugin` is absent** (an old APK, an unsynced build): throws an explicit error — the `fetch()` fallback is not used on native, because the Android WebView blocks cross-origin requests to Odoo servers that carry no CORS header.
- **On the web (dev mode)**: `fetch()` is used directly (no CORS restriction in that context).

---

## MigrationService (`src/services/migrationService.ts`)

A runner for versioned data migrations.

**Usage:**

```typescript
await runMigrations(db, [
  {
    version: 20260318,
    description: "Migration de SecureStorage vers SQLite",
    run: migrateFromSecureStorage,
  },
]);
```

- Migrations that already ran are skipped (versioning through SecureStorage)
- Every migration returns a `MigrationResult` with the `migrated` / `skipped` counts per entity and the execution time
- The history is persisted in SecureStorage and can be read from **Options → Historique des migrations**

---

## DataMigration (`src/services/dataMigration.ts`)

Migration v1: moves the data from SecureStorage (JSON format) into the encrypted SQLite database.

Entities migrated: `applications`, `notes`.

---

## NoteService (`src/services/note/noteService.ts`)

The main entry point for note management. Delegates to three sub-services.

### NoteCrudSubservice
- Create, read (by ID, all), update, delete
- UUID v4 validation of the identifiers
- Collects the unique tags across every note

**Errors:**
- `NoNoteMatchError` — note not found
- `NoteKeyNotFoundError` — missing key

### NoteEntrySubservice
A factory for `NoteEntry` objects, by type:

| Method | Type created |
|--------|--------------|
| `createTextEntry()` | `text` |
| `createPhotoEntry(path)` | `photo` |
| `createVideoEntry(path)` | `video` |
| `createAudioEntry(path)` | `audio` |
| `createGeolocationEntry(lat, lon)` | `geolocation` |
| `createDateEntry(date)` | `date` |

**Errors:**
- `NoNoteEntryMatchError` — entry not found

### NoteIntentSubservice
Creates notes from an Android intent:
- Turns `TextIntent`, `ImageIntent` and `VideoIntent` into a note with the matching entries

---

## IntentService (`src/services/intentService.ts`)

Listens to implicit Android intents (the `SEND` action).

**MIME types handled:**

| MIME | Model created |
|------|---------------|
| `text/plain` | `TextIntent` |
| `image/*` | `ImageIntent` |
| `video/*` | `VideoIntent` |

Triggers a navigation to `/intent/:type` through the `EventBus`.

---

---

## ServerService (`src/services/serverService.ts`)

Manages SSH servers and their deployed workspaces.

**Methods:**

| Method | Description |
|--------|-------------|
| `getServers()` | Lists every server |
| `add(server)` | Adds a server |
| `delete(serverID)` | Deletes a server by `(host, username)` |
| `edit(serverID, newServer, options?)` | Updates a server; `ignoreCredential: true` keeps the existing password / key |
| `matches(serverID)` | Returns the servers matching `(host, username)` |
| `getMatch(serverID)` | Returns the matching server, or throws `NoServerMatchError` |
| `getWorkspaces(serverID)` | Lists a server's workspaces |
| `addWorkspace(workspace)` | Adds a workspace (duplicates ignored) |
| `deleteWorkspace(workspace)` | Deletes a workspace |
| `workspaceExists(workspace)` | Checks whether a workspace exists |

**Errors:**
- `ServerAlreadyExistsError` — duplicate `(host, username)`
- `NoServerMatchError` — server not found

---

## DeploymentService (`src/services/deploymentService.ts`)

Orchestrates the ERPLibre deployment over SSH. Keeps a reactive registry (Owl `reactive`) of the running or finished deployments, reachable from any component.

### Reactive registry

```typescript
readonly deployments: ActiveDeployment[]  // liste réactive Owl
```

Components that read `deployments` while rendering re-render automatically on updates (a deployment added or removed, a step progressing).

### Main methods

| Method | Description |
|--------|-------------|
| `create(server, path)` | Creates a reactive `ActiveDeployment` with 3 `pending` steps. Replaces an existing deployment on the same `(host, username, path)`. |
| `find(host, username, path)` | Looks a deployment up by composite key. |
| `getAllForServer(host, username)` | Returns every deployment of a given server. |
| `dismiss(host, username, path)` | Removes the deployment from the registry and drops the active SSH listener. |
| `run(dep, fromStep)` | Starts (or restarts from `fromStep`) the deployment in the background. |

### Deployment steps

| Index | Step | SSH command |
|-------|------|-------------|
| 0 | SSH connection | `SshPlugin.connect(...)` |
| 1 | Repository clone | `test -d <path>` → `git clone` or cd |
| 2 | Installation | `make install` |

Every step goes `pending → running → success/warning/error`. Logs accumulate in `step.logs[]` even with no component mounted. At the end of a complete, error-free deployment, the workspace is persisted through `ServerService.addWorkspace()`.

---

## Utilities

### BiometryUtils (`src/utils/biometryUtils.ts`)

| Method | Description |
|--------|-------------|
| `isBiometryAvailable()` | Returns `true` when the device has a biometric sensor |
| `isEnabledByUser()` | Returns `true` only when the user explicitly enabled biometrics |
| `authenticateForDatabase()` | The biometric gate for the SQLite key: a native prompt when enabled and available, otherwise `true` straight away |
| `authenticateIfAvailable()` | A generic biometric gate for app access |
| `authenticate(errorAlertOptions?)` | The raw native prompt, returns `true`/`false` |

### WebViewUtils
- Open a URL in the WebView
- Injection of the Odoo auto-login script

### StorageUtils
- Persistent key/value storage through SecureStorage (Android Keystore / iOS Keychain)
- `getValueByKey<T>(key)` — returns `{ keyExists, value, isValid }`
- `setKeyValuePair(key, value)` — serialises to JSON

### ServerResourceParsers (`src/utils/serverResourceParsers.ts`)

Pure functions that format and parse the raw SSH output for the server resource monitor. Every function is exported and covered by unit tests.

**Formatting:**

| Function | Description |
|----------|-------------|
| `fmtKb(kb)` | Formats kilobytes → `"512 KB"`, `"128 MB"`, `"8.0 GB"` |
| `fmtSpeed(bps)` | Formats bytes/s → `"1.5 KB/s"`, `"10.00 MB/s"` |
| `fmtUptime(secs)` | Formats seconds → `"2j 3h 15min"` |

**Parsing:**

| Function | SSH source | Returns |
|----------|-----------|---------|
| `parseMem(lines)` | `/proc/meminfo` | `MemInfo` (total, used, cached, swap) |
| `parseCpu(line)` | `top -bn1` | `CpuInfo` (us, sy, wa, id) or `null` |
| `parseLoad(line)` | `/proc/loadavg` | `{ l1, l5, l15 }` or `null` |
| `parseCryptMounts(lines)` | `lsblk` + a `dmsetup` loop | `Set<string>` of the encrypted mount points |
| `parseDisk(lines, cryptMounts)` | `df -hP` | `DiskPartition[]` with an `encrypted` flag |
| `parseNet(lines1, lines2)` | `/proc/net/dev` (×2) | `NetInfo` (rx/tx bytes/s) or `null` |
| `parseUptime(line)` | `/proc/uptime` | Seconds (`number`) or `null` |
| `parseUsers(line)` | `users` | `UserCount[]` sorted alphabetically |
| `parseSensors(lines)` | `sensors` (lm-sensors) | `TempSensor[]` grouped by chip |

### StorageConstants

| Key | Use |
|-----|-----|
| `applications` | (legacy, migrated) the list of Odoo apps |
| `notes` | (legacy, migrated) the list of notes |
| `biometry_enabled` | The user's biometric preference (`boolean`) |
| `db_encryption_key` | The AES-256 SQLite encryption key (64 hex) |

---

## ProcessService (`src/services/processService.ts`)

Persistent log of transcription and model-download operations. Records are stored in the SQLite `processes` table and survive app restarts.

### Initialisation

```typescript
await processService.initialize();
```

Must be called once after the DB migrations have run. Marks any process still flagged `"running"` as `"error"` (interrupted by app kill), then loads the full history into memory.

### Main methods

| Method | Description |
|--------|-------------|
| `getAll()` | Every record, newest first. |
| `subscribe(cb)` | Subscribe to list changes (added, completed, failed). Returns an unsubscribe function. |
| `addTranscription(label, noteId?)` | Creates a `type: "transcription"` record in status `"running"`. Returns the generated `id`. |
| `addDownload(model, url?)` | Creates a `type: "download"` record in status `"running"`. Returns the `id`. |
| `updateProgress(id, percent)` | Updates the in-memory progress (0–100). No SQL write — the field is transient. |
| `appendDebugLog(id, message)` | Appends a timestamped message (`HH:mm:ss.mmm  message`) to the in-memory debug log. |
| `completeProcess(id, errorMessage?, result?)` | Moves the status to `"done"` or `"error"` and persists the result and the debug log to the database. |
| `clearAll()` | Deletes every record from memory and from the database. |

### Relationship with TranscriptionService

`TranscriptionService` is handed an optional reference to `ProcessService` at construction. It calls `addTranscription` / `addDownload` at the start of every operation, `updateProgress` on every Whisper progress event, `appendDebugLog` for Java-level events, and `completeProcess` at the end.

---

## TagService (`src/services/tagService.ts`)

CRUD for hierarchical tags (parent → children). Keeps an in-memory cache
(`_cache: Tag[] | null`) to avoid repeated SQL reads inside OWL components.

### The `Tag` model

```typescript
interface Tag {
    id:       string;    // UUID v4 généré par getNewId()
    name:     string;    // nom affiché
    color:    string;    // couleur hex ex: "#6b7280"
    parentId?: string;  // undefined = tag racine
}
```

Tags are persisted in the SQLite `tags` table. The hierarchy is a plain tree
(one level of parenthood per row, arbitrary depth through a BFS traversal).

### Main methods

| Method | Description |
|--------|-------------|
| `getAllTags()` | Loads every tag from the DB and refreshes the cache. |
| `getCached()` | Returns the cache synchronously (an empty array when not loaded yet). |
| `invalidateCache()` | Empties the cache — the next `getAllTags()` re-reads the DB. |
| `getRootTags()` | Tags with no `parentId` (root level). |
| `getChildTags(parentId)` | The direct children of a tag. |
| `getTagsByIds(ids)` | Filters the tags by a list of IDs. |
| `getTagById(id)` | Returns the matching tag, or `null`. |
| `addTag(tag)` | Inserts into the DB and invalidates the cache. |
| `updateTag(id, tag)` | Updates the DB and invalidates the cache. |
| `deleteTag(id)` | Deletes from the DB and invalidates the cache. |
| `getAllDescendantIds(tagId)` | Recursive BFS — returns every descendant ID (children, grandchildren, …). |
| `getNewId()` | Generates a UUID v4. |

### Usage pattern inside an OWL component

```typescript
// onMounted — charge le cache une fois
const tags = await this.tagService.getAllTags();

// Template — lecture synchrone (pas d'await, pas de re-render)
const names = entry.tagIds.map(id =>
    this.tagService.getCached().find(t => t.id === id)?.name ?? id
);

// Après mutation
await this.tagService.addTag(newTag);
this.tagService.invalidateCache();   // ou laissez addTag() l'invalider automatiquement
```

---

## TranscriptionService (`src/services/transcriptionService.ts`)

On-device audio transcription through **whisper.cpp** / GGML.
The model runs entirely on the device — no external server, no subscription.

### Available models

| Key | Size | Description |
|-----|------|-------------|
| `tiny` | ~75 MB | Very fast, accuracy fine for clear French |
| `base` | ~142 MB | Recommended (speed / accuracy trade-off) |
| `small` | ~244 MB | Accurate |
| `medium` | ~769 MB | Very accurate |
| `large-v3-turbo` | ~874 MB | The best multilingual model |
| `distil-large-v3` | ~756 MB | English only |

The GGML binaries are downloaded from HuggingFace (`ggerganov/whisper.cpp`) and stored in `{filesDir}/whisper/ggml-<model>.bin`.

### Configuration settings

Persisted in the SQLite `user_graphic_prefs` table:

| SQLite key | Methods | Default |
|------------|---------|---------|
| `whisper_enabled` | `isEnabled()` / `setEnabled(bool)` | `false` |
| `whisper_model` | `getSelectedModel()` / `setSelectedModel(model)` | `"tiny"` |
| `whisper_download_mode` | `getDownloadMode()` / `setDownloadMode(mode)` | `"wakelock"` |

### Download state

The service keeps a `Map<WhisperModel, DownloadProgress>` (`_activeDownloads`) that
survives component re-mounts. Components subscribe through `subscribeProgress()` and
reattach to the existing state in `onMounted`.

```typescript
interface DownloadProgress {
    model:            WhisperModel;
    percent:          number;          // 0–100
    mode:             "wakelock" | "foreground";
    receivedBytes:    number;
    totalBytes:       number;
    speedBytesPerSec: number;
}
```

### Download modes

| Mode | Mechanism | Advantage |
|------|-----------|-----------|
| `"wakelock"` | A Java thread + `PowerManager.PARTIAL_WAKE_LOCK` | Parallel downloads; `.partial` resume |
| `"foreground"` | An Android Foreground Service | A visible OS notification; recommended above 1 GB |

When `"foreground"` is asked for while the service is already busy with **another** model,
`downloadModel()` silently falls back to `"wakelock"`.

### Main methods

| Method | Description |
|--------|-------------|
| `isEnabled()` | Returns `true` when transcription is enabled |
| `setEnabled(enabled)` | Enables or disables transcription |
| `getSelectedModel()` | Returns the selected model; falls back to `"tiny"` for an unknown value |
| `setSelectedModel(model)` | Persists the model choice |
| `getDownloadMode()` / `setDownloadMode(mode)` | Download mode (`"wakelock"` or `"foreground"`) |
| `isModelDownloaded(model)` | `true` when the `.bin` is present and no download is running for that model |
| `downloadModel(model, mode?)` | Starts the model download in the chosen mode; automatic wakelock fallback when foreground is busy |
| `cancelDownload(model?)` | Cancels the download of the named model, or every one when omitted |
| `deleteModel(model)` | Deletes the `.bin` and the `.partial` from disk |
| `subscribeProgress(cb)` | Subscribes to progress updates. `cb(info, model)` — `info` is `null` at the end. Returns an unsubscribe function. |
| `activeDownloads` | `ReadonlyMap<WhisperModel, DownloadProgress>` — every running download. |
| `activeDownload` | The first active download, or `null` (backward compatibility). |
| `maybeReconnectForeground()` | Calls `getServiceStatus()` and reattaches to the Foreground Service when it is running but untracked (after the Activity was recreated). |
| `transcribe(audioPath, lang?, noteId?, rawPath?)` | Transcribes an audio/video recording; throws when called outside Android |

### Reconnecting after the Activity is recreated

When Android recreates the Activity (rotation, return from the background), the JS state is
lost but the Foreground Service keeps running. `onMounted` in the components calls
`maybeReconnectForeground()`, which:

1. Checks `WhisperDownloadService.downloading` (a static Java field) through `getServiceStatus()`.
2. When a download is running, fires `downloadModel(model, "foreground")` and forgets it.
3. Java sees `downloading == true && model == currentModel` → updates `pendingForegroundCallId` without starting a second thread.

### Transcription flow

```
transcribe(audioPath)
  └── isNativePlatform() ?
        ├── non  → throw "La transcription n'est disponible que sur Android."
        └── oui  → addListener("progress")
                   → getSelectedModel()
                   → WhisperPlugin.isModelLoaded()
                         └── loaded=false → WhisperPlugin.loadModel({ model })
                   → WhisperPlugin.transcribe({ audioPath, lang })
                   → retourne text.trim()
```

---

## CodeService (`src/services/codeService.ts`)

Source code navigation over SSH: filesystem, git operations and remote repository cloning.
Wraps the `SshPlugin` singleton — do not use it alongside other SSH operations.

### Connection

```typescript
await codeService.connect(server);   // ouvre la session SSH
await codeService.disconnect();      // ferme la session
codeService.isConnected;             // boolean
```

### URL helpers (static)

| Method | Description |
|--------|-------------|
| `isGitUrl(str)` | `true` when the string looks like a clonable git URL (`https://` or `git@`) |

### Filesystem

| Method | Description |
|--------|-------------|
| `listDir(dirPath)` | Lists the contents of a directory (folders first, then files, sorted). Excludes `.git` and `node_modules`. |
| `readFile(filePath)` | Reads a file's contents through SSH base64 (handles UTF-8 and empty lines). |
| `readFileAsBase64(filePath)` | Returns the raw base64 string (useful for images). |
| `writeLine(filePath, lineNum, content)` | Replaces a line (1-based) through Python3 + base64 on the server side, to handle special characters. |

### Execution

| Method | Description |
|--------|-------------|
| `execStream(command, onLine)` | Runs a command and streams every line (stdout + stderr) to a callback. Returns the exit code. |

### Git

| Method | Description |
|--------|-------------|
| `cloneOrPull(url, onProgress)` | Clones a git repository (`https://` or `git@`) into `~/.cache/erplibre_code/{slug}`; `git pull` when already present. Returns the local path. |
| `gitCurrentBranch(repoPath)` | The repository's active branch. |
| `gitStatus(repoPath)` | The `git status --short` output. |
| `gitLog(repoPath, limit?)` | The N latest commits (default 25) → `GitCommit[]` with hash, shortHash, subject, author, date. |
| `gitBranches(repoPath)` | The list of local branches → `GitBranch[]` with a `current` flag. |
| `gitDiff(repoPath)` | The full diff (stdout + stderr). |
| `gitCheckout(repoPath, ref)` | Checks out a branch or a commit. Returns `{ output, exitCode }`. |
| `gitCommit(repoPath, message)` | `git add -A && git commit -m <msg>`. The message is base64-encoded to handle quotes. Returns `{ output, exitCode }`. |

### URL slug

The private `_urlToSlug(url)` method turns a git URL into a filesystem-safe identifier (60 chars max). The algorithm is replicated identically in `vite.config.ts` (`urlToSlug`) so the `/repos/{slug}/` paths match between the build and the runtime.

---

## BundleCodeService (`src/services/bundleCodeService.ts`)

Offline reading of the source code bundled at build time by the Vite plugin.
No SSH connection required. Uses `fetch()` against static files in `dist/`.

### Base paths

| `baseUrl` | Source |
|-----------|--------|
| `/repo` (default) | The app's own sources (`src/public/repo/`) |
| `/repos/{slug}` | A manifest project's repository (`src/public/repos/{slug}/`) |

The slug matches exactly the one produced by `CodeService._urlToSlug`.

### Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Loads `${baseUrl}/index.json`. Called automatically on the first operation. |
| `listDir(dirPath)` | Filters the index by parent path to return the direct children. |
| `readFile(filePath)` | Fetches the raw file contents through `fetch`. |
| `getFileUrl(filePath)` | Returns the absolute URL (`${baseUrl}/${filePath}`) — used as the `src` of images. |

### Bundle generation (Vite)

The `bundleSourcePlugin` in `vite.config.ts` produces the bundles at `buildStart`:

1. **App source** → `src/public/repo/` + `src/public/repo/index.json`
2. **Manifest projects** → `src/public/repos/{slug}/` + `src/public/repos/manifest.json`

Files excluded from the manifest repository bundles:
- Artefact directories: `android/`, `ios/`, `build/`, `.gradle/`, `__pycache__/`, `venv/`, `target/`, etc.
- Binary extensions: `.so`, `.class`, `.jar`, `.aar`, `.dex`, `.pyc`, etc.
- Files above 1 MB

The `ERPLIBRE_MANIFEST_PATH` environment variable customises the manifest path
(default: `../../.repo/local_manifests/erplibre_manifest.xml`).

The `BUNDLE_DEBUG=1` environment variable turns on per-file logging during the build.

---

## TranslationService (`src/services/translationService.ts`)

Text translation between French and English. Delegates to one of four pluggable backends
selected by the user in Options › Traduction. All preferences are persisted in SQLite so the
choice survives app restarts.

### Constructor / dependencies

```typescript
new TranslationService(db: DatabaseService)
```

Requires a fully initialised `DatabaseService` (tables must exist). No network calls at
construction time.

### Public API

| Method | Signature | Description |
|--------|-----------|-------------|
| `translate` | `(text, source, target) → Promise<string>` | Translate `text` from `source` to `target`. Returns the original string if `source === target` or if the text is empty after trimming. |
| `getApiType` | `() → Promise<TranslationApiType>` | Returns the currently selected backend. Defaults to `"ollama"` when no preference is stored. |
| `setApiType` | `(type) → Promise<void>` | Persist the backend choice. |
| `getOllamaUrl` | `() → Promise<string>` | Ollama server URL (default: `http://localhost:11434`). |
| `setOllamaUrl` | `(url) → Promise<void>` | Persist the Ollama URL. |
| `getOllamaModel` | `() → Promise<string>` | Ollama model name (default: `"llama3.2"`). |
| `setOllamaModel` | `(model) → Promise<void>` | Persist the Ollama model name. |
| `getLibreTranslateUrl` | `() → Promise<string>` | LibreTranslate endpoint (default: `http://localhost:5000/translate`). |
| `setLibreTranslateUrl` | `(url) → Promise<void>` | Persist the LibreTranslate URL. |
| `getSelectedMarianModel` | `(direction) → Promise<MarianModel>` | Returns the MarianMT model variant for `"fr-en"` or `"en-fr"`. Defaults to the `tiny` variant if no preference is stored. |
| `setSelectedMarianModel` | `(model) → Promise<void>` | Persist the MarianMT model choice. Direction is inferred from the model key prefix. |

### Backend overview

| Backend | Offline | When to use |
|---------|---------|-------------|
| `marian` | Yes — on-device NDK | Best privacy; no server required; Android only. Requires the MarianMT models to be downloaded first (Options › Traduction). |
| `ollama` | Yes — local server | Ollama running on the device or on a LAN host (e.g. an ERPLibre server). Default backend for existing installs. |
| `libretranslate` | Configurable | Self-hosted LibreTranslate instance. Can be fully offline if the instance is on the local network. |
| `mymemory` | No — cloud API | Free-tier cloud API. No local setup. Limited to 450 characters per request; longer text is split automatically. |

The constant `TRANSLATION_REQUIRES_INTERNET` (exported from `translationService.ts`) maps
each backend to a boolean, so the UI can display the correct badge without calling into the
service.

### Preferences keys (SQLite `user_graphic_prefs`)

| Key | Default | Description |
|-----|---------|-------------|
| `translation_api_type` | `"ollama"` | Active backend |
| `translation_libre_url` | `http://localhost:5000/translate` | LibreTranslate endpoint |
| `translation_ollama_url` | `http://localhost:11434` | Ollama base URL |
| `translation_ollama_model` | `"llama3.2"` | Ollama model name |
| `translation_marian_model_fr_en` | `"fr-en-tiny"` | Selected MarianMT FR→EN variant |
| `translation_marian_model_en_fr` | `"en-fr-tiny"` | Selected MarianMT EN→FR variant |

### Usage example

```typescript
// Injected at boot; db is already initialised.
const translationService = new TranslationService(db);

// Select the on-device backend
await translationService.setApiType("marian");
await translationService.setSelectedMarianModel("fr-en-base");

// Translate a note entry
const english = await translationService.translate(
    "Bonjour le monde",
    "fr",
    "en"
);
// → "Hello world"
```

MyMemory chunking is transparent: texts longer than 450 characters are split at sentence
boundaries (`[.!?]\s`) and the translated parts are joined with a single space.


## Bundle Pipeline tar.gz + Edit Mode

See `doc/BUNDLE_PIPELINE.md` for the full flow. In short:

- `RepoExtractorService` — extracts the manifest repos from `tar.gz` into Cache.
- `BundleCodeService` (archive mode) — reads the files from Cache after extraction.
- `RepoEditService` — Cache → Documents promotion + `isomorphic-git` baseline commit.
- `EditableCodeService` — read/write + git diff/log/commit/reset on a promoted repo.
- `repoFsFactory.getRepoFs(project)` — picks the right backend depending on whether the slug is in edit mode.

The SQLite `editable_repos` table (migration `2026042601`) tracks the promoted repos.

Decompression through the native `DecompressionStream('gzip')` (Chrome 80+, available on Android WebView 7+). `isomorphic-git` is lazily `import()`ed at promotion time — it does not weigh on startup (a separate ~150 KB chunk).

Manual test matrix: `doc/bundle_extract_test_matrix.md`.
