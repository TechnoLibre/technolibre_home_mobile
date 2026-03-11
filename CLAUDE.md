# CLAUDE.md — ERPLibre Home Mobile

## Project Overview

ERPLibre Home Mobile is a cross-platform mobile app built with **Odoo Owl 2.8.1** (UI framework), **Capacitor 7** (native bridge), and **Vite 5** (bundler). It manages notes with rich content entries and ERPLibre server connections.

- **App ID**: `ca.erplibre.home`
- **License**: AGPLv3
- **Author**: TechnoLibre
- **Platforms**: Android, iOS, Web

## Tech Stack

| Layer        | Technology                          |
|--------------|-------------------------------------|
| UI Framework | Odoo Owl 2.8.1 (XML templates)     |
| Bundler      | Vite 5.4                            |
| Mobile       | Capacitor 7.4                       |
| Database     | SQLite (encrypted via SQLCipher)    |
| Language     | TypeScript (ES modules)             |
| Styling      | SCSS                                |
| Testing      | Vitest                              |

## Project Structure

```
src/
├── components/       # Owl components (XML templates + TS + SCSS)
├── services/         # Business logic layer
│   ├── databaseService.ts   # SQLite singleton (encrypted)
│   ├── appService.ts        # ERPLibre server credentials
│   ├── note/                # NoteService + subservices (Crud, Intent, Entry)
│   └── intentService.ts     # Android implicit intents
├── models/           # TypeScript interfaces (Note, Application, Intent)
├── constants/        # Events, storage keys
├── utils/            # Storage, biometry, webview utilities
├── js/               # App bootstrap, router, routes, custom errors
├── css/              # Global SCSS (vars, mixins, components)
├── assets/           # SVG icons, images, fonts
├── __tests__/        # Vitest unit tests
├── __mocks__/        # Test mocks (SQLite, Capacitor, Owl)
├── .env.*            # Environment configs (dev, staging, prod)
├── index.html        # Entry point
└── manifest.json     # PWA manifest
```

## Key Commands

```bash
# Development
npm start                  # Vite dev server
npm run preview            # Preview production build

# Build
npm run build              # Production build
npm run build:dev          # Development build
npm run build:staging      # Staging build

# Mobile (build + sync + run)
npm run bsr android        # Build, sync, run on Android
npm run bsr ios            # Build, sync, run on iOS
npm run bsr web            # Build, sync, run on web

# Code generation
npm run gencomp <name> <path> <hasProps>  # Generate Owl component boilerplate

# Testing
npx vitest                 # Run tests
npx vitest run             # Run tests once (CI mode)
```

## Architecture

### Layered Pattern

```
Components (Owl UI) → Services (Business Logic) → DatabaseService (SQLite)
```

### Key Patterns

- **Singleton**: `DatabaseService` — one DB connection shared across the app
- **In-memory caching**: `AppService` and `NoteService` cache data to minimize DB queries
- **Subservice delegation**: `NoteService` delegates to `NoteCrudSubservice`, `NoteIntentSubservice`, `NoteEntrySubservice`
- **Event-driven**: Owl `EventBus` for cross-component communication (events defined in `src/constants/events.ts`)
- **Custom routing**: `SimpleRouter` in `src/js/router.ts` — no external router dependency

### Routes

| Path                                  | Component                |
|---------------------------------------|--------------------------|
| `/`                                   | HomeComponent            |
| `/notes`                              | NoteListComponent        |
| `/note/:id`                           | NoteComponent            |
| `/applications`                       | ApplicationsComponent    |
| `/applications/add`                   | ApplicationsAddComponent |
| `/applications/edit/:url/:username`   | ApplicationsEditComponent|
| `/intent/:type`                       | IntentComponent          |
| `/options`                            | OptionsComponent         |

### Database Schema (SQLite)

- `applications` — ERPLibre server credentials (url, username, password)
- `notes` — Note metadata (id, title, date, done, archived, pinned)
- `note_tags` — Many-to-many tags (note_id, tag)
- `note_entries` — Rich content entries (id, note_id, type, params JSON, sort_order)

Entry types: `text`, `audio`, `date`, `photo`, `video`, `geolocation`

## Conventions

### Git Commit Messages

Follow the prefix convention:
- `[ADD]` — New feature
- `[FIX]` — Bug fix
- `[MIG]` — Migration / data layer change
- `[IMP]` — Improvement / refactor
- `[REM]` — Removal

### Component Structure

Each component lives in `src/components/<name>/` with three files:
- `<Name>Component.ts` — Owl component class
- `<Name>Component.xml` — Owl XML template
- `<Name>Component.scss` — Scoped styles

Use `npm run gencomp` to scaffold new components.

### Services

- Services are classes instantiated once and imported as singletons
- Services use `DatabaseService` for persistence
- Services maintain an in-memory cache (`this._cache`) refreshed from DB
- Custom errors are defined in `src/js/errors.ts`

### Environment Variables

Prefixed with `VITE_` (Vite convention):
- `VITE_TITLE` — App title
- `VITE_LABEL_NOTE` — Note label
- `VITE_LOGO_KEY` — Logo variant (techno, white)
- `VITE_WEBSITE_URL` — Company website
- `VITE_DEBUG_DEV` — Debug flag

### Testing

- Test files in `src/__tests__/*.test.ts`
- Mocks in `src/__mocks__/` (SQLite, Capacitor, Owl)
- Use `vi.spyOn` for service/DB method spying
- Reset singletons in `beforeEach` blocks
- Test both happy paths and error cases

## Important Notes

- SQLite encryption is enabled on mobile platforms only (Android/iOS), not on web
- The app uses `uuid` (v13) for generating note and entry IDs
- Foreign keys use `ON DELETE CASCADE` for automatic cleanup
- Vite config sets `minify: false` for easier debugging
- The Capacitor source root is `./src`, output goes to `../dist`
