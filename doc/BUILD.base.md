<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
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

<!-- [fr] -->
# Build et déploiement

## Prérequis

- Node.js + npm
- Android SDK + ADB
- Appareil Android connecté ou émulateur actif

## Commandes npm

| Commande | Description |
|----------|-------------|
| `npm run build` | Build production (Vite) |
| `npm run build:dev` | Build développement |
| `npm run build:staging` | Build staging |
| `npm run bsr` | Build + Capacitor sync + run Android |
| `npm run gencomp <nom>` | Générer un nouveau composant Owl |
| `npm test` | Lancer les tests unitaires (Vitest) |

## Tests

### Lancer les tests

Depuis la racine du dépôt :

<!-- [common] -->
```bash
./mobile/run_tests.sh
```

<!-- [en] -->
Or directly from `erplibre_home_mobile`:

<!-- [fr] -->
Ou directement depuis `erplibre_home_mobile` :

<!-- [common] -->
```bash
npm test
```

<!-- [en] -->
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

<!-- [fr] -->
### Fichiers de test

Situés dans `src/__tests__/` :

| Fichier | Couverture |
|---------|-----------|
| `appService.test.ts` | CRUD applications, régression initialisation |
| `databaseService.test.ts` | Opérations SQLite, chiffrement (génération clé, réutilisation, unicité) |
| `biometryUtils.test.ts` | Gate biométrique — 5 cas (désactivé, non défini, capteur absent, succès, échec) |
| `dataMigration.test.ts` | Migration SecureStorage → SQLite |
| `migrationService.test.ts` | Runner de migrations, versionnage |
| `migrationPopup.test.ts` | Dialog de notification post-migration |
| `noteService.test.ts` | CRUD notes, tags, intents |

### Mocks Capacitor

Les plugins natifs sont mockés dans `src/__mocks__/` :

| Mock | Implémentation |
|------|----------------|
| `@capacitor-community/sqlite` | DB en mémoire (Map), gestion des connexions |
| `capacitor-secure-storage-plugin` | Dictionnaire en mémoire, expose `_store` pour les tests |
| `@aparajita/capacitor-biometric-auth` | Contrôlable via `_setShouldSucceed()` / `_setAvailable()` / `_reset()` |
| `@capacitor/dialog` | No-op |
| `@capacitor/core` | No-op |
| `@odoo/owl` | Stubs minimalistes |

## Script principal

<!-- [common] -->
```bash
./mobile/compile_and_run.sh
```

<!-- [en] -->
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

<!-- [fr] -->
Exécute la séquence complète :
1. `npm run build` — compile les sources TypeScript/SCSS vers `dist/`
2. `npx cap sync android` — synchronise `dist/` dans le projet Android natif
3. `npx cap run android` — lance l'app sur l'appareil/émulateur

## Environnements

Vite charge automatiquement le fichier `.env` correspondant :

| Fichier | Utilisé pour |
|---------|-------------|
| `.env.development` | `npm run build:dev` |
| `.env.staging` | `npm run build:staging` |
| `.env.production` | `npm run build` |

Variables disponibles : voir [ARCHITECTURE.md](./ARCHITECTURE.md#variables-denvironnement-vite).

## Génération d'un composant

<!-- [common] -->
```bash
npm run gencomp MonComposant
```

<!-- [en] -->
Creates an Owl component skeleton in `src/components/`.

## Android signing

The Capacitor configuration (`capacitor.config.json`) points to a debug keystore by default. For a production release, configure the signed keystore in `android/app/build.gradle`.

## Build output

<!-- [fr] -->
Crée un squelette de composant Owl dans `src/components/`.

## Signature Android

La configuration Capacitor (`capacitor.config.json`) pointe par défaut vers un keystore de debug. Pour une release production, configurer le keystore signé dans `android/app/build.gradle`.

## Sortie de build

<!-- [common] -->
```
dist/
├── index.html
├── assets/
│   ├── index-[hash].js
│   └── index-[hash].css
└── ...
```

<!-- [en] -->
Capacitor copies these files into `android/app/src/main/assets/public/`.

<!-- [fr] -->
Ces fichiers sont copiés par Capacitor dans `android/app/src/main/assets/public/`.
