
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

Navigation is triggered through the `EventBus` with the `ROUTER_NAVIGATION` event.

```typescript
// Navigation vers une route statique
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: '/notes' });

// Navigation vers une route avec paramètres de chemin
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/deploy/${host}/${username}` });

// Navigation vers une route avec query string (voir ci-dessous)
const qs = new URLSearchParams({ host, username });
eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/edit?${qs}` });
```

`ContentComponent` listens for that event and mounts the component matching the active route.

## Query-string pattern for `/servers/edit`

The server edit route uses **query parameters** rather than path segments:

```
/servers/edit?host=192.168.1.5&username=admin
```

**Why?** The router's `splitRoute()` method filters out empty segments with `.filter(Boolean)`. If the username is empty, a route such as `/servers/edit/192.168.1.5/` yields only 3 segments instead of the 4 expected — no match is found and the `*` wildcard takes over (back to `HomeComponent`).

The answer is to pass the parameters in the query string. `splitRoute()` already strips the query string before counting segments (line 26 of `router.ts`: `route.split(/[?#]/)[0]`), so the route `/servers/edit?host=...&username=` matches `/servers/edit` correctly.

```typescript
// Dans ServersEditComponent.setup()
const params   = new URLSearchParams(window.location.search);
const host     = params.get("host")     ?? "";
const username = params.get("username") ?? "";
```

This approach works even when `username` is an empty string (the case for servers added by network scan with no user configuration).
