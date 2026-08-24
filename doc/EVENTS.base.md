<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
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

<!-- [fr] -->
# Bus d'événements

Les composants communiquent via l'`EventBus` d'Owl. Il n'y a pas de prop drilling ni de store global.

## Événements disponibles

| Événement | Déclencheur | Écouteur | Description |
|-----------|-------------|----------|-------------|
| `ROUTER_NAVIGATION` | N'importe quel composant | `ContentComponent` | Changer de route/page |
| `TAG_MANAGER` | `NoteTopControlsComponent` | `RootComponent` | Ouvrir l'overlay de gestion des tags |
| `DATE_PICKER` | `NoteBottomControlsComponent` | `RootComponent` | Ouvrir le sélecteur de date |
| `GEOLOCATION` | `NoteBottomControlsComponent` | `NoteComponent` | Demander la position GPS |
| `FOCUS_LAST_ENTRY` | Services de note | `NoteContentComponent` | Scroll vers la dernière entrée ajoutée |
| `OPEN_CAMERA` | `NoteBottomControlsComponent` | `RootComponent` | Afficher le composant caméra vidéo |
| `CLOSE_CAMERA` | `VideoCameraComponent` | `RootComponent` | Fermer le composant caméra vidéo |
| `SET_AUDIO_RECORDING` | Plugin audio | `NoteComponent` | Sauvegarder le chemin du fichier audio enregistré |
| `SET_VIDEO_RECORDING` | `VideoCameraComponent` | `NoteComponent` | Sauvegarder le chemin du fichier vidéo enregistré |
| `RELOAD_NOTES` | `NoteService` | `NoteListComponent` | Rafraîchir la liste des notes |
| `SET_INTENT` | `IntentService` | `IntentComponent` | Stocker les données d'un intent Android |

## Pattern d'utilisation

<!-- [common] -->
```typescript
// Émettre un événement
this.env.eventBus.trigger('ROUTER_NAVIGATION', { path: '/notes' });

// Écouter un événement (dans setup() d'un composant Owl)
this.env.eventBus.addEventListener('RELOAD_NOTES', () => {
  this.loadNotes();
});
```

<!-- [en] -->
## Typical flows

### Adding a photo to a note

<!-- [fr] -->
## Flux typiques

### Ajout d'une photo à une note

<!-- [common] -->
```
NoteBottomControlsComponent
  → [déclenche plugin Camera Capacitor]
  → [callback] AppService.handleCamera()
  → trigger SET_PHOTO_RECORDING (chemin fichier)
  → NoteComponent crée une entrée photo
  → trigger FOCUS_LAST_ENTRY
  → NoteContentComponent scroll vers la nouvelle entrée
```

<!-- [en] -->
### Sharing from another Android app

<!-- [fr] -->
### Partage depuis une autre app Android

<!-- [common] -->
```
Android Intent (SEND action)
  → IntentService.listen()
  → [parse MIME type]
  → trigger SET_INTENT (données parsées)
  → trigger ROUTER_NAVIGATION vers /intent/:type
  → IntentComponent affiche les options (nouvelle note / note existante)
```
