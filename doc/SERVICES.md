# Services

## Vue d'ensemble

```
AppService          → CRUD applications Odoo
NoteService
  ├── NoteCrudSubservice      → CRUD notes
  ├── NoteEntrySubservice     → Factory des entrées de note
  └── NoteIntentSubservice    → Création de note depuis un intent
DatabaseService     → Abstraction SQLite
SyncService         → Synchronisation bidirectionnelle Odoo
IntentService       → Écoute et parsing des intents Android
ServerService       → CRUD serveurs SSH + workspaces
DeploymentService   → Déploiement SSH en arrière-plan (état réactif)
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
Utilise JSON-RPC via le plugin natif Android `RawHttp` (contourne le CookieHandler d'Android).

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
