<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Bundle Pipeline (tar.gz + Lazy Extract + Edit Mode)

## Overview

The Code tool browses two kinds of source bundles:

1. **App's own source** — loose files at build assets `/repo/`.
2. **Manifest repos** (138 OCA / ERPLibre / whisper.cpp / …) — shipped as
   per-repo `.tar.gz` archives at `/repos/{slug}.tar.gz`, extracted on
   demand into the device's Cache directory.

Editable mode promotes a manifest repo to a persistent, git-backed copy
in Documents.

## Build (vite.config.ts)

For every manifest project that exists locally:

1. Walk + filter source files (binary skip-list, max file size, etc.).
2. Stage the survivors in a temp dir.
3. `tar -czf <slug>.tar.gz` from the temp dir.
4. Emit a `<slug>.index.json` sidecar listing the same files.
5. Record archive + index URLs and sizes in `manifest.json`.

`build_id.json` is also emitted with a short git SHA + timestamp; this
identifier is recorded with each editable repo's baseline so we can
detect baseline drift after a rebuild.

## Read-only flow

<!-- [fr] -->
# Pipeline de bundle (tar.gz + extraction paresseuse + mode édition)

## Vue d'ensemble

L'outil Code parcourt deux sortes de bundles de sources :

1. **Les sources de l'application elle-même** — fichiers épars dans les
   ressources de compilation `/repo/`.
2. **Les dépôts du manifeste** (138 OCA / ERPLibre / whisper.cpp / …) — livrés
   en archives `.tar.gz` par dépôt dans `/repos/{slug}.tar.gz`, extraites à la
   demande dans le répertoire Cache de l'appareil.

Le mode édition promeut un dépôt du manifeste en une copie persistante, adossée
à git, dans Documents.

## Compilation (vite.config.ts)

Pour chaque projet du manifeste présent localement :

1. Parcourir et filtrer les fichiers source (liste d'exclusion binaire, taille
   maximale, etc.).
2. Rassembler les survivants dans un répertoire temporaire.
3. `tar -czf <slug>.tar.gz` depuis ce répertoire.
4. Émettre un fichier annexe `<slug>.index.json` listant les mêmes fichiers.
5. Consigner les URL et tailles de l'archive et de l'index dans `manifest.json`.

`build_id.json` est également émis avec un SHA git court et un horodatage ; cet
identifiant est consigné avec la référence de chaque dépôt éditable, ce qui
permet de détecter une dérive de référence après une recompilation.

## Flux en lecture seule

<!-- [common] -->
```
User opens Code tool / selects repo
  ↓
getRepoFs(project, extractor, editor)
  ↓ (not editable)
BundleCodeService(archive mode)
  ↓ initialize()
fetch indexUrl → in-memory entries
extractor.ensureExtracted(slug, archiveUrl)
  ↓
fetch archiveUrl
  ↓ DecompressionStream("gzip")
parseTarStream → for each entry: Filesystem.writeFile under Cache
  ↓ sentinel .extracted
listDir / readFile from Cache
```

<!-- [en] -->
## Edit mode flow

<!-- [fr] -->
## Flux du mode édition

<!-- [common] -->
```
User clicks "Edit"
  ↓
RepoEditService.promoteToEditable(slug, archiveUrl)
  ↓ ensureExtracted (idempotent)
recursive copy Cache → Documents
  ↓
isomorphic-git: init + add + commit "baseline: build {id}"
  ↓
INSERT INTO editable_repos (slug, baseline_sha, …)
```

<!-- [en] -->
After promotion, `getRepoFs` returns an `EditableCodeService` for that
slug. Reads/writes target Documents. Diffs come from `git.statusMatrix`
+ manual content compare. Resets use `git.checkout`.

## Storage

| Layer | Capacitor `Directory` | Persistence |
|-------|----------------------|-------------|
| Read-only extraction | `Cache` | OS may evict — re-extract transparently |
| Editable promotion | `Data` (Documents) | Persistent across reinstall |
| Build artifact | APK assets | Immutable until next build |

## Service map

| Service | Responsibility |
|---------|----------------|
| `RepoExtractorService` | tar.gz fetch + DecompressionStream + tar parse + write to Cache. Idempotent via `.extracted` sentinel. |
| `BundleCodeService` (archive mode) | Reads from Cache after extraction. |
| `RepoEditService` | Cache → Documents copy + `isomorphic-git` baseline commit. |
| `EditableCodeService` | Read/write under Documents + `git status / diff / log / commit / reset`. |
| `repoFsFactory.getRepoFs` | Picks Editable or Bundle backend per slug. |

## Extending later

Possible follow-ups (not in this iteration):

- Archive the app's own source too — same flow, requires no schema changes.
- Native Capacitor plugin wrapping `libtar` + `zlib` if pure-JS extraction proves too slow on low-end devices.
- Online git remote support (clone, push) — requires CORS proxy and credential UI.
- Real Myers-style line diff (`@isomorphic-git/diff` or `diff` npm) for nicer hunks in the UI.

<!-- [fr] -->
Après promotion, `getRepoFs` renvoie un `EditableCodeService` pour ce slug. Les
lectures et écritures visent Documents. Les diffs viennent de
`git.statusMatrix` complété par une comparaison manuelle du contenu. Les remises
à zéro utilisent `git.checkout`.

## Stockage

| Couche | `Directory` Capacitor | Persistance |
|--------|----------------------|-------------|
| Extraction en lecture seule | `Cache` | Le système peut l'évincer — réextraction transparente |
| Promotion en éditable | `Data` (Documents) | Persiste à travers une réinstallation |
| Artéfact de compilation | ressources de l'APK | Immuable jusqu'à la compilation suivante |

## Carte des services

| Service | Responsabilité |
|---------|----------------|
| `RepoExtractorService` | Récupération du tar.gz + DecompressionStream + analyse tar + écriture dans Cache. Idempotent grâce au témoin `.extracted`. |
| `BundleCodeService` (mode archive) | Lit depuis Cache après extraction. |
| `RepoEditService` | Copie Cache → Documents + commit de référence `isomorphic-git`. |
| `EditableCodeService` | Lecture/écriture sous Documents + `git status / diff / log / commit / reset`. |
| `repoFsFactory.getRepoFs` | Choisit le moteur Editable ou Bundle selon le slug. |

## Prolongements possibles

Suites envisageables (hors de cette itération) :

- Archiver aussi les sources de l'application — même flux, aucun changement de schéma nécessaire.
- Plugin Capacitor natif enveloppant `libtar` + `zlib` si l'extraction en JavaScript pur se révèle trop lente sur les appareils modestes.
- Prise en charge des dépôts git distants en ligne (clone, push) — nécessite un mandataire CORS et une interface pour les identifiants.
- Vrai diff ligne à ligne à la Myers (`@isomorphic-git/diff` ou le paquet `diff`) pour de plus beaux fragments dans l'interface.
