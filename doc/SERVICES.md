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

**Base de données :** `erplibre_mobile`

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
- Vérifier la disponibilité biométrique de l'appareil
- Authentifier (empreinte / reconnaissance faciale)
- Activer/désactiver via stockage persistant

### WebViewUtils
- Ouvrir une URL dans la WebView
- Injection du script d'auto-login Odoo

### StorageUtils
- Stockage clé/valeur persistant (préférences)

### StorageConstants
- Clés de configuration persistante (biométrie activée, etc.)
