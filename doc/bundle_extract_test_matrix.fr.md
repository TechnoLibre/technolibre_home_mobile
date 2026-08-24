
# Extraction et édition de bundle — Matrice de tests matériels manuels

Ces vérifications doivent être passées à la main sur un appareil Android
physique (ou un émulateur disposant d'assez d'espace). Aucun exécuteur
d'intégration continue n'éprouve `Filesystem` + `DecompressionStream` de
Capacitor de bout en bout.

## Test de fumée automatisé rapide

Pour l'essentiel (compilation → installation → démarrage → migration → aucune
erreur dans logcat), un utilitaire existe :

```bash
./scripts/smoke_test_emulator.sh
```

Il compile l'APK, l'installe, lance l'activité, capture 20 s de logcat filtré,
et affiche toutes les lignes `ERROR` / `FATAL` / échec de migration trouvées.
Passer un autre identifiant de paquet en `$1` si votre lanceur diffère de
`ca.erplibre.home`.

Le parcours d'interface complet ci-dessous demande toujours un œil humain.

## Préparation

```bash
cd mobile/erplibre_home_mobile
rm -rf src/public/repo src/public/repos src/public/build_id.json
npm run build
npx cap sync android
cd android && ./gradlew installDebug
```

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