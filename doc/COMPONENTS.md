# Composants

## Hiérarchie

```
RootComponent
├── ContentComponent          ← outlet du router (composant actif selon la route)
├── NavbarComponent           ← barre de navigation inférieure
├── StatusSpinner             ← overlay chargement/sauvegarde
├── IntentComponent           ← réception des intents Android (partage)
└── VideoCameraComponent      ← capture vidéo plein écran
```

## Composants par route

### HomeComponent — `/`
Écran d'accueil. Affiche le titre de l'application et un raccourci vers les notes.

---

### ApplicationsComponent — `/applications`
Liste et gestion des connexions aux instances Odoo.

Sous-composants :
- **ApplicationsItemComponent** — carte individuelle d'une application
- **ApplicationsAddComponent** — formulaire d'ajout (`/applications/add`)
- **ApplicationsEditComponent** — formulaire d'édition (`/applications/edit/:url/:username`)

Fonctionnalité notable : **auto-login Odoo**
Injection de JavaScript dans la WebView pour remplir automatiquement les champs du formulaire de connexion Odoo (détection XPath, protection anti-boucle).

---

### NoteListComponent — `/notes` et `/notes/edit/:id`
Interface de gestion de la liste des notes.

Fonctionnalités :
- Séparation notes épinglées / non épinglées
- Glisser-déposer pour réordonner (via `sortablejs`)
- Filtrage des notes archivées
- Mode édition pour actions groupées

Sous-composants :
- **NotesItemComponent** — carte individuelle d'une note

---

### NoteComponent — `/note/:id`
Éditeur complet d'une note.

Sous-composants :

| Composant | Rôle |
|-----------|------|
| `NoteTopControlsComponent` | Titre, tags, archivage, épinglage, état "done" |
| `NoteContentComponent` | Affichage/édition des entrées de la note |
| `NoteBottomControlsComponent` | Boutons d'ajout d'entrée (texte, photo, vidéo, audio, localisation, date) |
| `TagManagerComponent` | Gestion des tags (overlay) |
| `DatePickerComponent` | Sélecteur de date (overlay) |
| `NoteEntryTextComponent` | Entrée texte |
| `NoteEntryPhotoComponent` | Entrée photo |
| `NoteEntryVideoComponent` | Entrée vidéo |
| `NoteEntryAudioComponent` | Entrée audio |
| `NoteEntryGeolocationComponent` | Entrée GPS (lat/lon/timestamp) |
| `NoteEntryDateComponent` | Entrée date |

---

### IntentComponent — `/intent/:type`
Gestion du contenu partagé depuis d'autres applications Android.

Sous-composants selon le type d'intent :
- **IntentHandlerTextComponent** — texte partagé
- **IntentHandlerImageComponent** — image partagée
- **IntentHandlerVideoComponent** — vidéo partagée

Permet de créer une nouvelle note ou d'ajouter le contenu à une note existante.

---

### OptionsComponent — `/options`
Paramètres de l'application.

Fonctionnalités :
- Activer/désactiver l'authentification biométrique
- Voir le changelog
- Vider le cache

## Classe de base `EnhancedComponent`

Tous les composants héritent d'`EnhancedComponent` qui fournit :
- Injection de dépendances (accès aux services)
- Accès à l'`EventBus`
- Helpers communs
