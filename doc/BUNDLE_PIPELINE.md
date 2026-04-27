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

## Edit mode flow

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
