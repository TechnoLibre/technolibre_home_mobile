# Routage

## Moteur

Le routage est géré par un `SimpleRouter` personnalisé (`src/js/router.ts`), sans dépendance externe.

Fonctionnalités :
- Routes paramétriques (syntaxe `:id`)
- Route wildcard `*` (fallback)
- Décodage sécurisé des URL
- Parsing SPA (hash ou pathname)

## Table des routes (`src/js/routes.ts`)

| Route | Composant |
|-------|-----------|
| `/` | `HomeComponent` |
| `/applications` | `ApplicationsComponent` |
| `/applications/add` | `ApplicationsAddComponent` |
| `/applications/edit/:url/:username` | `ApplicationsEditComponent` |
| `/notes` | `NoteListComponent` |
| `/notes/edit/:id` | `NoteListComponent` |
| `/note/:id` | `NoteComponent` |
| `/intent/:type` | `IntentComponent` |
| `/options` | `OptionsComponent` |
| `*` | `HomeComponent` (fallback) |

## Navigation

La navigation est déclenchée via l'`EventBus` avec l'événement `ROUTER_NAVIGATION`.

```typescript
// Exemple de navigation programmatique
eventBus.trigger('ROUTER_NAVIGATION', { path: '/notes' });
```

Le `ContentComponent` écoute cet événement et monte le composant correspondant à la route active.
