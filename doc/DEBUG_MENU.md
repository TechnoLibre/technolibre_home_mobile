# Debug Menu (⋮)

Every page header in ERPLibre Home Mobile exposes a **⋮** (vertical ellipsis) button
in the top-right corner. Its purpose is to give Claude Code the context it needs to
identify which source file drives the screen currently visible on the device.

## What it shows

Tapping **⋮ → 🐛 Debug** opens an overlay with three lines:

```
Vue       : Options › Transcription
Composant : options_transcription_component.ts
Route     : /options/transcription
```

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
