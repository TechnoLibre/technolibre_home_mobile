# CLAUDE.md — ERPLibre Home Mobile

Guide local au sous-projet `mobile/erplibre_home_mobile/` (app Capacitor +
Owl + Stream Deck). Ce fichier complète le `CLAUDE.md` racine du repo.

## Stack

- **Capacitor 8** (Android only pour l'instant) + plugins natifs Java
  dans `android/app/src/main/java/ca/erplibre/home/`
- **Owl 2.8** AOT-précompilé pour les composants UI
- **Vite 8** + Vitest 4 pour build/test
- **TypeScript** strict, **SCSS** modulaire par composant

## Règles détaillées

Voir `.claude/rules/` pour les règles spécifiques mobile :

| Fichier | Contenu |
|---------|---------|
| `01-feature-catalog.md` | Catalogue de fonctionnalités à maintenir |

## Commandes essentielles

```bash
npm test                                 # Vitest
npx vite build                           # Bundle prod
./mobile/compile_and_run.sh              # Build web + Android + run (depuis racine repo)
./mobile/compile_and_run_livereload.sh   # HMR dev loop
```

## Conventions

- Tests unitaires : `src/__tests__/*.test.ts` (Vitest)
- Format de commit standard ERPLibre (`[FIX] streamdeck: ...`)
- Plugins natifs : nouvelle classe Java + bridge TS dans `src/plugins/` +
  `registerPlugin` dans `MainActivity.java`
