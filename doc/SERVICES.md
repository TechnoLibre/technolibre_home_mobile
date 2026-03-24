# Services

## Vue d'ensemble

```
AppService          → CRUD applications Odoo
NoteService
  ├── NoteCrudSubservice      → CRUD notes
  ├── NoteEntrySubservice     → Factory des entrées de note
  └── NoteIntentSubservice    → Création de note depuis un intent
DatabaseService     → Abstraction SQLite
IntentService       → Écoute et parsing des intents Android
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

**Tables :**

```sql
CREATE TABLE applications (
  url      TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  PRIMARY KEY (url, username)
);

CREATE TABLE notes (
  id       TEXT PRIMARY KEY NOT NULL,
  title    TEXT NOT NULL,
  date     TEXT,
  done     INTEGER DEFAULT 0,   -- bool stocké en int
  archived INTEGER DEFAULT 0,
  pinned   INTEGER DEFAULT 0,
  tags     TEXT DEFAULT '[]',   -- JSON array
  entries  TEXT DEFAULT '[]'    -- JSON array de NoteEntry
);
```

**Conversions de types :**
- `boolean` ↔ `INTEGER` (0/1)
- Tableaux et objets ↔ `TEXT` (JSON.stringify / JSON.parse)

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

### StorageConstants

| Clé | Usage |
|-----|-------|
| `applications` | (ancien, migré) liste des apps Odoo |
| `notes` | (ancien, migré) liste des notes |
| `biometry_enabled` | Préférence biométrie de l'utilisateur (`boolean`) |
| `db_encryption_key` | Clé AES-256 de chiffrement SQLite (64 hex) |
