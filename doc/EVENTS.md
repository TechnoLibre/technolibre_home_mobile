
# Event bus

Components talk to each other through Owl's `EventBus`. There is no prop drilling and no global store.

## Available events

| Event | Trigger | Listener | Description |
|-------|---------|----------|-------------|
| `ROUTER_NAVIGATION` | Any component | `ContentComponent` | Change route/page |
| `TAG_MANAGER` | `NoteTopControlsComponent` | `RootComponent` | Open the tag management overlay |
| `DATE_PICKER` | `NoteBottomControlsComponent` | `RootComponent` | Open the date picker |
| `GEOLOCATION` | `NoteBottomControlsComponent` | `NoteComponent` | Request the GPS position |
| `FOCUS_LAST_ENTRY` | Note services | `NoteContentComponent` | Scroll to the last added entry |
| `OPEN_CAMERA` | `NoteBottomControlsComponent` | `RootComponent` | Show the video camera component |
| `CLOSE_CAMERA` | `VideoCameraComponent` | `RootComponent` | Close the video camera component |
| `SET_AUDIO_RECORDING` | Audio plugin | `NoteComponent` | Save the recorded audio file path |
| `SET_VIDEO_RECORDING` | `VideoCameraComponent` | `NoteComponent` | Save the recorded video file path |
| `RELOAD_NOTES` | `NoteService` | `NoteListComponent` | Refresh the note list |
| `SET_INTENT` | `IntentService` | `IntentComponent` | Store the data of an Android intent |

## Usage pattern

```typescript
// Émettre un événement
this.env.eventBus.trigger('ROUTER_NAVIGATION', { path: '/notes' });

// Écouter un événement (dans setup() d'un composant Owl)
this.env.eventBus.addEventListener('RELOAD_NOTES', () => {
  this.loadNotes();
});
```

## Typical flows

### Adding a photo to a note

```
NoteBottomControlsComponent
  → [déclenche plugin Camera Capacitor]
  → [callback] AppService.handleCamera()
  → trigger SET_PHOTO_RECORDING (chemin fichier)
  → NoteComponent crée une entrée photo
  → trigger FOCUS_LAST_ENTRY
  → NoteContentComponent scroll vers la nouvelle entrée
```

### Sharing from another Android app

```
Android Intent (SEND action)
  → IntentService.listen()
  → [parse MIME type]
  → trigger SET_INTENT (données parsées)
  → trigger ROUTER_NAVIGATION vers /intent/:type
  → IntentComponent affiche les options (nouvelle note / note existante)
```