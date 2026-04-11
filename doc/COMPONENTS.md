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

Fonctionnalités notables :
- **Auto-login Odoo** — injection de JavaScript dans la WebView pour remplir automatiquement les champs du formulaire de connexion Odoo (détection XPath, protection anti-boucle)
- **Autocomplétion de la base de données** — le champ `database` se pré-remplit depuis `/web/database/list` dès qu'une URL valide est saisie
- **Détection de version Odoo** — la version du serveur est récupérée via `/web/webclient/version_info` et affichée sur la carte
- **Explorateur de modèles Odoo** — bouton info par application qui charge lazily la liste des modèles installés, leurs champs et le nombre d'enregistrements via `SyncService.getOdooExplorer()` et `getOdooModelInfo()`
- **Mode développeur** — accès à des informations techniques avancées (version détaillée, logs)

---

### NoteListComponent — `/notes` et `/notes/edit/:id`
Interface de gestion de la liste des notes.

Fonctionnalités :
- Séparation notes épinglées / non épinglées
- Glisser-déposer pour réordonner (via `sortablejs`)
- Filtrage des notes archivées
- Mode édition pour actions groupées
- **Badge de synchronisation cloud** — chaque carte affiche le nombre de serveurs synchronisés (✓) et en erreur (✗), alimenté par `DatabaseService.getNoteSyncCounts()`

Sous-composants :
- **NoteListItemComponent** — carte individuelle d'une note avec badge de synchro

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

Fonctionnalités notables :
- **Bouton de synchro multi-serveurs** — appui long sur le bouton de sync pour choisir les serveurs cibles parmi les applications configurées ; le choix est persisté dans `selected_sync_config_ids`
- **Ouvrir dans l'app** — bouton "Ouvrir dans app" qui lance la WebView avec auto-login et navigue directement vers la tâche Odoo correspondante

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
- **Préférences graphiques** — sous-composant dédié permettant de choisir :
  - La famille de police : Sans-sérif, Sérif, Mono
  - La taille de police : 5 niveaux de Très petit à Très grand (facteur 0.8 à 1.3)
  - Les préférences sont persistées en SQLite et appliquées via des variables CSS (`--app-font-family`, `--app-font-scale`)
- Voir le changelog
- Vider le cache
- Historique des migrations de données

## Classe de base `EnhancedComponent`

Tous les composants héritent d'`EnhancedComponent` qui fournit :
- Injection de dépendances (accès aux services)
- Accès à l'`EventBus`
- Helpers communs
