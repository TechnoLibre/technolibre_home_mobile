<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Debug Menu (⋮)

Every page header in ERPLibre Home Mobile exposes a **⋮** (vertical ellipsis) button
in the top-right corner. Its purpose is to give Claude Code the context it needs to
identify which source file drives the screen currently visible on the device.

## What it shows

Tapping **⋮ → 🐛 Debug** opens an overlay with three lines:

<!-- [fr] -->
# Menu de débogage (⋮)

Chaque en-tête de page d'ERPLibre Home Mobile expose un bouton **⋮** (points de
suspension verticaux) dans le coin supérieur droit. Son but est de donner à Claude
Code le contexte nécessaire pour identifier quel fichier source pilote l'écran
actuellement visible sur l'appareil.

## Ce qu'il affiche

Toucher **⋮ → 🐛 Debug** ouvre une surcouche de trois lignes :

<!-- [common] -->
```
Vue       : Options › Transcription
Composant : options_transcription_component.ts
Route     : /options/transcription
```

<!-- [en] -->
| Field | Meaning |
|-------|---------|
| `Vue` | Human-readable breadcrumb trail + page title |
| `Composant` | Source file name for the component (note / heading pages) |
| `Route` | Current `window.location.pathname` |

`HeadingComponent`-backed pages (Options sub-pages, Servers…) show `Vue` + `Route`
only, because the component file is always `heading_component.ts` there — the
sub-page identity is captured by the route and breadcrumb trail.

## Create a debug note

The overlay also contains a **📝 Ajouter une note** button. Tapping it creates a
new note pre-filled with the debug text and navigates to it. This lets you paste
the context directly into a conversation with Claude Code.

## Implementation

| File | Role |
|------|------|
| `src/utils/debugUtils.ts` | Pure `buildViewPath(crumbs, title)` helper |
| `src/components/heading/heading_component.ts` | ⋮ menu + debug dialog for all HeadingComponent pages |
| `src/components/note/note_component.ts` | ⋮ menu + debug dialog for the note editor |
| `src/components/note_list/note_list_component.ts` | ⋮ menu + debug dialog for the note list |
| `src/components/tags/tag_notes_component.ts` | ⋮ menu + debug dialog for the tag view |
| `src/components/note/note_component.scss` | Shared CSS for `.breadcrumb__options-*` classes |
| `src/components/heading/heading_component.scss` | `.debug-dialog__message` monospace style |

The `⋮` CSS classes (`breadcrumb__options-wrap`, `breadcrumb__options-btn`,
`breadcrumb__options-menu`, `breadcrumb__options-item`) are defined in
`note_component.scss` and loaded globally via `src/css/components.scss`, so all
components can reuse them without duplication.

## Adding ⋮ to a new page

1. Add `showOptionsMenu: false` and `debugDialog: { visible: false, message: "" }`
   to the component state.
2. Copy the `⋮` button markup and menu from an existing component.
3. Set the `message` in `onDebugClick` using `buildViewPath` from `debugUtils.ts`.
4. Add the debug overlay template (reuses `.error-dialog-overlay` / `.error-dialog`
   CSS already defined in `note_component.scss`).

<!-- [fr] -->
| Champ | Signification |
|-------|---------------|
| `Vue` | Fil d'Ariane lisible + titre de la page |
| `Composant` | Nom du fichier source du composant (pages note / heading) |
| `Route` | `window.location.pathname` courant |

Les pages portées par `HeadingComponent` (sous-pages d'Options, Serveurs…)
n'affichent que `Vue` + `Route`, car le fichier du composant y est toujours
`heading_component.ts` — l'identité de la sous-page est portée par la route et le
fil d'Ariane.

## Créer une note de débogage

La surcouche contient aussi un bouton **📝 Ajouter une note**. Le toucher crée une
note préremplie avec le texte de débogage et y navigue. Cela permet de coller le
contexte directement dans une conversation avec Claude Code.

## Implémentation

| Fichier | Rôle |
|---------|------|
| `src/utils/debugUtils.ts` | Fonction pure `buildViewPath(crumbs, title)` |
| `src/components/heading/heading_component.ts` | Menu ⋮ + dialogue de débogage pour toutes les pages HeadingComponent |
| `src/components/note/note_component.ts` | Menu ⋮ + dialogue de débogage pour l'éditeur de note |
| `src/components/note_list/note_list_component.ts` | Menu ⋮ + dialogue de débogage pour la liste de notes |
| `src/components/tags/tag_notes_component.ts` | Menu ⋮ + dialogue de débogage pour la vue par tag |
| `src/components/note/note_component.scss` | CSS partagé des classes `.breadcrumb__options-*` |
| `src/components/heading/heading_component.scss` | Style monospace de `.debug-dialog__message` |

Les classes CSS du `⋮` (`breadcrumb__options-wrap`, `breadcrumb__options-btn`,
`breadcrumb__options-menu`, `breadcrumb__options-item`) sont définies dans
`note_component.scss` et chargées globalement via `src/css/components.scss` : tous
les composants peuvent donc les réutiliser sans duplication.

## Ajouter le ⋮ à une nouvelle page

1. Ajouter `showOptionsMenu: false` et `debugDialog: { visible: false, message: "" }`
   à l'état du composant.
2. Copier le balisage du bouton `⋮` et son menu depuis un composant existant.
3. Renseigner le `message` dans `onDebugClick` avec `buildViewPath` de
   `debugUtils.ts`.
4. Ajouter le gabarit de la surcouche de débogage (il réutilise le CSS
   `.error-dialog-overlay` / `.error-dialog` déjà défini dans
   `note_component.scss`).
