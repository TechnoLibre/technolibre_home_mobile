<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Bundle Extract + Edit — Manual Hardware Test Matrix

These checks must be run by hand against a physical Android device (or
emulator with sufficient storage). There is no CI runner that exercises
Capacitor `Filesystem` + `DecompressionStream` end-to-end.

## Quick automated smoke test

For the basics (build → install → boot → migration → no logcat errors)
there's a helper:

<!-- [fr] -->
# Extraction et édition de bundle — Matrice de tests matériels manuels

Ces vérifications doivent être passées à la main sur un appareil Android
physique (ou un émulateur disposant d'assez d'espace). Aucun exécuteur
d'intégration continue n'éprouve `Filesystem` + `DecompressionStream` de
Capacitor de bout en bout.

## Test de fumée automatisé rapide

Pour l'essentiel (compilation → installation → démarrage → migration → aucune
erreur dans logcat), un utilitaire existe :

<!-- [common] -->
```bash
./scripts/smoke_test_emulator.sh
```

<!-- [en] -->
It builds the APK, installs it, launches the activity, captures 20 s of
filtered logcat, and prints any `ERROR` / `FATAL` / migration-failure
lines it found. Pass an alternate package id as `$1` if your launcher
differs from `ca.erplibre.home`.

The full UI flow below still needs human eyes.

## Setup

<!-- [fr] -->
Il compile l'APK, l'installe, lance l'activité, capture 20 s de logcat filtré,
et affiche toutes les lignes `ERROR` / `FATAL` / échec de migration trouvées.
Passer un autre identifiant de paquet en `$1` si votre lanceur diffère de
`ca.erplibre.home`.

Le parcours d'interface complet ci-dessous demande toujours un œil humain.

## Préparation

<!-- [common] -->
```bash
cd mobile/erplibre_home_mobile
rm -rf src/public/repo src/public/repos src/public/build_id.json
npm run build
npx cap sync android
cd android && ./gradlew installDebug
```

<!-- [en] -->
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

<!-- [fr] -->
Ouvrir l'application sur l'appareil, aller dans **Options → Code**.

## Parcours en lecture seule

- [ ] Choisir « Bundle (sources embarquées) » — les sources de l'application
      se chargent, parcourir `src/js/app.ts`, le contenu s'affiche.
- [ ] Choisir un dépôt du manifeste dans la liste (p. ex. OCA/web-api). Des
      événements de progression doivent se déclencher (l'interface peut
      afficher un indicateur d'attente).
- [ ] Après extraction, parcourir l'arborescence, ouvrir un fichier `.py` —
      le contenu s'affiche.
- [ ] Forcer l'arrêt de l'application et réouvrir le même dépôt. Les fichiers
      apparaissent instantanément (succès de cache, témoin respecté).
- [ ] Vider le cache depuis Paramètres Android → Applications → ERPLibre Home
      → Stockage → Vider le cache. Réouvrir le dépôt : il se réextrait avec
      progression.

## Parcours du mode édition

- [ ] Ouvrir un dépôt du manifeste (lecture seule). L'en-tête affiche
      `(lecture seule)` et un bouton `✏️ Activer édition` est visible.
- [ ] Cliquer le bouton d'édition. Pendant la promotion, le texte du bouton
      devient `⏳ Promotion…` ; à la fin l'en-tête passe à `(édition)` et le
      bouton devient `🔒 Sortir édition`. Un nouvel onglet `🔀 Git` apparaît
      dans la barre d'outils.
- [ ] Cliquer l'onglet `🔀 Git`. L'état initial est « Working tree propre »
      (commit de référence seulement). La section `Historique` montre une
      entrée dont le message commence par `baseline: shipped via APK build`.
- [ ] Modifier un fichier via l'éditeur intégré. Revenir à l'onglet Git et
      appuyer sur `↻ Rafraîchir`. Le fichier apparaît sous `Modifié`.
- [ ] Cliquer le nom du fichier dans la liste Modifié — la section `Diff`
      affiche `--- a/<chemin>` / `+++ b/<chemin>` avec des fragments `-` en
      rouge et `+` en vert (diff de Myers).
- [ ] Saisir un message de commit et appuyer sur `✓ Commit`. La liste
      `Modifié` se vide ; la section `Historique` gagne une entrée.
- [ ] Modifier un autre fichier. Cliquer le bouton `↶` à côté de lui dans la
      liste Modifié. Après confirmation le fichier revient en arrière.
- [ ] Modifier deux fichiers et cliquer `⟲ Tout annuler`. Les deux reviennent
      en arrière.
- [ ] Cliquer `🔒 Sortir édition`. Après confirmation, la copie dans Documents
      est effacée, l'en-tête revient à `(lecture seule)`, l'onglet Git
      disparaît, la ligne dans `editable_repos` n'est plus là.
- [ ] Promouvoir à nouveau le même dépôt, modifier et commiter un fichier,
      puis **recompiler l'APK avec `npm run build && npx cap sync &&
      ./gradlew installDebug`** (ce qui produit un nouveau `build_id.json`).
      Réouvrir le dépôt : la bannière orange `⚠ Baseline modifié` apparaît
      avec les anciens et nouveaux identifiants de compilation et un bouton
      `🔄 Réinitialiser au nouveau baseline`.
- [ ] Cliquer le bouton de réinitialisation. Après deux confirmations le dépôt
      est dépromu puis promu à nouveau depuis la nouvelle référence ; la
      bannière disparaît, l'historique Git est neuf.

## Cas limites

- [ ] Réinstaller l'application (désinstaller puis réinstaller). Le cache est
      effacé (toutes les extractions en lecture seule disparaissent), mais
      Documents survit — les dépôts éditables persistent après réinstallation.
- [ ] Ouvrir deux dépôts du manifeste simultanément (dans deux onglets). Les
      deux s'extraient ; les extractions concurrentes du même slug sont
      dédupliquées par la table `inflight`.
- [ ] Couper le réseau pendant une extraction — l'erreur remonte ; aucun témoin
      n'est écrit ; la tentative suivante réextrait.
- [ ] Corrompre une des archives tar.gz de `src/public/repos/` (la tronquer).
      Tenter de consulter ce dépôt lève `BundleCorruptError` ; le témoin n'est
      jamais écrit.

## Cibles de performance

| Opération | Appareil de milieu de gamme |
|-----------|-----------------------------|
| `ensureExtracted` pour un dépôt typique de 200 fichiers | < 2 s |
| `ensureExtracted` pour un dépôt de 1 500 fichiers | < 8 s |
| Réextraction (succès de cache) | < 50 ms |
| `promoteToEditable` pour un dépôt de 200 fichiers | < 5 s |
| `git.diff` sur un fichier touché | < 200 ms |
| `git.commit` d'un fichier | < 500 ms |

Si les cibles ne sont pas atteintes, escalader selon la section
« Prolongements possibles » de `doc/BUNDLE_PIPELINE.md`.
