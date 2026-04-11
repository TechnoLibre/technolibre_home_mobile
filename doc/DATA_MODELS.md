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
```

> Les colonnes `tags`, `entries`, `selected_sync_config_ids` et `sync_per_server_status` stockent du JSON sérialisé. La conversion est gérée par `DatabaseService`.
