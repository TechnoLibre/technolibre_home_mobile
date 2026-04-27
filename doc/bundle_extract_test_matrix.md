# Bundle Extract + Edit — Manual Hardware Test Matrix

These checks must be run by hand against a physical Android device (or
emulator with sufficient storage). There is no CI runner that exercises
Capacitor `Filesystem` + `DecompressionStream` end-to-end.

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

- [ ] Open a manifest repo (read-only). Click "Edit" in the UI (when
      added). The promoted state should appear in `editable_repos` —
      verify by enabling debug log or inspecting SQLite via `adb shell`.
- [ ] Reopen the repo from the Code tool. The same view loads — but
      reads now come from Documents (verify by editing a file via
      `adb shell` and reopening, the change should appear).
- [ ] Edit a file via the app's editor (when wired). `git diff` should
      show the change.
- [ ] Commit the change. `git log` should show 2 entries (baseline +
      your change).
- [ ] Click `resetFile` on the changed file → reverts to baseline,
      diff empty for that file.
- [ ] `resetAll` → all files revert, untracked deleted.
- [ ] `unpromote` → the Documents copy is gone, `editable_repos` row
      removed. The next read returns to Cache (read-only) mode.

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
