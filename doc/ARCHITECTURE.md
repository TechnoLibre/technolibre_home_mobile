# Architecture

## Stack technique

| Couche | Technologie | Version |
|--------|-------------|---------|
| UI Framework | Odoo Owl | 2.8.1 |
| Build | Vite | 6.4.2 |
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
│   │   ├── appService.ts           # Gestion des applications Odoo
│   │   ├── databaseService.ts      # Abstraction SQLite
│   │   ├── intentService.ts        # Intents Android (partage)
│   │   ├── serverService.ts        # CRUD serveurs SSH + workspaces
│   │   ├── deploymentService.ts    # Orchestration déploiement ERPLibre
│   │   ├── transcriptionService.ts # Transcription audio/vidéo (Whisper)
│   │   ├── processService.ts       # Journal persistant des transcriptions et téléchargements
│   │   └── note/                   # Services de notes (3 sous-services)
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

Au démarrage, un écran de boot statique (HTML pur) affiche chaque étape en temps réel avant que le framework Owl soit monté :

1. Masquage du splash screen natif Capacitor
2. **Vérification biométrique** — si activée par l'utilisateur, prompt natif avant tout accès aux données
3. Récupération / génération de la clé d'encryption SQLite (SecureStorage)
4. Initialisation de la base SQLite chiffrée
5. Exécution des migrations de données
6. Création des services : `AppService`, `NoteService`, `IntentService`, `ProcessService` (initialisation : marquage des processus interrompus + chargement de l'historique)
7. Montage du `RootComponent` sur le DOM — l'écran de boot est retiré
8. Écoute des événements de navigation et de caméra

Si la biométrie échoue ou qu'une erreur survient, le message s'affiche sur l'écran de boot sans bloquer l'utilisateur dans un état invisble.

## Sécurité des données

### Chiffrement SQLite

La base de données locale est chiffrée avec **SQLCipher (AES-256)** via `@capacitor-community/sqlite`.

| Étape | Détail |
|-------|--------|
| 1re installation | Clé aléatoire 256 bits (Web Crypto API) générée et stockée dans SecureStorage |
| Démarrages suivants | Clé récupérée depuis SecureStorage ; `setEncryptionSecret` n'est appelé qu'à la 1re installation |
| Ouverture de la DB | `createConnection(db, encrypted=true, mode="secret")` |

La clé est stockée dans **Android Keystore / iOS Keychain** via `capacitor-secure-storage-plugin`, protégée par le matériel sécurisé de l'appareil (TEE/StrongBox).

### Protection biométrique (opt-in)

Activable par l'utilisateur depuis **Options → Activer biométrie**.

Quand activée, une authentification biométrique (empreinte ou reconnaissance faciale) est requise **avant** la récupération de la clé SQLite. Si le capteur est absent, l'étape est silencieusement ignorée.

```
Démarrage
  └── biométrie activée ?
        ├── non  → récupère la clé directement
        └── oui  → prompt natif
              ├── succès → récupère la clé → ouvre la DB
              └── échec  → arrêt sur l'écran de boot
```

## Capacitor — pont Web/Natif

Capacitor synchronise les fichiers web compilés (`dist/`) vers le projet Android natif. Les plugins Capacitor utilisés :

| Plugin | Usage |
|--------|-------|
| `@capacitor-community/sqlite` | Base de données locale chiffrée (SQLCipher AES-256) |
| `capacitor-secure-storage-plugin` | Stockage sécurisé (Android Keystore / iOS Keychain) |
| `@aparajita/capacitor-biometric-auth` | Biométrie (empreinte / reconnaissance faciale) |
| `@capacitor/geolocation` | GPS |
| `@capacitor/camera` | Photo |
| `capacitor-voice-recorder` | Audio |
| `@capacitor-community/video-recorder` | Vidéo |
| `@supernotes/capacitor-send-intent` | Intents Android (partage) |
| `SshPlugin` *(custom)* | Connexion SSH + exécution de commandes (JSch) |
| `WhisperPlugin` *(custom)* | Transcription audio locale (whisper.cpp / GGML) |
| `OcrPlugin` *(custom)* | Détection de texte via ML Kit (caméra vidéo) |
| `NetworkScanPlugin` *(custom)* | Scan réseau SSH (50 threads, détection bannière) |

## Permissions Android

Déclarées dans `android/app/src/main/AndroidManifest.xml` :

- `INTERNET`
- `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `android.hardware.location.gps`
- `RECORD_AUDIO`
- `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`

> **Note** : Le scan réseau SSH (`NetworkScanPlugin`) utilise `NetworkInterface.getNetworkInterfaces()` pour détecter l'adresse IPv4 locale — aucune permission Android spécifique n'est requise (fonctionne sur WiFi, Ethernet, partage USB).

## Pattern architectural global

```
Composants Owl
    │  événements (EventBus)
    ▼
Services (AppService, NoteService, ServerService, DeploymentService,
          TranscriptionService, ProcessService, IntentService, SyncService)
    │  appels async
    ▼
DatabaseService (SQLite via Capacitor)
    │  plugins Capacitor
    ▼
APIs natives Android (GPS, caméra, audio, biométrie, SSH, Whisper, ML Kit, OCR, NetworkScan)
```

## Variables d'environnement Vite

| Variable | Description |
|----------|-------------|
| `VITE_TITLE` | Titre de l'app |
| `VITE_LABEL_NOTE` | Libellé personnalisé pour les notes |
| `VITE_LOGO_KEY` | Identifiant du logo |
| `VITE_WEBSITE_URL` | URL du site web |
| `VITE_DEBUG_DEV` | Activer le mode debug |
