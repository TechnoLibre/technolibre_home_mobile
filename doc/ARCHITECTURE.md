# Architecture

## Stack technique

| Couche | Technologie | Version |
|--------|-------------|---------|
| UI Framework | Odoo Owl | 2.8.1 |
| Build | Vite | 5.4.2 |
| Langage | TypeScript | — |
| Pont natif | Capacitor | 7.4.4 |
| Base de données locale | @capacitor-community/sqlite | 7.0.2 |
| Styles | SCSS | — |
| Plateforme cible | Android | — |

## Structure des répertoires

```
erplibre_home_mobile/
├── src/
│   ├── js/
│   │   ├── app.ts              # Point d'entrée, bootstrap de l'app
│   │   ├── router.ts           # Moteur de routage SPA
│   │   └── routes.ts           # Table des routes
│   ├── components/             # Composants Owl (38 fichiers TypeScript)
│   ├── services/               # Logique métier
│   │   ├── appService.ts       # Gestion des applications Odoo
│   │   ├── databaseService.ts  # Abstraction SQLite
│   │   ├── intentService.ts    # Intents Android (partage)
│   │   └── note/               # Services de notes (3 sous-services)
│   ├── models/                 # Interfaces TypeScript
│   ├── utils/                  # Utilitaires
│   ├── constants/              # Constantes de l'application
│   └── css/                    # Styles SCSS
├── android/                    # Projet Android natif (Capacitor)
├── dist/                       # Sortie de build (web)
├── scripts/                    # Scripts auxiliaires
├── package.json
├── vite.config.ts
└── capacitor.config.json
```

## Bootstrap de l'application (`src/js/app.ts`)

Au démarrage :

1. Initialisation de l'`EventBus` Owl
2. Création des services : `AppService`, `NoteService`, `IntentService`
3. Initialisation de la base SQLite et exécution des migrations
4. Montage du `RootComponent` sur le DOM
5. Écoute des événements de navigation et de caméra

## Capacitor — pont Web/Natif

Capacitor synchronise les fichiers web compilés (`dist/`) vers le projet Android natif. Les plugins Capacitor utilisés :

| Plugin | Usage |
|--------|-------|
| `@capacitor-community/sqlite` | Base de données locale |
| `@capacitor/geolocation` | GPS |
| `@capacitor/camera` | Photo |
| `capacitor-voice-recorder` | Audio |
| `@capacitor-community/video-recorder` | Vidéo |
| `@aparajita/capacitor-biometric-auth` | Biométrie (empreinte/face) |
| `@supernotes/capacitor-send-intent` | Intents Android (partage) |

## Permissions Android

Déclarées dans `android/app/src/main/AndroidManifest.xml` :

- `INTERNET`
- `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `android.hardware.location.gps`
- `RECORD_AUDIO`
- `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`

## Pattern architectural global

```
Composants Owl
    │  événements (EventBus)
    ▼
Services (AppService, NoteService, IntentService)
    │  appels async
    ▼
DatabaseService (SQLite via Capacitor)
    │  plugins Capacitor
    ▼
APIs natives Android (GPS, caméra, audio, biométrie)
```

## Variables d'environnement Vite

| Variable | Description |
|----------|-------------|
| `VITE_TITLE` | Titre de l'app |
| `VITE_LABEL_NOTE` | Libellé personnalisé pour les notes |
| `VITE_LOGO_KEY` | Identifiant du logo |
| `VITE_WEBSITE_URL` | URL du site web |
| `VITE_DEBUG_DEV` | Activer le mode debug |
