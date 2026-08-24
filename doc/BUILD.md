
# Build and deployment

## Prerequisites

- Node.js + npm
- Android SDK + ADB
- A connected Android device or a running emulator

## npm commands

| Command | Description |
|---------|-------------|
| `npm run build` | Production build (Vite) |
| `npm run build:dev` | Development build |
| `npm run build:staging` | Staging build |
| `npm run bsr` | Build + Capacitor sync + run Android |
| `npm run gencomp <name>` | Generate a new Owl component |
| `npm test` | Run the unit tests (Vitest) |

## Tests

### Running the tests

From the repository root:

```bash
./mobile/run_tests.sh
```

Or directly from `erplibre_home_mobile`:

```bash
npm test
```

### Test files

Located in `src/__tests__/`:

| File | Coverage |
|------|----------|
| `appService.test.ts` | Application CRUD, initialisation regression |
| `databaseService.test.ts` | SQLite operations, encryption (key generation, reuse, uniqueness) |
| `biometryUtils.test.ts` | Biometric gate — 5 cases (disabled, unset, no sensor, success, failure) |
| `dataMigration.test.ts` | SecureStorage → SQLite migration |
| `migrationService.test.ts` | Migration runner, versioning |
| `migrationPopup.test.ts` | Post-migration notification dialog |
| `noteService.test.ts` | Note CRUD, tags, intents |

### Capacitor mocks

Native plugins are mocked in `src/__mocks__/`:

| Mock | Implementation |
|------|----------------|
| `@capacitor-community/sqlite` | In-memory DB (Map), connection handling |
| `capacitor-secure-storage-plugin` | In-memory dictionary, exposes `_store` for tests |
| `@aparajita/capacitor-biometric-auth` | Driven by `_setShouldSucceed()` / `_setAvailable()` / `_reset()` |
| `@capacitor/dialog` | No-op |
| `@capacitor/core` | No-op |
| `@odoo/owl` | Minimal stubs |

## Main script

```bash
./mobile/compile_and_run.sh
```

Runs the full sequence:
1. `npm run build` — compiles the TypeScript/SCSS sources into `dist/`
2. `npx cap sync android` — syncs `dist/` into the native Android project
3. `npx cap run android` — launches the app on the device/emulator

## Environments

Vite automatically loads the matching `.env` file:

| File | Used for |
|------|----------|
| `.env.development` | `npm run build:dev` |
| `.env.staging` | `npm run build:staging` |
| `.env.production` | `npm run build` |

Available variables: see [ARCHITECTURE.md](./ARCHITECTURE.md#variables-denvironnement-vite).

## Generating a component

```bash
npm run gencomp MonComposant
```

Creates an Owl component skeleton in `src/components/`.

## Android signing

The Capacitor configuration (`capacitor.config.json`) points to a debug keystore by default. For a production release, configure the signed keystore in `android/app/build.gradle`.

## Build output

```
dist/
├── index.html
├── assets/
│   ├── index-[hash].js
│   └── index-[hash].css
└── ...
```

Capacitor copies these files into `android/app/src/main/assets/public/`.
