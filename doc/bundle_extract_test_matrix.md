# Bundle Extract + Edit — Manual Hardware Test Matrix

These checks must be run by hand against a physical Android device (or
emulator with sufficient storage). There is no CI runner that exercises
Capacitor `Filesystem` + `DecompressionStream` end-to-end.

## Quick automated smoke test

For the basics (build → install → boot → migration → no logcat errors)
there's a helper:

```bash
./scripts/smoke_test_emulator.sh
```

It builds the APK, installs it, launches the activity, captures 20 s of
filtered logcat, and prints any `ERROR` / `FATAL` / migration-failure
lines it found. Pass an alternate package id as `$1` if your launcher
differs from `ca.erplibre.home`.

The full UI flow below still needs human eyes.

## Setup

```bash
cd mobile/erplibre_home_mobile
rm -rf src/public/repo src/public/repos src/public/build_id.json
npm run build
npx cap sync android
cd android && ./gradlew installDebug
```

Open the app on the device, navigate to **Options → Code**.

## Read-only path

- [ ] Pick "Bundle (sources embarquées)" — app source loads, browse
      `src/js/app.ts`, content displays.
- [ ] Pick a manifest repo from the list (e.g. OCA/web-api). Progress
      events should fire (UI may show a spinner).
- [ ] After extraction, browse the directory tree, open a `.py` file —
      content displays.
- [ ] Force-stop the app and reopen the same repo. Files appear
      instantly (Cache hit, sentinel respected).
- [ ] Clear app cache from Android Settings → Apps → ERPLibre Home →
      Storage → Clear Cache. Reopen the repo: re-extracts with
      progress.

## Edit mode path

- [ ] Open a manifest repo (read-only). The header shows
      `(lecture seule)` and an `✏️ Activer édition` button is visible.
- [ ] Click the Edit button. While promoting, the button text becomes
      `⏳ Promotion…`; on completion the header switches to `(édition)`
      and the button becomes `🔒 Sortir édition`. A new tab `🔀 Git`
      appears in the toolbar.
- [ ] Click the `🔀 Git` tab. Initial status is "Working tree propre"
      (baseline commit only). The `Historique` section shows one entry
      whose message starts with `baseline: shipped via APK build`.
- [ ] Edit a file via the inline editor. Switch back to the Git tab and
      hit `↻ Rafraîchir`. The file appears under `Modifié`.
- [ ] Click the file name in the Modifié list — the `Diff` section
      shows `--- a/<path>` / `+++ b/<path>` with red `-` / green `+`
      hunks (Myers diff).
- [ ] Type a commit message and press `✓ Commit`. The `Modifié` list
      empties; the `Historique` section gains a new entry.
- [ ] Modify another file. Click the `↶` button next to it in the
      Modifié list. After confirmation the file reverts.
- [ ] Modify two files and click `⟲ Tout annuler`. Both revert.
- [ ] Click `🔒 Sortir édition`. After confirmation, the Documents
      copy is wiped, the header reverts to `(lecture seule)`, the Git
      tab disappears, the `editable_repos` row is gone.
- [ ] Re-promote the same repo, edit + commit a file, then **rebuild
      the APK with `npm run build && npx cap sync && ./gradlew
      installDebug`** (which produces a new `build_id.json`). Reopen
      the repo: the orange `⚠ Baseline modifié` banner appears with
      the old vs new build IDs and a `🔄 Réinitialiser au nouveau
      baseline` button.
- [ ] Click the reset-baseline button. After two confirmations the
      repo unpromotes and re-promotes from the new baseline; the
      banner disappears, the Git history is fresh.

## Edge cases

- [ ] Reinstall the app (uninstall + reinstall). Cache is wiped (all
      read-only extractions gone), but Documents survives — editable
      repos persist after reinstall.
- [ ] Open two manifest repos simultaneously (in two tabs). Both
      extract; concurrent extractions for the same slug dedupe via
      the `inflight` map.
- [ ] Pull the network during extraction — error surfaces; no
      sentinel written; next attempt re-extracts.
- [ ] Corrupt one of the tar.gz archives in `src/public/repos/`
      (truncate it). Trying to view that repo throws
      `BundleCorruptError`; sentinel never written.

## Performance targets

| Operation | Mid-range device |
|-----------|------------------|
| `ensureExtracted` for typical 200-file repo | < 2 s |
| `ensureExtracted` for 1 500-file repo | < 8 s |
| Re-extract (Cache hit) | < 50 ms |
| `promoteToEditable` for 200-file repo | < 5 s |
| `git.diff` on a touched file | < 200 ms |
| `git.commit` of 1 file | < 500 ms |

If targets are missed, escalate per the "Extending later" section of
`doc/BUNDLE_PIPELINE.md`.
