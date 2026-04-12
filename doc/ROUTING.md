# Routage

## Moteur

Le routage est géré par un `SimpleRouter` personnalisé (`src/js/router.ts`), sans dépendance externe.

Fonctionnalités :
- Routes paramétriques (syntaxe `:id`)
- Route wildcard `*` (fallback)
- Décodage sécurisé des URL (`decodeURIComponent` avec fallback)
- Parsing SPA (hash ou pathname)
- Les query strings et fragments `#` sont ignorés avant la comparaison de segments

## Table des routes (`src/js/routes.ts`)

| Route | Composant |
|-------|-----------|
| `/` | `HomeComponent` |
| `/applications` | `ApplicationsComponent` |
| `/applications/add` | `ApplicationsAddComponent` |
| `/applications/edit/:url/:username` | `ApplicationsEditComponent` |
| `/servers/edit` | `ServersEditComponent` |
| `/servers/add` | `ServersAddComponent` |
| `/servers/settings/:host/:username` | `ServersSettingsComponent` |
| `/servers/workspace/:host/:username` | `ServersWorkspaceComponent` |
| `/servers/deploy/:host/:username` | `ServersDeployComponent` |
| `/servers/resources/:host/:username` | `ServersResourcesComponent` |
| `/notes` | `NoteListComponent` |
| `/notes/edit/:id` | `NoteListComponent` |
| `/note/:id` | `NoteComponent` |
| `/intent/:type` | `IntentComponent` |
| `/options` | `OptionsComponent` |
| `/options/database` | `OptionsDatabaseComponent` |
| `/options/erplibre` | `OptionsErplibreComponent` |
| `/options/transcription` | `OptionsTranscriptionComponent` |
| `/options/processes` | `OptionsProcessesComponent` |
| `*` | `HomeComponent` (fallback) |

## Navigation

La navigation est déclenchée via l'`EventBus` avec l'événement `ROUTER_NAVIGATION`.

```typescript
// Navigation vers une route statique
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: '/notes' });

// Navigation vers une route avec paramètres de chemin
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/deploy/${host}/${username}` });

// Navigation vers une route avec query string (voir ci-dessous)
const qs = new URLSearchParams({ host, username });
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/edit?${qs}` });
```

Le `ContentComponent` écoute cet événement et monte le composant correspondant à la route active.

## Pattern query-string pour `/servers/edit`

La route d'édition de serveur utilise des **query parameters** plutôt que des segments de chemin :

```
/servers/edit?host=192.168.1.5&username=admin
```

**Pourquoi ?** La méthode `splitRoute()` du routeur filtre les segments vides via `.filter(Boolean)`. Si le nom d'utilisateur est vide, une route comme `/servers/edit/192.168.1.5/` produit seulement 3 segments au lieu de 4 attendus — aucune correspondance n'est trouvée et le wildcard `*` prend le relais (retour à `HomeComponent`).

La solution est de passer les paramètres dans la query string. `splitRoute()` retire déjà la query string avant de compter les segments (ligne 26 de `router.ts` : `route.split(/[?#]/)[0]`), donc la route `/servers/edit?host=...&username=` correspond correctement à `/servers/edit`.

```typescript
// Dans ServersEditComponent.setup()
const params   = new URLSearchParams(window.location.search);
const host     = params.get("host")     ?? "";
const username = params.get("username") ?? "";
```

Cette approche fonctionne même si `username` est une chaîne vide (cas des serveurs ajoutés par scan réseau sans configuration utilisateur).
