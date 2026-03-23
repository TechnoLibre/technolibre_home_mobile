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

```bash
./mobile/run_tests.sh
```

Ou directement depuis `erplibre_home_mobile` :

```bash
npm test
```

### Fichiers de test

Situés dans `src/__tests__/` :

| Fichier | Couverture |
|---------|-----------|
| `appService.test.ts` | CRUD applications, régression initialisation |
| `databaseService.test.ts` | Opérations SQLite |
| `dataMigration.test.ts` | Migration SecureStorage → SQLite |
| `migrationService.test.ts` | Runner de migrations, versionnage |
| `migrationPopup.test.ts` | Dialog de notification post-migration |
| `noteService.test.ts` | CRUD notes, tags, intents |

### Mocks Capacitor

Les plugins natifs sont mockés dans `src/__mocks__/` (SQLite en mémoire via `sql.js`, SecureStorage comme dictionnaire en mémoire).

## Script principal

```bash
./mobile/compile_and_run.sh
```

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

```bash
npm run gencomp MonComposant
```

Crée un squelette de composant Owl dans `src/components/`.

## Signature Android

La configuration Capacitor (`capacitor.config.json`) pointe par défaut vers un keystore de debug. Pour une release production, configurer le keystore signé dans `android/app/build.gradle`.

## Sortie de build

```
dist/
├── index.html
├── assets/
│   ├── index-[hash].js
│   └── index-[hash].css
└── ...
```

Ces fichiers sont copiés par Capacitor dans `android/app/src/main/assets/public/`.
