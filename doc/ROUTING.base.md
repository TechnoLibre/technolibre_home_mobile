<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Routing

## Engine

Routing is handled by a custom `SimpleRouter` (`src/js/router.ts`), with no external dependency.

Features:
- Parametric routes (`:id` syntax)
- Wildcard route `*` (fallback)
- Safe URL decoding (`decodeURIComponent` with fallback)
- SPA parsing (hash or pathname)
- Query strings and `#` fragments are stripped before segment comparison

## Route table (`src/js/routes.ts`)

| Route | Component |
|-------|-----------|

<!-- [fr] -->
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

<!-- [common] -->
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

<!-- [en] -->
## Navigation

Navigation is triggered through the `EventBus` with the `ROUTER_NAVIGATION` event.

<!-- [fr] -->
## Navigation

La navigation est déclenchée via l'`EventBus` avec l'événement `ROUTER_NAVIGATION`.

<!-- [common] -->
```typescript
// Navigation vers une route statique
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: '/notes' });

// Navigation vers une route avec paramètres de chemin
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/deploy/${host}/${username}` });

// Navigation vers une route avec query string (voir ci-dessous)
const qs = new URLSearchParams({ host, username });
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/edit?${qs}` });
```

<!-- [en] -->
`ContentComponent` listens for that event and mounts the component matching the active route.

## Query-string pattern for `/servers/edit`

The server edit route uses **query parameters** rather than path segments:

<!-- [fr] -->
Le `ContentComponent` écoute cet événement et monte le composant correspondant à la route active.

## Pattern query-string pour `/servers/edit`

La route d'édition de serveur utilise des **query parameters** plutôt que des segments de chemin :

<!-- [common] -->
```
/servers/edit?host=192.168.1.5&username=admin
```

<!-- [en] -->
**Why?** The router's `splitRoute()` method filters out empty segments with `.filter(Boolean)`. If the username is empty, a route such as `/servers/edit/192.168.1.5/` yields only 3 segments instead of the 4 expected — no match is found and the `*` wildcard takes over (back to `HomeComponent`).

The answer is to pass the parameters in the query string. `splitRoute()` already strips the query string before counting segments (line 26 of `router.ts`: `route.split(/[?#]/)[0]`), so the route `/servers/edit?host=...&username=` matches `/servers/edit` correctly.

<!-- [fr] -->
**Pourquoi ?** La méthode `splitRoute()` du routeur filtre les segments vides via `.filter(Boolean)`. Si le nom d'utilisateur est vide, une route comme `/servers/edit/192.168.1.5/` produit seulement 3 segments au lieu de 4 attendus — aucune correspondance n'est trouvée et le wildcard `*` prend le relais (retour à `HomeComponent`).

La solution est de passer les paramètres dans la query string. `splitRoute()` retire déjà la query string avant de compter les segments (ligne 26 de `router.ts` : `route.split(/[?#]/)[0]`), donc la route `/servers/edit?host=...&username=` correspond correctement à `/servers/edit`.

<!-- [common] -->
```typescript
// Dans ServersEditComponent.setup()
const params   = new URLSearchParams(window.location.search);
const host     = params.get("host")     ?? "";
const username = params.get("username") ?? "";
```

<!-- [en] -->
This approach works even when `username` is an empty string (the case for servers added by network scan with no user configuration).

<!-- [fr] -->
Cette approche fonctionne même si `username` est une chaîne vide (cas des serveurs ajoutés par scan réseau sans configuration utilisateur).
