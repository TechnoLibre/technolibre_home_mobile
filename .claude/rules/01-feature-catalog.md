# Catalogue de fonctionnalités mobiles

L'application mobile (`mobile/erplibre_home_mobile/`) maintient un
arbre vivant de toutes ses fonctionnalités dans
`src/data/featureCatalog.ts`. Cet arbre est rendu dans
**Options → Fonctionnalités** (route `/options/features`) et sert de
carte du code pour les audits, le refactor et l'onboarding.

## Règle pour Claude

Quand tu **ajoutes**, **renommes**, **déplaces** ou **supprimes** une
fonctionnalité de l'application mobile, tu **dois** mettre à jour
`mobile/erplibre_home_mobile/src/data/featureCatalog.ts` dans le même
commit :

- **Nouvelle fonctionnalité** → ajouter un noeud (feuille ou sous-arbre)
  sous la racine appropriée. Champs requis :
  - `id` unique kebab-case (ex: `streamdeck.camera-stream`)
  - `label: { en, fr }` — bilingue
  - `description: { en, fr }` — courte (1 phrase) bilingue
  - `files[]` — au moins un path qui implémente la feature
  - `demo` — comment la démontrer en-app :
    - `{ kind: "route", url: "/some/path" }` — naviguer
    - `{ kind: "options", sectionId?: string }` — ouvrir Options
    - `{ kind: "none", reason?: { en, fr } }` — pas démo-able
- **Refactor / déplacement** → ajuster les `files[]` pour refléter les
  nouveaux chemins.
- **Suppression** → retirer le noeud.
- `howItWorks: { en, fr }` est optionnel mais bienvenu pour les
  features non triviales (explication des internals).

## Conventions

- **Paths relatifs** au répertoire `mobile/erplibre_home_mobile/`
  (ex: `src/services/noteService.ts`, pas absolus, pas de leading `/`).
- **id** : kebab-case unique dans tout l'arbre, dotted par hiérarchie
  (ex: `streamdeck.camera-stream`).
- **Profondeur** : viser 3-4 niveaux max ; au-delà, créer une racine
  séparée plutôt que d'enfouir.
- **files** : viser 1 à 10 paths par feuille — au-delà, c'est un
  signe que la feature mérite d'être découpée en sous-features.

## Vérifier avant commit

```bash
cd mobile/erplibre_home_mobile && npm test
```

Le test `featureCatalog.test.ts` vérifie :
- chaque `files[]` pointe vers un fichier qui existe sur disque
- chaque `id` est unique
- chaque noeud a un `label.fr` et `label.en` non vides
- toute racine a au moins un `demo` (les feuilles peuvent hériter)
