# Services

## Vue d'ensemble

```
AppService           → CRUD applications Odoo
NoteService
  ├── NoteCrudSubservice      → CRUD notes
  ├── NoteEntrySubservice     → Factory des entrées de note
  └── NoteIntentSubservice    → Création de note depuis un intent
DatabaseService      → Abstraction SQLite
SyncService          → Synchronisation bidirectionnelle Odoo
IntentService        → Écoute et parsing des intents Android
ServerService        → CRUD serveurs SSH + workspaces
DeploymentService    → Déploiement SSH en arrière-plan (état réactif)
TagService           → CRUD tags hiérarchiques avec cache en mémoire
TranscriptionService → Transcription audio/vidéo locale (Whisper, on-device)
ProcessService       → Journal persistant des transcriptions et téléchargements
CodeService          → Navigation SSH du code source (listDir, readFile, git)
BundleCodeService    → Lecture hors-ligne du code bundlé à la compilation
```

## AppService (`src/services/appService.ts`)

Gestion des connexions aux instances Odoo.

**Méthodes :**
- Créer, lire, mettre à jour, supprimer une application
- Rechercher par URL + username

**Erreurs :**
- `AppAlreadyExistsError` — doublon (url + username)
- `AppKeyNotFoundError` — application introuvable
- `NoAppMatchError` — aucune correspondance

---

## DatabaseService (`src/services/databaseService.ts`)

Abstraction de la base SQLite via le plugin `@capacitor-community/sqlite`.

**Base de données :** `erplibre_mobile` — chiffrée AES-256 (SQLCipher)

### Initialisation (`initialize(onStep?)`)

La méthode accepte un callback optionnel pour reporter chaque étape (utilisé par l'écran de boot) :

1. Récupération ou génération de la clé d'encryption (SecureStorage)
2. `setEncryptionSecret` — appelé **uniquement** si la clé vient d'être créée (1re installation)
3. `checkConnectionsConsistency` + `isConnection` — détermine si la connexion existe déjà
4. `retrieveConnection` ou `createConnection` selon le résultat
5. `open()` + création des tables

### Clé d'encryption

Générée avec `crypto.getRandomValues` (256 bits / 64 hex) à la 1re installation, puis persistée dans `capacitor-secure-storage-plugin` sous la clé `db_encryption_key`. Les démarrages suivants réutilisent la clé existante sans rappeler `setEncryptionSecret`.

### Méthodes principales

| Méthode | Description |
|---------|-------------|
| `initialize()` | Initialise la connexion SQLite et crée les tables de base |
| `getAllApplications()` | Liste toutes les applications |
| `addApplication(app)` | Ajoute une application |
| `updateApplication(url, username, app)` | Met à jour une application |
| `deleteApplication(url, username)` | Supprime une application |
| `setApplicationOdooVersion(url, username, version)` | Persiste la version Odoo détectée |
| `getAllNotes()` | Liste toutes les notes |
| `addNote(note)` | Ajoute une note |
| `updateNote(id, note)` | Met à jour une note |
| `deleteNote(id)` | Supprime une note |
| `getNoteById(id)` | Retourne une note par ID ou `null` |
| `getNoteSyncInfo(id)` | Retourne les métadonnées de synchro d'une note |
| `setNoteSyncInfo(id, info)` | Met à jour partiellement les métadonnées de synchro |
| `getNotesByOdooUrl(url)` | Notes synchronisées avec un serveur Odoo donné |
| `getNotesBySyncConfigId(configId)` | Notes associées à une config de synchro |
| `setNotePerServerStatus(id, configId, status)` | Statut de synchro par serveur |
| `getNoteSyncCounts()` | Agrège les compteurs synced/error par note |
| `getUserGraphicPref(key)` | Lit une préférence graphique |
| `setUserGraphicPref(key, value)` | Persiste une préférence graphique |

### Migrations de schéma

| Méthode | Description |
|---------|-------------|
| `addSyncColumnsToNotes()` | Ajoute les colonnes `odoo_id`, `odoo_url`, `sync_status`, `last_synced_at` |
| `addSyncConfigIdColumn()` | Ajoute la colonne `sync_config_id` |
| `addSelectedSyncConfigIdsColumn()` | Ajoute la colonne `selected_sync_config_ids` |
| `addSyncPerServerStatusColumn()` | Ajoute la colonne `sync_per_server_status` |
| `addOdooVersionToApplications()` | Ajoute la colonne `odoo_version` à `applications` |
| `createUserGraphicPrefsTable()` | Crée la table `user_graphic_prefs` |

Toutes les migrations sont idempotentes (ignorées si la colonne/table existe déjà).

---

## SyncService (`src/services/syncService.ts`)

Synchronisation bidirectionnelle entre les notes locales et les tâches `project.task` d'Odoo.
Utilise JSON-RPC via la méthode interne `rawPost()` (voir ci-dessous).

### Authentification

```typescript
authenticate(creds: SyncCredentials): Promise<{ sessionId: string; odooMajorVersion: number }>
```

- Appelle `/web/dataset/call_kw` avec `res.users.authenticate`
- Stocke la session dans SecureStorage sous `odoo_sync_session_${btoa(url|username)}`
- Extrait `odooMajorVersion` depuis `server_version_info[0]`
- Lève une erreur si `uid` est falsy ou si la réponse contient un champ `error`

### Push

```typescript
pushNote(creds: SyncCredentials, noteId: string): Promise<void>
```

- Recherche la note en base ; lève `"Note not found"` si absente
- Si `odoo_id` existe déjà → `project.task.write` ; sinon → `project.task.create`
- Converts : `pinned` → `priority` (`"1"`/`"0"`), `done` → `state` (`"done"`/`"in_progress"`)
- Met à jour `sync_status`, `odoo_id`, `odoo_url`, `last_synced_at` après succès

### Pull

```typescript
pullNotes(creds: SyncCredentials, since: Date): Promise<number>
```

- Récupère les tâches modifiées depuis `since` via `search_read`
- Pour chaque tâche, retrouve la note locale par `odoo_id` + `odoo_url`
- Met à jour `title`, `pinned`, `archived`, `done` (version 17+ uniquement pour `done`)
- Retourne le nombre de notes mises à jour

### Synchronisation complète

```typescript
syncAll(creds: SyncCredentials, syncConfigId?: string): Promise<{ pushed: number; pulled: number; errors: string[] }>
```

- Pousse toutes les notes `pending` (filtrées par `syncConfigId` si fourni)
- Puis tire toutes les modifications distantes
- Les erreurs individuelles sont capturées et n'interrompent pas la boucle

### Polling

```typescript
pollForChanges(creds: SyncCredentials, since: Date): Promise<number[]>
```

- Retourne les IDs Odoo des tâches modifiées depuis `since`

### Découverte du serveur

| Méthode | Description |
|---------|-------------|
| `listDatabases(url)` | Liste les bases disponibles via `/web/database/list` |
| `getServerVersion(url)` | Version Odoo via `/web/webclient/version_info` ; retourne `null` si indisponible |
| `getOdooExplorer(creds)` | Retourne la version et la liste des modèles installés (`ir.model`) |
| `getOdooModelInfo(creds, model)` | Champs et nombre d'enregistrements d'un modèle via `ir.model.fields` |

### Construction HTML

```typescript
buildHtml(entries: NoteEntry[]): string
```

Convertit les entrées d'une note en HTML pour l'envoi vers Odoo :
- `text` → `<p>` (caractères HTML échappés, entrées vides ignorées)
- `date` → paragraphe avec emoji 📅
- `geolocation` → paragraphe avec emoji 📍 + coordonnées
- `audio/photo/video` → ligne emoji (🎙️/📷/🎥)

```typescript
buildGeoMultiPoint(entries: NoteEntry[]): string | null
```

Construit un GeoJSON `MultiPoint` (ordre `[longitude, latitude]`) à partir des entrées de géolocalisation. Retourne `null` si aucune.

### Transport HTTP (`rawPost`)

Méthode privée utilisée par tous les appels réseau de `SyncService`.

- **Sur Android natif** : utilise `RawHttpPlugin`, qui contourne le `CookieHandler` d'Android. Cela préserve les en-têtes `Cookie` sur les connexions HTTP plain (adresses IP locales), que le système Android supprimerait sinon.
- **Si `RawHttpPlugin` est absent** (APK ancien, build non synchronisé) : lève une erreur explicite — le fallback `fetch()` n'est pas utilisé sur natif car l'Android WebView bloque les requêtes cross-origin vers des serveurs Odoo sans en-tête CORS.
- **Sur web (mode dev)** : `fetch()` est utilisé directement (pas de restriction CORS dans ce contexte).

---

## MigrationService (`src/services/migrationService.ts`)

Runner de migrations de données versionnées.

**Usage :**

```typescript
await runMigrations(db, [
  {
    version: 20260318,
    description: "Migration de SecureStorage vers SQLite",
    run: migrateFromSecureStorage,
  },
]);
```

- Les migrations déjà exécutées sont ignorées (versioning via SecureStorage)
- Chaque migration retourne un `MigrationResult` avec les comptes `migrated` / `skipped` par entité et la durée d'exécution
- L'historique est persisté dans SecureStorage et consultable via **Options → Historique des migrations**

---

## DataMigration (`src/services/dataMigration.ts`)

Migration v1 : transfert des données depuis SecureStorage (format JSON) vers la base SQLite chiffrée.

Entités migrées : `applications`, `notes`.

---

## NoteService (`src/services/note/noteService.ts`)

Point d'entrée principal pour la gestion des notes. Délègue à trois sous-services.

### NoteCrudSubservice
- Créer, lire (par ID, toutes), mettre à jour, supprimer
- Validation UUID v4 des identifiants
- Collecte des tags uniques sur toutes les notes

**Erreurs :**
- `NoNoteMatchError` — note introuvable
- `NoteKeyNotFoundError` — clé manquante

### NoteEntrySubservice
Fabrique d'objets `NoteEntry` selon le type :

| Méthode | Type créé |
|---------|-----------|
| `createTextEntry()` | `text` |
| `createPhotoEntry(path)` | `photo` |
| `createVideoEntry(path)` | `video` |
| `createAudioEntry(path)` | `audio` |
| `createGeolocationEntry(lat, lon)` | `geolocation` |
| `createDateEntry(date)` | `date` |

**Erreurs :**
- `NoNoteEntryMatchError` — entrée introuvable

### NoteIntentSubservice
Création de notes à partir d'un intent Android :
- Convertit `TextIntent`, `ImageIntent`, `VideoIntent` en note avec entrées appropriées

---

## IntentService (`src/services/intentService.ts`)

Écoute les intents implicites Android (action `SEND`).

**Types MIME gérés :**

| MIME | Modèle créé |
|------|-------------|
| `text/plain` | `TextIntent` |
| `image/*` | `ImageIntent` |
| `video/*` | `VideoIntent` |

Déclenche une navigation vers `/intent/:type` via l'`EventBus`.

---

---

## ServerService (`src/services/serverService.ts`)

Gestion des serveurs SSH et de leurs workspaces déployés.

**Méthodes :**

| Méthode | Description |
|---------|-------------|
| `getServers()` | Liste tous les serveurs |
| `add(server)` | Ajoute un serveur |
| `delete(serverID)` | Supprime un serveur par `(host, username)` |
| `edit(serverID, newServer, options?)` | Met à jour un serveur ; `ignoreCredential: true` préserve le mot de passe / la clé existante |
| `matches(serverID)` | Retourne les serveurs correspondant à `(host, username)` |
| `getMatch(serverID)` | Retourne le serveur correspondant ou lève `NoServerMatchError` |
| `getWorkspaces(serverID)` | Liste les workspaces d'un serveur |
| `addWorkspace(workspace)` | Ajoute un workspace (ignore les doublons) |
| `deleteWorkspace(workspace)` | Supprime un workspace |
| `workspaceExists(workspace)` | Vérifie l'existence d'un workspace |

**Erreurs :**
- `ServerAlreadyExistsError` — doublon `(host, username)`
- `NoServerMatchError` — serveur introuvable

---

## DeploymentService (`src/services/deploymentService.ts`)

Orchestration du déploiement ERPLibre via SSH. Maintient un registre réactif (Owl `reactive`) des déploiements en cours ou terminés, accessible depuis n'importe quel composant.

### Registre réactif

```typescript
readonly deployments: ActiveDeployment[]  // liste réactive Owl
```

Les composants qui lisent `deployments` pendant le rendu se re-rendent automatiquement lors des mises à jour (ajout / suppression / progression d'étape).

### Méthodes principales

| Méthode | Description |
|---------|-------------|
| `create(server, path)` | Crée un `ActiveDeployment` réactif avec 3 étapes `pending`. Remplace un déploiement existant sur le même `(host, username, path)`. |
| `find(host, username, path)` | Recherche un déploiement par clé composite. |
| `getAllForServer(host, username)` | Retourne tous les déploiements d'un serveur donné. |
| `dismiss(host, username, path)` | Supprime le déploiement du registre et retire le listener SSH actif. |
| `run(dep, fromStep)` | Lance (ou relance depuis `fromStep`) le déploiement en arrière-plan. |

### Étapes du déploiement

| Index | Étape | Commande SSH |
|-------|-------|-------------|
| 0 | Connexion SSH | `SshPlugin.connect(...)` |
| 1 | Clonage du dépôt | `test -d <path>` → `git clone` ou cd |
| 2 | Installation | `make install` |

Chaque étape passe par `pending → running → success/warning/error`. Les logs s'accumulent dans `step.logs[]` même sans composant monté. À la fin d'un déploiement complet sans erreur, le workspace est persisté via `ServerService.addWorkspace()`.

---

## Utilitaires

### BiometryUtils (`src/utils/biometryUtils.ts`)

| Méthode | Description |
|---------|-------------|
| `isBiometryAvailable()` | Retourne `true` si l'appareil dispose d'un capteur biométrique |
| `isEnabledByUser()` | Retourne `true` uniquement si l'utilisateur a explicitement activé la biométrie |
| `authenticateForDatabase()` | Gate biométrique pour la clé SQLite : prompt natif si activé + disponible, sinon `true` directement |
| `authenticateIfAvailable()` | Gate biométrique générique pour l'accès à l'app |
| `authenticate(errorAlertOptions?)` | Prompt natif brut, retourne `true`/`false` |

### WebViewUtils
- Ouvrir une URL dans la WebView
- Injection du script d'auto-login Odoo

### StorageUtils
- Stockage clé/valeur persistant via SecureStorage (Android Keystore / iOS Keychain)
- `getValueByKey<T>(key)` — retourne `{ keyExists, value, isValid }`
- `setKeyValuePair(key, value)` — sérialise en JSON

### ServerResourceParsers (`src/utils/serverResourceParsers.ts`)

Fonctions pures de formatage et de parsing des sorties SSH brutes pour le moniteur de ressources serveur. Toutes les fonctions sont exportées et couvertes par des tests unitaires.

**Formatage :**

| Fonction | Description |
|----------|-------------|
| `fmtKb(kb)` | Formate des kilo-octets → `"512 KB"`, `"128 MB"`, `"8.0 GB"` |
| `fmtSpeed(bps)` | Formate des octets/s → `"1.5 KB/s"`, `"10.00 MB/s"` |
| `fmtUptime(secs)` | Formate des secondes → `"2j 3h 15min"` |

**Parsing :**

| Fonction | Source SSH | Retour |
|----------|-----------|--------|
| `parseMem(lines)` | `/proc/meminfo` | `MemInfo` (total, used, cached, swap) |
| `parseCpu(line)` | `top -bn1` | `CpuInfo` (us, sy, wa, id) ou `null` |
| `parseLoad(line)` | `/proc/loadavg` | `{ l1, l5, l15 }` ou `null` |
| `parseCryptMounts(lines)` | `lsblk` + `dmsetup` loop | `Set<string>` des points de montage chiffrés |
| `parseDisk(lines, cryptMounts)` | `df -hP` | `DiskPartition[]` avec flag `encrypted` |
| `parseNet(lines1, lines2)` | `/proc/net/dev` (×2) | `NetInfo` (rx/tx octets/s) ou `null` |
| `parseUptime(line)` | `/proc/uptime` | Secondes (`number`) ou `null` |
| `parseUsers(line)` | `users` | `UserCount[]` triés alphabétiquement |
| `parseSensors(lines)` | `sensors` (lm-sensors) | `TempSensor[]` groupés par puce |

### StorageConstants

| Clé | Usage |
|-----|-------|
| `applications` | (ancien, migré) liste des apps Odoo |
| `notes` | (ancien, migré) liste des notes |
| `biometry_enabled` | Préférence biométrie de l'utilisateur (`boolean`) |
| `db_encryption_key` | Clé AES-256 de chiffrement SQLite (64 hex) |

---

## ProcessService (`src/services/processService.ts`)

Persistent log of transcription and model-download operations. Records are stored in the SQLite `processes` table and survive app restarts.

### Initialisation

```typescript
await processService.initialize();
```

Must be called once after the DB migrations have run. Marks any process still flagged `"running"` as `"error"` (interrupted by app kill), then loads the full history into memory.

### Méthodes principales

| Méthode | Description |
|---------|-------------|
| `getAll()` | Tous les enregistrements, du plus récent au plus ancien. |
| `subscribe(cb)` | S'abonner aux changements de liste (ajout, complétion, erreur). Retourne une fonction de désabonnement. |
| `addTranscription(label, noteId?)` | Crée un enregistrement `type: "transcription"` en statut `"running"`. Retourne l'`id` généré. |
| `addDownload(model, url?)` | Crée un enregistrement `type: "download"` en statut `"running"`. Retourne l'`id`. |
| `updateProgress(id, percent)` | Met à jour la progression en mémoire (0–100). Pas d'écriture SQL — le champ est transitoire. |
| `appendDebugLog(id, message)` | Ajoute un message horodaté (`HH:mm:ss.mmm  message`) au log de débogage en mémoire. |
| `completeProcess(id, errorMessage?, result?)` | Passe le statut à `"done"` ou `"error"` et persiste le résultat et le log de débogage en base. |
| `clearAll()` | Supprime tous les enregistrements de la mémoire et de la base. |

### Relation avec TranscriptionService

`TranscriptionService` reçoit une référence optionnelle à `ProcessService` à la construction. Il appelle `addTranscription` / `addDownload` au début de chaque opération, `updateProgress` à chaque événement de progression Whisper, `appendDebugLog` pour les événements Java-level, et `completeProcess` à la fin.

---

## TagService (`src/services/tagService.ts`)

CRUD pour les tags hiérarchiques (parent → enfants). Maintient un cache en mémoire
(`_cache: Tag[] | null`) pour éviter les lectures SQL répétées dans les composants OWL.

### Modèle `Tag`

```typescript
interface Tag {
    id:       string;    // UUID v4 généré par getNewId()
    name:     string;    // nom affiché
    color:    string;    // couleur hex ex: "#6b7280"
    parentId?: string;  // undefined = tag racine
}
```

Les tags sont persistés dans la table SQLite `tags`. La hiérarchie est un arbre simple
(un seul niveau de parenté par ligne, profondeur arbitraire via traversée BFS).

### Méthodes principales

| Méthode | Description |
|---------|-------------|
| `getAllTags()` | Charge tous les tags depuis la DB et met à jour le cache. |
| `getCached()` | Retourne le cache synchrone (tableau vide si non encore chargé). |
| `invalidateCache()` | Vide le cache — prochain appel à `getAllTags()` relit la DB. |
| `getRootTags()` | Tags sans `parentId` (niveau racine). |
| `getChildTags(parentId)` | Enfants directs d'un tag. |
| `getTagsByIds(ids)` | Filtre les tags par liste d'IDs. |
| `getTagById(id)` | Retourne le tag correspondant ou `null`. |
| `addTag(tag)` | Insère en DB et invalide le cache. |
| `updateTag(id, tag)` | Met à jour en DB et invalide le cache. |
| `deleteTag(id)` | Supprime en DB et invalide le cache. |
| `getAllDescendantIds(tagId)` | BFS récursif — retourne tous les IDs descendants (enfants, petits-enfants, …). |
| `getNewId()` | Génère un UUID v4. |

### Pattern d'utilisation dans un composant OWL

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

Transcription audio locale (on-device) via **whisper.cpp** / GGML.
Le modèle s'exécute entièrement sur l'appareil — aucun serveur externe, aucun abonnement.

### Modèles disponibles

| Clé | Taille | Description |
|-----|--------|-------------|
| `tiny` | ~75 Mo | Très rapide, précision correcte pour du français clair |
| `base` | ~142 Mo | Recommandé (compromis vitesse / précision) |
| `small` | ~244 Mo | Précis |
| `medium` | ~769 Mo | Très précis |
| `large-v3-turbo` | ~874 Mo | Meilleur modèle multilingue |
| `distil-large-v3` | ~756 Mo | Anglais uniquement |

Les binaires GGML sont téléchargés depuis HuggingFace (`ggerganov/whisper.cpp`) et stockés dans `{filesDir}/whisper/ggml-<model>.bin`.

### Paramètres de configuration

Persistés dans la table `user_graphic_prefs` de la base SQLite :

| Clé SQLite | Méthodes | Valeur par défaut |
|------------|----------|-------------------|
| `whisper_enabled` | `isEnabled()` / `setEnabled(bool)` | `false` |
| `whisper_model` | `getSelectedModel()` / `setSelectedModel(model)` | `"tiny"` |
| `whisper_download_mode` | `getDownloadMode()` / `setDownloadMode(mode)` | `"wakelock"` |

### État des téléchargements

Le service maintient une `Map<WhisperModel, DownloadProgress>` (`_activeDownloads`) qui
survit aux re-montages de composants. Les composants s'abonnent via `subscribeProgress()` et
se ré-attachent à l'état existant dans `onMounted`.

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

### Modes de téléchargement

| Mode | Mécanisme | Avantage |
|------|-----------|----------|
| `"wakelock"` | Thread Java + `PowerManager.PARTIAL_WAKE_LOCK` | Téléchargements parallèles ; reprise `.partial` |
| `"foreground"` | Android Foreground Service | Notification OS visible ; recommandé pour ≥ 1 Go |

Si le mode `"foreground"` est demandé alors que le service est déjà actif pour un **autre** modèle,
`downloadModel()` bascule automatiquement sur `"wakelock"` (fallback silencieux).

### Méthodes principales

| Méthode | Description |
|---------|-------------|
| `isEnabled()` | Retourne `true` si la transcription est activée |
| `setEnabled(enabled)` | Active ou désactive la transcription |
| `getSelectedModel()` | Retourne le modèle sélectionné ; fallback `"tiny"` pour valeur inconnue |
| `setSelectedModel(model)` | Persiste le choix de modèle |
| `getDownloadMode()` / `setDownloadMode(mode)` | Mode de téléchargement (`"wakelock"` ou `"foreground"`) |
| `isModelDownloaded(model)` | `true` si le `.bin` est présent et qu'aucun téléchargement n'est en cours pour ce modèle |
| `downloadModel(model, mode?)` | Lance le téléchargement du modèle dans le mode choisi ; fallback automatique wakelock si foreground occupé |
| `cancelDownload(model?)` | Annule le téléchargement du modèle indiqué, ou tous si omis |
| `deleteModel(model)` | Supprime le `.bin` et le `.partial` du disque |
| `subscribeProgress(cb)` | Abonnement aux mises à jour de progression. `cb(info, model)` — `info` est `null` à la fin. Retourne une fonction de désabonnement. |
| `activeDownloads` | `ReadonlyMap<WhisperModel, DownloadProgress>` — tous les téléchargements en cours. |
| `activeDownload` | Premier téléchargement actif ou `null` (compat. descendante). |
| `maybeReconnectForeground()` | Appelle `getServiceStatus()` et se ré-attache au Foreground Service si actif mais non suivi (après recréation d'Activity). |
| `transcribe(audioPath, lang?, noteId?, rawPath?)` | Transcrit un enregistrement audio/vidéo ; lève une erreur si appelé hors Android |

### Reconnexion après recréation d'Activity

Quand Android recrée l'Activity (rotation, retour d'arrière-plan), le state JS est perdu
mais le Foreground Service continue de tourner. `onMounted` dans les composants appelle
`maybeReconnectForeground()` qui :

1. Vérifie `WhisperDownloadService.downloading` (champ statique Java) via `getServiceStatus()`.
2. Si un téléchargement est actif, déclenche `downloadModel(model, "foreground")` en fire-and-forget.
3. Java détecte `downloading == true && model == currentModel` → met à jour `pendingForegroundCallId` sans démarrer un second thread.

### Flux de transcription

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

Navigation SSH du code source : système de fichiers, opérations git et clonage de dépôts distants.
Enveloppe le singleton `SshPlugin` — ne pas utiliser en parallèle avec d'autres opérations SSH.

### Connexion

```typescript
await codeService.connect(server);   // ouvre la session SSH
await codeService.disconnect();      // ferme la session
codeService.isConnected;             // boolean
```

### URL helpers (statiques)

| Méthode | Description |
|---------|-------------|
| `isGitUrl(str)` | `true` si la chaîne ressemble à une URL git clonable (`https://` ou `git@`) |

### Système de fichiers

| Méthode | Description |
|---------|-------------|
| `listDir(dirPath)` | Liste le contenu d'un répertoire (dossiers en tête, puis fichiers, triés). Exclut `.git` et `node_modules`. |
| `readFile(filePath)` | Lit le contenu d'un fichier via base64 SSH (gère l'UTF-8 et les lignes vides). |
| `readFileAsBase64(filePath)` | Retourne la chaîne base64 brute (utile pour les images). |
| `writeLine(filePath, lineNum, content)` | Remplace une ligne (1-based) via Python3 + base64 côté serveur pour gérer les caractères spéciaux. |

### Exécution

| Méthode | Description |
|---------|-------------|
| `execStream(command, onLine)` | Exécute une commande et diffuse chaque ligne (stdout + stderr) vers un callback. Retourne le code de sortie. |

### Git

| Méthode | Description |
|---------|-------------|
| `cloneOrPull(url, onProgress)` | Clone un dépôt git (`https://` ou `git@`) dans `~/.cache/erplibre_code/{slug}` ; `git pull` si déjà présent. Retourne le chemin local. |
| `gitCurrentBranch(repoPath)` | Branche active du dépôt. |
| `gitStatus(repoPath)` | Sortie `git status --short`. |
| `gitLog(repoPath, limit?)` | N derniers commits (défaut 25) → `GitCommit[]` avec hash, shortHash, subject, author, date. |
| `gitBranches(repoPath)` | Liste des branches locales → `GitBranch[]` avec flag `current`. |
| `gitDiff(repoPath)` | Diff complet (stdout + stderr). |
| `gitCheckout(repoPath, ref)` | Checkout d'une branche ou d'un commit. Retourne `{ output, exitCode }`. |
| `gitCommit(repoPath, message)` | `git add -A && git commit -m <msg>`. Le message est encodé en base64 pour gérer les guillemets. Retourne `{ output, exitCode }`. |

### Slug d'URL

La méthode privée `_urlToSlug(url)` convertit une URL git en identifiant filesystem-safe (60 car. max). L'algorithme est répliqué à l'identique dans `vite.config.ts` (`urlToSlug`) pour que les chemins `/repos/{slug}/` correspondent entre le build et le runtime.

---

## BundleCodeService (`src/services/bundleCodeService.ts`)

Lecture hors-ligne du code source bundlé à la compilation par le plugin Vite.
Aucune connexion SSH requise. Utilise `fetch()` contre des fichiers statiques dans `dist/`.

### Chemins de base

| `baseUrl` | Source |
|-----------|--------|
| `/repo` (défaut) | Sources de l'app elle-même (`src/public/repo/`) |
| `/repos/{slug}` | Dépôt d'un projet du manifeste (`src/public/repos/{slug}/`) |

Le slug correspond exactement à celui généré par `CodeService._urlToSlug`.

### Méthodes

| Méthode | Description |
|---------|-------------|
| `initialize()` | Charge `${baseUrl}/index.json`. Appelée automatiquement à la première opération. |
| `listDir(dirPath)` | Filtre l'index par chemin parent pour retourner les enfants directs. |
| `readFile(filePath)` | Récupère le contenu brut du fichier via `fetch`. |
| `getFileUrl(filePath)` | Retourne l'URL absolue (`${baseUrl}/${filePath}`) — utilisée comme `src` pour les images. |

### Génération des bundles (Vite)

Le plugin `bundleSourcePlugin` dans `vite.config.ts` génère les bundles au `buildStart` :

1. **App source** → `src/public/repo/` + `src/public/repo/index.json`
2. **Projets du manifeste** → `src/public/repos/{slug}/` + `src/public/repos/manifest.json`

Fichiers exclus du bundle des dépôts manifeste :
- Répertoires d'artefacts : `android/`, `ios/`, `build/`, `.gradle/`, `__pycache__/`, `venv/`, `target/`, etc.
- Extensions binaires : `.so`, `.class`, `.jar`, `.aar`, `.dex`, `.pyc`, etc.
- Fichiers > 1 Mo

Variable d'environnement `ERPLIBRE_MANIFEST_PATH` pour personnaliser le chemin du manifeste
(défaut : `../../.repo/local_manifests/erplibre_manifest.xml`).

Variable d'environnement `BUNDLE_DEBUG=1` pour activer le log détaillé par fichier lors du build.
