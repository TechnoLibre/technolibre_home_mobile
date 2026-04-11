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

### ServersComponent — `/servers`

Liste et gestion des serveurs SSH.

Sous-composants :
- **ServersAddComponent** — formulaire d'ajout (`/servers/add`)
- **ServersEditComponent** — formulaire d'édition (`/servers/edit/:host/:username`)
- **ServersItemComponent** — carte individuelle d'un serveur avec badge de déploiement

---

### ServersSettingsComponent — `/servers/:host/:username`

Page de détail d'un serveur. Affiche les workspaces découverts et offre un accès aux sous-pages.

Fonctionnalités :
- **Lancement du déploiement** — démarre un déploiement ERPLibre via SSH
- **Gestion des workspaces** — liste et suppression des workspaces persistés
- **Navigation** vers le terminal SSH et le moniteur de ressources
- **Badge de déploiement en cours** — indicateur visuel si un déploiement est actif

---

### ServersWorkspaceComponent — `/servers/:host/:username/workspace/:path`

Terminal SSH intégré et logs de déploiement pour un workspace donné.

Fonctionnalités :
- **Terminal SSH interactif** — envoi de commandes via `SshPlugin`
- **Logs de déploiement** — affichage des étapes avec statut coloré et durée
- **Reprise de déploiement** — bouton pour relancer depuis l'étape en échec
- **Auto-scroll** — suivi automatique des dernières lignes, désactivable manuellement
- **Navigation haut/bas** — raccourcis pour atteindre le début/fin des logs
- **Breadcrumbs** — fil d'Ariane vers la liste des serveurs

---

### ServersDeployComponent — `/servers/:host/:username/deploy`

Vue de progression du déploiement en cours sur un serveur.

---

### ServersResourcesComponent — `/servers/:host/:username/resources`

Moniteur de ressources système en temps réel, alimenté via SSH.

Métriques affichées :
- **CPU** — barre d'utilisation (user + sy + io) et charge moyenne (1/5/15 min)
- **RAM** — barre double segment (vert = utilisé, jaune = cache/buffers) + métriques détaillées
- **Swap** — barre d'utilisation et taille
- **Températures** — capteurs lm-sensors, groupés par puce, colorés selon les seuils high/crit
- **Disques** — partitions `df -hP`, badge 🔒 pour LUKS et LVM-over-LUKS
- **Réseau** — vitesse RX/TX instantanée (delta sur 1 s via `/proc/net/dev`)
- **Uptime** — durée de fonctionnement
- **Utilisateurs** — sessions actives avec comptage par nom

Les fonctions de parsing SSH sont extraites dans `src/utils/serverResourceParsers.ts` et couvertes par des tests unitaires.

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
- **Page ERPLibre** (`/options/erplibre`) — informations sur le projet, logo, liens officiels
- **Boutons d'erreur dans le dialogue d'application** — copier le message d'erreur dans le presse-papier, ouvrir un ticket GitHub pré-rempli

## Classe de base `EnhancedComponent`

Tous les composants héritent d'`EnhancedComponent` qui fournit :
- Injection de dépendances (accès aux services)
- Accès à l'`EventBus`
- Helpers communs
