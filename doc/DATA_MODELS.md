# Modèles de données

## Application

```typescript
interface Application {
  url: string       // URL de l'instance Odoo
  username: string  // Identifiant utilisateur
  password: string  // Mot de passe
}
```

Clé primaire composite : `(url, username)`

---

## Note

```typescript
interface Note {
  id: string        // UUID v4
  title: string
  date?: string     // Format ISO 8601
  done: boolean
  archived: boolean
  pinned: boolean
  tags: string[]
  entries: NoteEntry[]
}
```

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
  lat: number
  lon: number
  timestamp: string   // ISO 8601
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
  url      TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  PRIMARY KEY (url, username)
);

-- Notes enrichies
CREATE TABLE notes (
  id       TEXT PRIMARY KEY NOT NULL,
  title    TEXT NOT NULL,
  date     TEXT,
  done     INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  pinned   INTEGER DEFAULT 0,
  tags     TEXT DEFAULT '[]',
  entries  TEXT DEFAULT '[]'
);
```

> Les colonnes `tags` et `entries` stockent du JSON sérialisé. La conversion est gérée par `DatabaseService`.
