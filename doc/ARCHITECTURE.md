
# Architecture

## Technical stack

| Layer | Technology | Version |
|-------|------------|---------|
| UI Framework | Odoo Owl | 2.8.1 |
| Build | Vite | 6.4.2 |
| Language | TypeScript | — |
| Native bridge | Capacitor | 7.4.4 |
| Local database | @capacitor-community/sqlite | 7.0.2 |
| Styles | SCSS | — |
| Target platform | Android | — |

## Directory structure

```
erplibre_home_mobile/
├── src/
│   ├── js/
│   │   ├── app.ts              # Entry point, app bootstrap
│   │   ├── router.ts           # SPA routing engine
│   │   └── routes.ts           # Route table
│   ├── components/             # Owl components (38 TypeScript files)
│   ├── services/               # Business logic
│   │   ├── appService.ts           # Odoo application management
│   │   ├── databaseService.ts      # SQLite abstraction
│   │   ├── intentService.ts        # Android intents (sharing)
│   │   ├── serverService.ts        # SSH server + workspace CRUD
│   │   ├── deploymentService.ts    # ERPLibre deployment orchestration
│   │   ├── transcriptionService.ts # Audio/video transcription (Whisper)
│   │   ├── processService.ts       # Persistent log of transcriptions and downloads
│   │   └── note/                   # Note services (3 sub-services)
│   ├── models/                 # TypeScript interfaces
│   ├── utils/                  # Utilities
│   ├── constants/              # Application constants
│   └── css/                    # SCSS styles
├── android/                    # Native Android project (Capacitor)
├── dist/                       # Build output (web)
├── scripts/                    # Helper scripts
├── package.json
├── vite.config.ts
└── capacitor.config.json
```

## Application bootstrap (`src/js/app.ts`)

At startup, a static boot screen (plain HTML) shows each step in real time before the Owl framework is mounted:

1. Hide the native Capacitor splash screen
2. **Biometric check** — if the user enabled it, a native prompt appears before any data access
3. Retrieve / generate the SQLite encryption key (SecureStorage)
4. Initialise the encrypted SQLite database
5. Run the data migrations
6. Create the services: `AppService`, `NoteService`, `IntentService`, `ProcessService` (initialisation: mark interrupted processes + load history)
7. Mount `RootComponent` on the DOM — the boot screen is removed
8. Listen for navigation and camera events

If biometrics fail or an error occurs, the message is shown on the boot screen rather than leaving the user stuck in an invisible state.

## Data security

### SQLite encryption

The local database is encrypted with **SQLCipher (AES-256)** through `@capacitor-community/sqlite`.

| Step | Detail |
|------|--------|
| First install | Random 256-bit key (Web Crypto API) generated and stored in SecureStorage |
| Later startups | Key read from SecureStorage; `setEncryptionSecret` is only called on first install |
| Opening the DB | `createConnection(db, encrypted=true, mode="secret")` |

The key is stored in the **Android Keystore / iOS Keychain** through `capacitor-secure-storage-plugin`, protected by the device's secure hardware (TEE/StrongBox).

### Biometric protection (opt-in)

The user enables it from **Options → Activer biométrie**.

When enabled, biometric authentication (fingerprint or face recognition) is required **before** the SQLite key is retrieved. If no sensor is present, the step is silently skipped.

```
Startup
  └── biometrics enabled?
        ├── no   → retrieve the key directly
        └── yes  → native prompt
              ├── success → retrieve the key → open the DB
              └── failure → stop on the boot screen
```

## Capacitor — the web/native bridge

Capacitor syncs the compiled web files (`dist/`) into the native Android project. The Capacitor plugins in use:

| Plugin | Use |
|--------|-----|
| `@capacitor-community/sqlite` | Encrypted local database (SQLCipher AES-256) |
| `capacitor-secure-storage-plugin` | Secure storage (Android Keystore / iOS Keychain) |
| `@aparajita/capacitor-biometric-auth` | Biometrics (fingerprint / face recognition) |
| `@capacitor/geolocation` | GPS |
| `@capacitor/camera` | Photo |
| `capacitor-voice-recorder` | Audio |
| `@capacitor-community/video-recorder` | Video |
| `@supernotes/capacitor-send-intent` | Android intents (sharing) |
| `SshPlugin` *(custom)* | SSH connection + command execution (JSch) |
| `WhisperPlugin` *(custom)* | On-device audio transcription (whisper.cpp / GGML) |
| `OcrPlugin` *(custom)* | Text detection through ML Kit (video camera) |
| `NetworkScanPlugin` *(custom)* | SSH network scan (50 threads, banner detection) |

## Android permissions

Declared in `android/app/src/main/AndroidManifest.xml`:

- `INTERNET`
- `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `android.hardware.location.gps`
- `RECORD_AUDIO`
- `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`

> **Note**: The SSH network scan (`NetworkScanPlugin`) uses `NetworkInterface.getNetworkInterfaces()` to find the local IPv4 address — no specific Android permission is required (it works over WiFi, Ethernet and USB tethering).

## Overall architectural pattern

```
Owl components
    │  events (EventBus)
    ▼
Services (AppService, NoteService, ServerService, DeploymentService,
          TranscriptionService, ProcessService, IntentService, SyncService)
    │  async calls
    ▼
DatabaseService (SQLite through Capacitor)
    │  Capacitor plugins
    ▼
Native Android APIs (GPS, camera, audio, biometrics, SSH, Whisper, ML Kit, OCR, NetworkScan)
```

## Vite environment variables

| Variable | Description |
|----------|-------------|
| `VITE_TITLE` | App title |
| `VITE_LABEL_NOTE` | Custom label for notes |
| `VITE_LOGO_KEY` | Logo identifier |
| `VITE_WEBSITE_URL` | Website URL |
| `VITE_DEBUG_DEV` | Enable debug mode |
