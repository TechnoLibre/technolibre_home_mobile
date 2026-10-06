<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Native Capacitor plugins (custom)

These plugins are implemented in Java under `android/app/src/main/java/ca/erplibre/home/`
and registered in `MainActivity.java` through `registerPlugin(...)`.

---

## SshPlugin

**Files:**
- TS bridge: `src/plugins/sshPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/SshPlugin.java`

**Library:** JSch (`com.jcraft:jsch:0.1.55`)

### API

| Method | Description |
|--------|-------------|
| `connect(opts)` | Opens a JSch SSH session. `authType: "password"` or `"key"`; `credential` is the password or the PEM key; `passphrase` optional. |
| `execute(opts)` | Runs a command in a `ChannelExec`. Fires `sshOutput` events in real time (stdout + stderr). Resolves with `{ exitCode }` at the end. |
| `disconnect()` | Closes the SSH session. |
| `addListener("sshOutput", fn)` | Listens to the output lines of the running command. `fn` receives `{ line: string; stream: "stdout" | "stderr" }`. |

### Usage pattern

```typescript
await SshPlugin.connect({ host, port, username, authType: "password", credential: password });

const listener = await SshPlugin.addListener("sshOutput", ({ line, stream }) => {
    console.log(`[${stream}] ${line}`);
});

const { exitCode } = await SshPlugin.execute({ command: "make install" });
await listener.remove();
await SshPlugin.disconnect();
```

---

## WhisperPlugin

**Files:**
- TS bridge: `src/plugins/whisperPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/WhisperPlugin.java`

**Library:** whisper.cpp through NDK/JNI (the `WhisperLib` AAR is included in the Android project)

GGML models are stored in `{filesDir}/whisper/ggml-<model>.bin`.

### API

| Method | Description |
|--------|-------------|
| `isModelLoaded()` | Returns `{ loaded: boolean }` — whether a model is already in memory. |
| `loadModel({ model })` | Loads the GGML model into memory through `WhisperLib.initContext()`. |
| `getModelPath({ model })` | Returns `{ path: string; exists: boolean }` — the absolute path of the `.bin` on the device. Returns `exists: false` when only the `.partial` file is present. |
| `downloadModel({ model, url })` | Downloads in **WakeLock** mode (CPU/network stay awake with the screen off). For fresh downloads with a known `Content-Length`, uses 4 parallel HTTP Range connections (`ExecutorService` + positional `FileChannel`) to saturate the bandwidth. Resumes from the `.partial` file single-threaded. Fires `downloadProgress` events. Resolves with `{ path }`. |
| `downloadModelForeground({ model, url })` | Downloads through an **Android Foreground Service** with a persistent notification (Cancel button). Survives screen-off without a WakeLock. If the service is already running for the same model (e.g. after an Activity was recreated), reattaches the JS Promise instead of starting a second thread. Resolves with `{ path }`. |
| `getServiceStatus()` | Returns `{ downloading: boolean; model: string }` — the state of the Foreground Service. Used by the JS layer to reattach after an Activity was recreated. |
| `cancelDownload({ model? })` | Cancels the download of the named model, or every download when `model` is omitted. The `.partial` file is **kept** so a later resume is possible (WakeLock). Cancelled multi-threaded downloads delete the `.partial` (its data is incomplete and non-sequential). |
| `transcribe({ audioPath, lang? })` | Transcribes an audio file. `audioPath` is relative to `filesDir`. `lang` is a BCP-47 code (default `"fr"`). Resolves with `{ text }`. |
| `unloadModel()` | Frees the model from memory. |
| `deleteModel({ model })` | Deletes the `.bin` binary from disk (and the `.partial` when present). Unloads the model from memory when needed. |
| `addListener("progress", fn)` | Transcription progress. `fn` receives `{ ratio: number; text: string }`. |
| `addListener("downloadProgress", fn)` | Download progress (WakeLock and Foreground). `fn` receives `{ model: string; ratio: number; received: number; total: number }`. The `model` field lets events be routed when several models download in parallel. |

### Download modes

```
downloadModel()                    downloadModelForeground()
─────────────────────────────      ──────────────────────────────────────
Java background thread             Separate Android Foreground Service
PARTIAL_WAKE_LOCK WakeLock         Persistent notification + Cancel button
Parallel (4 HTTP Range threads)    Single-threaded (robust, files ≥ 1 GB)
.partial resume (single-threaded)  .partial resume
One OS notification per model      Single notification (NOTIF_ID 9001)
Per-model cancellation (flag)      Cancellation through ACTION_CANCEL Intent
```

### Multi-threaded download (WakeLock)

For fresh downloads (no `.partial` file) with a known `Content-Length`:

1. **Pre-allocation**: `RandomAccessFile.setLength(total)` reserves the disk space.
2. **4 threads**: each thread opens its own `HttpURLConnection` with `Range: bytes=X-Y` and writes through `FileChannel.write(ByteBuffer, position)` — with no overlap.
3. **Atomic progress**: `AtomicLong totalReceived` + `AtomicInteger notifPct` — one notification per percentage point, thread-safe.
4. **Failure**: if the server does not answer HTTP 206, the `.partial` is deleted and the Promise is rejected. The next call starts over single-threaded (no `.partial` → a fresh download).

### Why the download is native

Downloading through JavaScript (`fetch` + `btoa()`) allocated ~600 MB in the WebView for a 244 MB model (base64 overhead ×2.7), causing a silent OOM. The resulting file was truncated and `WhisperLib.initContext()` returned 0 (null pointer) with no explicit error message.

The answer is a Java `HttpURLConnection` on a background thread, streaming straight into a `FileOutputStream` in 64 KB chunks. No data goes through the WebView.

### Path normalisation for video

Capacitor exposes video files under a WebView scheme (`https://localhost/_capacitor_file_/...`). That path is not recognised by `File()` on the Java side. Two layers of normalisation are applied:

1. **TypeScript** (`NoteEntryVideoComponent.toNativePath()`) — strips the `https://localhost/_capacitor_file_` prefix (with or without the trailing underscore) before handing the path to the service.
2. **Java** (`WhisperPlugin.java`) — a native-side normalisation as a fallback, for any un-normalised path that reaches the plugin.

The original path (before normalisation) is kept only to be shown in the process debug log.

---

## OcrPlugin

**Files:**
- TS bridge: `src/plugins/ocrPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/OcrPlugin.java`

**Library:** ML Kit Text Recognition (`com.google.mlkit:text-recognition`)

### API

| Method | Description |
|--------|-------------|
| `startScan(opts?)` | Starts the periodic analysis. `opts.intervalMs` controls the analysis rate (the default is set on the Java side). Fires `textDetected` events for every frame that contains text. |
| `stopScan()` | Stops the OCR analysis. |
| `addListener("textDetected", fn)` | Receives `{ blocks: TextBlock[] }` on every detection. |

### The `TextBlock` interface

```typescript
interface TextBlock {
    text: string;    // text detected in this block
    x: number;       // normalised left edge (0–1)
    y: number;       // normalised top edge (0–1)
    width: number;   // normalised width (0–1)
    height: number;  // normalised height (0–1)
}
```

### Typical use

The plugin is driven from the video camera component. The analysis runs at a regular interval on the rear camera stream, with no explicit frame capture.

---

## NetworkScanPlugin

**Files:**
- TS bridge: `src/plugins/networkScanPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/NetworkScanPlugin.java`

### API

| Method | Description |
|--------|-------------|
| `scan({ timeoutMs? })` | Scans the local /24 subnet for SSH services (port 22). Fires `hostFound` events in real time. Resolves with `{ hosts: ScannedHost[] }` at the end. |
| `cancelScan()` | Cancels a running scan. |
| `addListener("hostFound", fn)` | Receives `{ host: string; port: number; banner: string }` for every machine found. |

### Implementation

- **Local IP detection**: `NetworkInterface.getNetworkInterfaces()` — no Android permission required (works over WiFi, Ethernet and USB tethering).
- **Parallel scan**: `Executors.newFixedThreadPool(50)` + `CountDownLatch(254)` to scan all 254 addresses of a /24 in parallel.
- **SSH detection**: `Socket.connect(InetSocketAddress, timeoutMs)` + reading the banner (an `"SSH-"` prefix confirms an SSH service).
- **Cancellation**: `AtomicBoolean isScanning` + `executor.shutdownNow()`.

### The `ScannedHost` interface

```typescript
interface ScannedHost {
    host: string;       // IPv4, e.g. "192.168.1.42"
    port: number;       // always 22
    banner: string;     // e.g. "SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6"
    hostname?: string;  // reverse DNS name when the local network has PTR records
}
```

---

## DeviceStatsPlugin

**Files:**
- TS bridge: `src/plugins/deviceStatsPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/DeviceStatsPlugin.java`

A plugin that monitors system resources in real time (CPU, RAM, battery).
Used by `options_resources_component` to draw graphs refreshed at a configurable interval.

### API

| Method | Description |
|--------|-------------|
| `startPolling({ intervalMs })` | Starts collecting metrics at the given interval (ms). Fires `stats` events continuously. |
| `stopPolling()` | Stops the collection. |
| `addListener("stats", fn)` | Receives the metrics on every tick. `fn` receives `DeviceStats`. |

### The `DeviceStats` interface

```typescript
interface DeviceStats {
    cpuPercent:      number;   // overall CPU usage (0–100)
    ramUsedMb:       number;   // RAM used, in MB
    ramTotalMb:      number;   // total RAM, in MB
    batteryPercent:  number;   // battery level (0–100)
    batteryCharging: boolean;  // true when plugged in
}
```

### Implementation

- **CPU**: reads `/proc/stat` across two intervals — the `(total - idle) / total` difference as a percentage.
- **RAM**: `ActivityManager.MemoryInfo` — `totalMem` and `availMem` (subtracted to get `usedMem`).
- **Battery**: the `ACTION_BATTERY_CHANGED` `Intent` through `registerReceiver(null, ...)` — no permission required.
- **Polling**: a `Handler` + `Runnable` on the main thread; stopped cleanly by `stopPolling()` or when the plugin is destroyed.

---

<!-- [fr] -->
# Plugins Capacitor natifs (custom)

Ces plugins sont implémentés en Java dans `android/app/src/main/java/ca/erplibre/home/`
et enregistrés dans `MainActivity.java` via `registerPlugin(...)`.

---

## SshPlugin

**Fichiers :**
- Bridge TS : `src/plugins/sshPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/SshPlugin.java`

**Bibliothèque :** JSch (`com.jcraft:jsch:0.1.55`)

### API

| Méthode | Description |
|---------|-------------|
| `connect(opts)` | Ouvre une session JSch SSH. `authType: "password"` ou `"key"` ; `credential` est le mot de passe ou la clé PEM ; `passphrase` optionnel. |
| `execute(opts)` | Exécute une commande dans un `ChannelExec`. Fire des événements `sshOutput` en temps réel (stdout + stderr). Résout avec `{ exitCode }` à la fin. |
| `disconnect()` | Ferme la session SSH. |
| `addListener("sshOutput", fn)` | Écoute les lignes de sortie de la commande en cours. `fn` reçoit `{ line: string; stream: "stdout" | "stderr" }`. |

### Pattern d'utilisation

```typescript
await SshPlugin.connect({ host, port, username, authType: "password", credential: password });

const listener = await SshPlugin.addListener("sshOutput", ({ line, stream }) => {
    console.log(`[${stream}] ${line}`);
});

const { exitCode } = await SshPlugin.execute({ command: "make install" });
await listener.remove();
await SshPlugin.disconnect();
```

---

## WhisperPlugin

**Fichiers :**
- Bridge TS : `src/plugins/whisperPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/WhisperPlugin.java`

**Bibliothèque :** whisper.cpp via NDK/JNI (`WhisperLib` AAR inclus dans le projet Android)

Les modèles GGML sont stockés dans `{filesDir}/whisper/ggml-<model>.bin`.

### API

| Méthode | Description |
|---------|-------------|
| `isModelLoaded()` | Retourne `{ loaded: boolean }` — si un modèle est déjà en mémoire. |
| `loadModel({ model })` | Charge le modèle GGML en mémoire via `WhisperLib.initContext()`. |
| `getModelPath({ model })` | Retourne `{ path: string; exists: boolean }` — chemin absolu du `.bin` sur l'appareil. Renvoie `exists: false` si seul le fichier `.partial` est présent. |
| `downloadModel({ model, url })` | Télécharge en mode **WakeLock** (CPU/réseau actifs même écran éteint). Pour les téléchargements frais avec `Content-Length` connu, utilise 4 connexions HTTP Range en parallèle (`ExecutorService` + `FileChannel` positionnel) pour saturer la bande passante. Reprise depuis le fichier `.partial` en mono-thread. Fire des événements `downloadProgress`. Résout avec `{ path }`. |
| `downloadModelForeground({ model, url })` | Télécharge via un **Android Foreground Service** avec une notification persistante (bouton Annuler). Survit à l'extinction de l'écran sans WakeLock. Si le service est déjà actif pour le même modèle (ex : après recréation d'Activity), ré-attache la Promise JS sans démarrer un second thread. Résout avec `{ path }`. |
| `getServiceStatus()` | Retourne `{ downloading: boolean; model: string }` — état du Foreground Service. Utilisé par la couche JS pour se ré-attacher après une recréation d'Activity. |
| `cancelDownload({ model? })` | Annule le téléchargement du modèle indiqué, ou tous les téléchargements si `model` est omis. Le fichier `.partial` est **conservé** pour permettre une reprise ultérieure (WakeLock). Les téléchargements multi-thread annulés suppriment le `.partial` (données incomplètes non-séquentielles). |
| `transcribe({ audioPath, lang? })` | Transcrit un fichier audio. `audioPath` est relatif à `filesDir`. `lang` est un code BCP-47 (défaut `"fr"`). Résout avec `{ text }`. |
| `unloadModel()` | Libère le modèle de la mémoire. |
| `deleteModel({ model })` | Supprime le binaire `.bin` du disque (et le `.partial` si présent). Décharge le modèle de la mémoire si nécessaire. |
| `addListener("progress", fn)` | Progression de la transcription. `fn` reçoit `{ ratio: number; text: string }`. |
| `addListener("downloadProgress", fn)` | Progression du téléchargement (WakeLock et Foreground). `fn` reçoit `{ model: string; ratio: number; received: number; total: number }`. Le champ `model` permet de router les événements quand plusieurs modèles se téléchargent en parallèle. |

### Modes de téléchargement

```
downloadModel()                    downloadModelForeground()
─────────────────────────────      ──────────────────────────────────────
Thread background Java             Android Foreground Service séparé
WakeLock PARTIAL_WAKE_LOCK         Notification persistante + bouton Annuler
Parallèle (4 threads HTTP Range)   Mono-thread (robuste, fichiers ≥ 1 Go)
Reprise .partial (mono-thread)     Reprise .partial
Notifications OS par modèle        Notification unique (NOTIF_ID 9001)
Annulation par-modèle (flag)       Annulation via Intent ACTION_CANCEL
```

### Téléchargement multi-thread (WakeLock)

Pour les téléchargements frais (aucun fichier `.partial`) avec `Content-Length` connu :

1. **Pré-allocation** : `RandomAccessFile.setLength(total)` réserve l'espace disque.
2. **4 threads** : chaque thread ouvre sa propre `HttpURLConnection` avec `Range: bytes=X-Y` et écrit via `FileChannel.write(ByteBuffer, position)` — sans superposition.
3. **Progression atomique** : `AtomicLong totalReceived` + `AtomicInteger notifPct` — une seule notification par point de pourcentage, thread-safe.
4. **Échec** : si le serveur ne retourne pas HTTP 206, le `.partial` est supprimé et la Promise est rejetée. Le prochain appel recommence en mono-thread (pas de `.partial` → nouveau téléchargement).

### Pourquoi le téléchargement est natif

Le téléchargement via JavaScript (`fetch` + `btoa()`) allouait ~600 Mo en WebView pour un modèle de 244 Mo (base64 overhead ×2.7), causant un OOM silencieux. Le fichier résultant était tronqué et `WhisperLib.initContext()` retournait 0 (null pointer) sans message d'erreur explicite.

La solution est un `HttpURLConnection` Java en thread background, streaming direct vers `FileOutputStream` en chunks de 64 KB. Aucune donnée ne transite par la WebView.

### Normalisation de chemin pour la vidéo

Capacitor expose les fichiers vidéo sous un schéma WebView (`https://localhost/_capacitor_file_/...`). Ce chemin n'est pas reconnu par `File()` côté Java. Deux couches de normalisation sont appliquées :

1. **TypeScript** (`NoteEntryVideoComponent.toNativePath()`) — retire le préfixe `https://localhost/_capacitor_file_` (avec ou sans underscore terminal) avant de passer le chemin au service.
2. **Java** (`WhisperPlugin.java`) — normalisation côté natif en secours, pour les chemins non normalisés qui atteindraient le plugin.

Le chemin original (avant normalisation) est conservé uniquement pour l'affichage dans le log de débogage du processus.

---

## OcrPlugin

**Fichiers :**
- Bridge TS : `src/plugins/ocrPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/OcrPlugin.java`

**Bibliothèque :** ML Kit Text Recognition (`com.google.mlkit:text-recognition`)

### API

| Méthode | Description |
|---------|-------------|
| `startScan(opts?)` | Démarre l'analyse périodique. `opts.intervalMs` contrôle la fréquence d'analyse (défaut défini côté Java). Fire des événements `textDetected` à chaque frame contenant du texte. |
| `stopScan()` | Arrête l'analyse OCR. |
| `addListener("textDetected", fn)` | Reçoit `{ blocks: TextBlock[] }` à chaque détection. |

### Interface `TextBlock`

```typescript
interface TextBlock {
    text: string;    // texte détecté dans ce bloc
    x: number;       // bord gauche normalisé (0–1)
    y: number;       // bord haut normalisé (0–1)
    width: number;   // largeur normalisée (0–1)
    height: number;  // hauteur normalisée (0–1)
}
```

### Usage typique

Le plugin est utilisé depuis le composant caméra vidéo. L'analyse se fait à intervalle régulier sur le flux de la caméra arrière, sans capture explicite de frame.

---

## NetworkScanPlugin

**Fichiers :**
- Bridge TS : `src/plugins/networkScanPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/NetworkScanPlugin.java`

### API

| Méthode | Description |
|---------|-------------|
| `scan({ timeoutMs? })` | Scanne le sous-réseau /24 local pour les services SSH (port 22). Fire des événements `hostFound` en temps réel. Résout avec `{ hosts: ScannedHost[] }` à la fin. |
| `cancelScan()` | Annule un scan en cours. |
| `addListener("hostFound", fn)` | Reçoit `{ host: string; port: number; banner: string }` pour chaque machine découverte. |

### Implémentation

- **Détection de l'IP locale** : `NetworkInterface.getNetworkInterfaces()` — aucune permission Android requise (fonctionne sur WiFi, Ethernet, USB-tethering).
- **Scan parallèle** : `Executors.newFixedThreadPool(50)` + `CountDownLatch(254)` pour scanner les 254 adresses d'un /24 en parallèle.
- **Détection SSH** : `Socket.connect(InetSocketAddress, timeoutMs)` + lecture de la bannière (`"SSH-"` prefix confirme un service SSH).
- **Annulation** : `AtomicBoolean isScanning` + `executor.shutdownNow()`.

### Interface `ScannedHost`

```typescript
interface ScannedHost {
    host: string;       // IPv4, ex: "192.168.1.42"
    port: number;       // toujours 22
    banner: string;     // ex: "SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6"
    hostname?: string;  // nom DNS inversé si le réseau local a des enregistrements PTR
}
```

---

## DeviceStatsPlugin

**Fichiers :**
- Bridge TS : `src/plugins/deviceStatsPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/DeviceStatsPlugin.java`

Plugin de surveillance des ressources système en temps réel (CPU, RAM, batterie).
Utilisé par `options_resources_component` pour afficher des graphiques mis à jour à intervalle configurable.

### API

| Méthode | Description |
|---------|-------------|
| `startPolling({ intervalMs })` | Démarre la collecte des métriques à l'intervalle donné (ms). Fire des événements `stats` en continu. |
| `stopPolling()` | Arrête la collecte. |
| `addListener("stats", fn)` | Reçoit les métriques à chaque tick. `fn` reçoit `DeviceStats`. |

### Interface `DeviceStats`

```typescript
interface DeviceStats {
    cpuPercent:      number;   // utilisation CPU globale (0–100)
    ramUsedMb:       number;   // RAM utilisée en Mo
    ramTotalMb:      number;   // RAM totale en Mo
    batteryPercent:  number;   // niveau batterie (0–100)
    batteryCharging: boolean;  // vrai si branché
}
```

### Implémentation

- **CPU** : lecture de `/proc/stat` entre deux intervalles — différence `(total - idle) / total` en pourcentage.
- **RAM** : `ActivityManager.MemoryInfo` — `totalMem` et `availMem` (soustraction pour `usedMem`).
- **Batterie** : `Intent` `ACTION_BATTERY_CHANGED` via `registerReceiver(null, ...)` — sans permission requise.
- **Polling** : `Handler` + `Runnable` sur le thread principal ; stoppé proprement par `stopPolling()` ou destruction du plugin.

---


<!-- [en] -->
## MarianPlugin

**Fichiers :**
- Bridge TS : `src/plugins/marianPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/MarianPlugin.java`
- JNI bridge : `android/app/src/main/java/ca/erplibre/home/MarianLib.java`
- Native library : `libmarian_jni.so` (built via NDK from `android/app/src/main/cpp/`)

**Libraries :**
- ONNX Runtime Android (`com.microsoft.onnxruntime:onnxruntime-android:1.20.0`)
- SentencePiece (Google) — JNI, must be cloned manually (see Build note below)

On-device FR↔EN translation using Helsinki-NLP MarianMT ONNX models. No internet connection
and no external server are required at inference time. All model files are stored in
`{filesDir}/marian/{model}/`.

### JNI bridge (`MarianLib`)

`MarianLib.java` wraps `libmarian_jni.so`. It exposes four native methods
(`loadModel`, `freeModel`, `encode`, `decode`) and a static `isAvailable()` guard that
returns `false` when the library failed to load (sentencepiece not compiled). The plugin
checks `isAvailable()` at the start of every `translate` call and rejects with an actionable
message if the library is absent.

### API

| Method | Description |
|--------|-------------|
| `isModelDownloaded({ model })` | Returns `{ exists: boolean }`. True when all four model files (`encoder.onnx`, `decoder.onnx`, `source.spm`, `target.spm`) are present on disk. |
| `downloadModel({ model })` | Download all four model files sequentially with HTTP Range resume support. Fires `downloadProgress` events. Rejects if the model key is unknown or the download is cancelled. |
| `translate({ text, model })` | Tokenise with SentencePiece, run the ONNX encoder, then beam-search decode (beam width 4) with the ONNX decoder. Returns `{ text: string }`. Rejects if the native library is unavailable or the model is not downloaded. |
| `deleteModel({ model })` | Delete all model files for the variant. Unloads ORT sessions if that variant is currently loaded in memory. |
| `cancelDownload()` | Set the cancel flag. The download thread checks it between files and after each 64 KB chunk. |
| `addListener("downloadProgress", fn)` | Per-file download progress. See `MarianDownloadProgress` interface below. |

### Model variants

| Model key | Direction | Quality (1–5) | Speed (1–5) | Size | Recommended |
|-----------|-----------|:---:|:---:|------|:-----------:|
| `fr-en-tiny` | FR → EN | 2 | 5 | ~82 MB | No |
| `fr-en-base` | FR → EN | 3 | 3 | ~182 MB | Yes |
| `en-fr-tiny` | EN → FR | 2 | 5 | ~82 MB | No |
| `en-fr-base` | EN → FR | 3 | 3 | ~182 MB | Yes |

`tiny` variants use int8 quantized ONNX models (`encoder_model_quantized.onnx`).
`base` variants use float32 models (`encoder_model.onnx`). ONNX files come from
`Xenova/opus-mt-*` on HuggingFace; SentencePiece vocabularies come from
`Helsinki-NLP/opus-mt-*`.

### `downloadProgress` event

```typescript
interface MarianDownloadProgress {
    model:         MarianModel;  // e.g. "fr-en-base"
    file:          string;       // "encoder.onnx" | "decoder.onnx" | "source.spm" | "target.spm"
    percent:       number;       // 0–100
    receivedBytes: number;
    totalBytes:    number;
}
```

Files are downloaded sequentially. The `file` field identifies which of the four files is
currently downloading.

### TypeScript usage example

```typescript
import { MarianPlugin } from "../plugins/marianPlugin";

const { exists } = await MarianPlugin.isModelDownloaded({ model: "fr-en-base" });

if (!exists) {
    const listener = await MarianPlugin.addListener("downloadProgress", (e) => {
        console.log(`${e.file}: ${e.percent}%`);
    });
    await MarianPlugin.downloadModel({ model: "fr-en-base" });
    await listener.remove();
}

const { text } = await MarianPlugin.translate({
    text: "Bonjour le monde",
    model: "fr-en-base",
});
// text → "Hello world"
```

### Build note: SentencePiece NDK dependency

The SentencePiece source tree must be cloned manually before building the app:

```bash
git clone --depth=1 https://github.com/google/sentencepiece \
    android/app/src/main/cpp/sentencepiece
```

`android/app/src/main/cpp/CMakeLists.txt` expects this directory to be present. If it is
absent, `libmarian_jni.so` is not built, `MarianLib.isAvailable()` returns `false` at
runtime, and all `translate` calls are rejected gracefully. Download and model management
still work without the native library.

### Known limitations

- **Android only.** `MarianPlugin` is not registered on iOS or in the browser.
  `TranslationService` checks `Capacitor.isNativePlatform()` before calling the plugin and
  rejects with a clear message otherwise.
- **ORT direct `ByteBuffer` requirement.** ORT JNI on Android requires native-order direct
  `ByteBuffer`s for float and long tensors; heap-allocated arrays cause silent data
  corruption or JNI errors. All tensor construction in the plugin uses
  `ByteBuffer.allocateDirect(...).order(ByteOrder.nativeOrder())`.
- **Single model in memory.** Only one variant is kept loaded at a time. Switching variants
  triggers a full session reload (encoder + decoder ORT sessions + two SentencePiece
  models).
- **Single-threaded executor.** Downloads and translations share one `ExecutorService`. A
  translation request queued while a download is in progress will wait until all four files
  finish.

<!-- [fr] -->
## MarianPlugin

**Fichiers :**
- Bridge TS : `src/plugins/marianPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/MarianPlugin.java`
- Pont JNI : `android/app/src/main/java/ca/erplibre/home/MarianLib.java`
- Bibliothèque native : `libmarian_jni.so` (compilée par le NDK depuis `android/app/src/main/cpp/`)

**Bibliothèques :**
- ONNX Runtime Android (`com.microsoft.onnxruntime:onnxruntime-android:1.20.0`)
- SentencePiece (Google) — JNI, à cloner manuellement (voir la note de compilation ci-dessous)

Traduction FR↔EN sur l'appareil, avec les modèles ONNX MarianMT de Helsinki-NLP. Aucune
connexion Internet ni serveur externe n'est nécessaire à l'inférence. Tous les fichiers de
modèle sont stockés dans `{filesDir}/marian/{model}/`.

### Pont JNI (`MarianLib`)

`MarianLib.java` enveloppe `libmarian_jni.so`. Il expose quatre méthodes natives
(`loadModel`, `freeModel`, `encode`, `decode`) et un garde statique `isAvailable()` qui
renvoie `false` quand la bibliothèque n'a pas pu être chargée (sentencepiece non compilé).
Le plugin vérifie `isAvailable()` au début de chaque appel à `translate` et rejette avec un
message actionnable si la bibliothèque est absente.

### API

| Méthode | Description |
|---------|-------------|
| `isModelDownloaded({ model })` | Renvoie `{ exists: boolean }`. Vrai quand les quatre fichiers du modèle (`encoder.onnx`, `decoder.onnx`, `source.spm`, `target.spm`) sont présents sur le disque. |
| `downloadModel({ model })` | Télécharge les quatre fichiers séquentiellement, avec reprise par HTTP Range. Fire des événements `downloadProgress`. Rejette si la clé de modèle est inconnue ou si le téléchargement est annulé. |
| `translate({ text, model })` | Tokenise avec SentencePiece, exécute l'encodeur ONNX, puis décode par recherche en faisceau (largeur 4) avec le décodeur ONNX. Renvoie `{ text: string }`. Rejette si la bibliothèque native est indisponible ou si le modèle n'est pas téléchargé. |
| `deleteModel({ model })` | Supprime tous les fichiers de la variante. Libère les sessions ORT si cette variante est chargée en mémoire. |
| `cancelDownload()` | Lève le drapeau d'annulation. Le thread de téléchargement le vérifie entre les fichiers et après chaque bloc de 64 Ko. |
| `addListener("downloadProgress", fn)` | Progression par fichier. Voir l'interface `MarianDownloadProgress` ci-dessous. |

### Variantes de modèle

| Clé de modèle | Direction | Qualité (1–5) | Vitesse (1–5) | Taille | Recommandé |
|---------------|-----------|:---:|:---:|--------|:----------:|
| `fr-en-tiny` | FR → EN | 2 | 5 | ~82 Mo | Non |
| `fr-en-base` | FR → EN | 3 | 3 | ~182 Mo | Oui |
| `en-fr-tiny` | EN → FR | 2 | 5 | ~82 Mo | Non |
| `en-fr-base` | EN → FR | 3 | 3 | ~182 Mo | Oui |

Les variantes `tiny` utilisent des modèles ONNX quantifiés en int8
(`encoder_model_quantized.onnx`). Les variantes `base` utilisent des modèles float32
(`encoder_model.onnx`). Les fichiers ONNX viennent de `Xenova/opus-mt-*` sur HuggingFace ;
les vocabulaires SentencePiece viennent de `Helsinki-NLP/opus-mt-*`.

### Événement `downloadProgress`

```typescript
interface MarianDownloadProgress {
    model:         MarianModel;  // ex. "fr-en-base"
    file:          string;       // "encoder.onnx" | "decoder.onnx" | "source.spm" | "target.spm"
    percent:       number;       // 0–100
    receivedBytes: number;
    totalBytes:    number;
}
```

Les fichiers sont téléchargés séquentiellement. Le champ `file` indique lequel des quatre
est en cours de téléchargement.

### Exemple d'utilisation TypeScript

```typescript
import { MarianPlugin } from "../plugins/marianPlugin";

const { exists } = await MarianPlugin.isModelDownloaded({ model: "fr-en-base" });

if (!exists) {
    const listener = await MarianPlugin.addListener("downloadProgress", (e) => {
        console.log(`${e.file}: ${e.percent}%`);
    });
    await MarianPlugin.downloadModel({ model: "fr-en-base" });
    await listener.remove();
}

const { text } = await MarianPlugin.translate({
    text: "Bonjour le monde",
    model: "fr-en-base",
});
// text → "Hello world"
```

### Note de compilation : la dépendance NDK SentencePiece

L'arborescence source de SentencePiece doit être clonée manuellement avant de compiler
l'application :

```bash
git clone --depth=1 https://github.com/google/sentencepiece \
    android/app/src/main/cpp/sentencepiece
```

`android/app/src/main/cpp/CMakeLists.txt` attend la présence de ce répertoire. S'il est
absent, `libmarian_jni.so` n'est pas compilée, `MarianLib.isAvailable()` renvoie `false` à
l'exécution, et tous les appels à `translate` sont rejetés proprement. Le téléchargement et
la gestion des modèles fonctionnent malgré tout sans la bibliothèque native.

### Limites connues

- **Android seulement.** `MarianPlugin` n'est pas enregistré sur iOS ni dans le navigateur.
  `TranslationService` vérifie `Capacitor.isNativePlatform()` avant d'appeler le plugin et
  rejette avec un message clair sinon.
- **ORT exige des `ByteBuffer` directs.** ORT JNI sur Android exige des `ByteBuffer` directs
  en ordre natif pour les tenseurs float et long ; des tableaux alloués sur le tas
  provoquent une corruption silencieuse des données ou des erreurs JNI. Toute construction
  de tenseur dans le plugin passe par
  `ByteBuffer.allocateDirect(...).order(ByteOrder.nativeOrder())`.
- **Un seul modèle en mémoire.** Une seule variante reste chargée à la fois. Changer de
  variante déclenche un rechargement complet des sessions (sessions ORT encodeur et
  décodeur, plus deux modèles SentencePiece).
- **Exécuteur mono-thread.** Les téléchargements et les traductions partagent un unique
  `ExecutorService`. Une demande de traduction mise en file pendant un téléchargement
  attendra la fin des quatre fichiers.

<!-- [en] -->
---

## StreamDeckPlugin

**Files:**
- TS bridge: `src/plugins/streamDeckPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/streamdeck/`
- USB filter: `android/app/src/main/res/xml/streamdeck_devices.xml`

**Library:** the native Android USB Host API (`UsbManager`, `UsbDeviceConnection`, `bulkTransfer`, `controlTransfer`).

**Supported models:** Elgato Stream Deck Original v1 (`0x0060`), Mini
(`0x0063`), XL (`0x006c`), Original v2 (`0x006d`), MK.2 (`0x0080`),
Plus (`0x0084`), Neo (`0x009a`). Vendor `0x0fd9`.

### API

| Method | Description |
|--------|-------------|
| `listDecks()` | Returns every known deck, each with its capabilities (keys/dials/lcd/infobars/touchpoints). |
| `getDeckInfo({deckId})` | Detail of one deck (model, rows/cols, keyImage, dials, lcd…). |
| `requestPermission({deckId})` | Forces the USB permission request when it is missing. |
| `reset({deckId})` | Clears every key image. |
| `setBrightness({deckId, percent})` | Brightness 0..100. |
| `setKeyImage({deckId, key, bytes, format})` | Pushes an image. `bytes` is base64. `format = "jpeg"` for v2+/MK.2/XL/Plus/Neo, `"png"` for v1/Mini (Java produces the rotated BMP). Resolves `{dropped: true}` when a newer image was pushed for the same key in the meantime. |
| `clearKey({deckId, key})` | A black 1×1 image → the key goes dark. |
| `clearAllKeys({deckId})` | Same as `reset`. |
| `setLcdImage({deckId, bytes})` | Plus only — a full 800×100 JPEG. |
| `setLcdRegion({deckId, x, y, w, h, bytes})` | Plus only — a JPEG for a partial region. |
| `setInfoBar({deckId, index, bytes})` | Neo only — a 248×58 JPEG on the info screen. The Neo has a single screen; `index` must be 0 (forward compatibility with future models). |

### Events

| Event | Payload |
|-------|---------|
| `deckConnected` | `{deckId, info, reason?}` |
| `deckDisconnected` | `{deckId, reason}` (`usb_lost`, `app_destroyed`) |
| `permissionDenied` | `{deckId, reason}` |
| `keyChanged` | `{deckId, key, pressed}` |
| `dialRotated` | `{deckId, dial, delta}` (Plus) |
| `dialPressed` | `{deckId, dial, pressed}` (Plus) |
| `lcdTouched` | `{deckId, type, x, y, xEnd?, yEnd?}` (Plus) |
| `neoTouched` | `{deckId, index, pressed}` (Neo) |

### Persistent identity

Decks are identified by their **USB serial number** (read through a
feature report on connection). A deck that is plugged back in therefore
keeps its `deckId` — preferences, layouts and snapshots can safely be
indexed by that serial.

### Architecture

A strategy pattern. `DeckRegistry` maps `productId → DeckSpec`. One
`DeckSession` per connected deck owns its own reader thread (HID IN),
writer thread (HID OUT consuming a `WriterQueue`), and a
`DeckTransport` + `ImageEncoder` chosen from the spec. Images pushed in
quick succession for the same key are coalesced: the last one wins, the
older ones resolve their Promise with `{dropped: true}`.

### Manual tests

See `doc/streamdeck_test_matrix.md` — a checklist per physical model.

<!-- [fr] -->
---

## StreamDeckPlugin

**Fichiers :**
- Bridge TS : `src/plugins/streamDeckPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/streamdeck/`
- Filtre USB : `android/app/src/main/res/xml/streamdeck_devices.xml`

**Bibliothèque :** Android USB Host API natif (`UsbManager`, `UsbDeviceConnection`, `bulkTransfer`, `controlTransfer`).

**Modèles supportés :** Elgato Stream Deck Original v1 (`0x0060`), Mini
(`0x0063`), XL (`0x006c`), Original v2 (`0x006d`), MK.2 (`0x0080`),
Plus (`0x0084`), Neo (`0x009a`). Vendor `0x0fd9`.

### API

| Méthode | Description |
|---------|-------------|
| `listDecks()` | Retourne tous les decks connus, chacun avec capacités (keys/dials/lcd/infobars/touchpoints). |
| `getDeckInfo({deckId})` | Détail d'un deck (model, rows/cols, keyImage, dials, lcd…). |
| `requestPermission({deckId})` | Force la demande de permission USB si manquante. |
| `reset({deckId})` | Efface toutes les images des touches. |
| `setBrightness({deckId, percent})` | Luminosité 0..100. |
| `setKeyImage({deckId, key, bytes, format})` | Pousse une image. `bytes` = base64. `format = "jpeg"` pour v2+/MK.2/XL/Plus/Neo, `"png"` pour v1/Mini (Java fait BMP rotaté). Résout `{dropped: true}` si une image plus récente a été poussée pour la même touche entre-temps. |
| `clearKey({deckId, key})` | Image noire 1×1 → touche éteinte. |
| `clearAllKeys({deckId})` | Identique à `reset`. |
| `setLcdImage({deckId, bytes})` | Plus uniquement — JPEG plein 800×100. |
| `setLcdRegion({deckId, x, y, w, h, bytes})` | Plus uniquement — JPEG région partielle. |
| `setInfoBar({deckId, index, bytes})` | Neo uniquement — JPEG 248×58 sur l'écran d'info. Le Neo n'a qu'un seul écran ; `index` doit être 0 (forward-compat pour de futurs modèles). |

### Events

| Event | Payload |
|-------|---------|
| `deckConnected` | `{deckId, info, reason?}` |
| `deckDisconnected` | `{deckId, reason}` (`usb_lost`, `app_destroyed`) |
| `permissionDenied` | `{deckId, reason}` |
| `keyChanged` | `{deckId, key, pressed}` |
| `dialRotated` | `{deckId, dial, delta}` (Plus) |
| `dialPressed` | `{deckId, dial, pressed}` (Plus) |
| `lcdTouched` | `{deckId, type, x, y, xEnd?, yEnd?}` (Plus) |
| `neoTouched` | `{deckId, index, pressed}` (Neo) |

### Identité persistante

Les decks sont identifiés par leur **numéro de série USB** (lu via
feature report à la connexion). Un deck rebranché conserve donc son
`deckId` — les préférences/layouts/snapshots peuvent être indexés par
ce serial sans risque.

### Architecture

Pattern strategy. `DeckRegistry` mappe `productId → DeckSpec`. Une
`DeckSession` par deck connecté possède son propre thread reader (HID
IN), thread writer (HID OUT consommant `WriterQueue`), et un
`DeckTransport` + `ImageEncoder` choisis selon la spec. Les images
poussées rapidement pour la même touche sont coalescées : la dernière
gagne, les plus anciennes résolvent leur Promise avec `{dropped: true}`.

### Tests manuels

Voir `doc/streamdeck_test_matrix.md` — checklist par modèle physique.

<!-- [en] -->

## SmsGatewayPlugin

**Files:**
- TS bridge: `src/plugins/smsGatewayPlugin.ts`
- Java implementation: `android/app/src/main/java/ca/erplibre/home/SmsGatewayPlugin.java`
- Service: `SmsGatewayService.java` — a foreground service of type `specialUse`
- Receivers: `SmsResultReceiver.java`, `SmsInboundReceiver.java`, `SmsBootReceiver.java`
- Persistent queue: `SmsOutbox.java` (SQLite `erplibre_sms.db`)
- Settings and counters: `SmsGatewayConfig.java` (SharedPreferences)
- Transport to Odoo: `OdooReporter.java`
- Pure, testable logic: `src/utils/smsGatewayUtils.ts`
- Screen: `src/components/options/sms_gateway/` — route `/options/sms_gateway`

**Registration name:** `SmsGateway`, not `SmsGatewayPlugin`.

Turns the phone into the outgoing SMS channel of a remote Odoo server. The
phone POLLS Odoo over outgoing HTTPS, sends through its own SIM and reports
each acknowledgement. The server never reaches the phone, so a dynamic
address and a carrier NAT change nothing and no public URL is exposed. Three
routes carry everything, and they do not bear the module's name because the
module was renamed and the protocol was not: `/erplibre_sms/poll` asks for
work and doubles as the sign of life, `/erplibre_sms/report` returns the
acknowledgements, `/erplibre_sms/inbound` hands over a received message.

Every body is signed in HMAC-SHA256 under the `X-Erplibre-Signature` header.

### API

| Method | Description |
|--------|-------------|
| `getCapabilities()` | Permissions, SIM state, the SIM cards, Android version, the system's segment limit, whether the app is the default SMS handler. |
| `requestSmsPermissions()` | Asks for `SEND_SMS` and `RECEIVE_SMS` at runtime. |
| `configure(options)` | Stores the Odoo URL, the HMAC secret, the device identifier, and optionally the SIM, whether the journal keeps bodies, whether plain HTTP to a private address is tolerated, and the demonstration call audio. **Refuses a non-HTTPS URL**, except a loopback address, an emulator host, or a private address when `allowPlainLan` is set. |
| `startGateway()` / `stopGateway()` | Starts or stops the service. Refuses to start without permission or without a configuration. |
| `getStatus()` | Service running, connected, queue, spooled reports, segments in the last minute, last error. |
| `kick()` | Forces one loop turn after a reconfiguration. |
| `clearLastError()` | Clears the displayed error. |
| `requestDialerRole()` / `releaseDialerRole()` | Opens the system dialog offering the dialer role, or gives it back. |
| `journalEntries(query)` / `clearJournal()` | Reads or empties the local journal. |
| `requestBatteryExemption()` / `requestExactAlarms()` | Opens the system screens the pacing depends on. |

The screen never reads back what is stored: the three fields start empty at
every mount, and the plugin exposes no getter for them.

### Three design points to know before touching it

**The acknowledgement intent's action is FIXED.** An `IntentFilter` matches by
exact string equality: an action built per job (`…SMS_SENT/<job>/<index>`)
would match no filter, and **every acknowledgement would be lost**. Odoo would
conclude failure for messages that did leave, then republish — false alarms
and systematic duplicates. What makes each `PendingIntent` distinct is a
PERSISTED request code (`SmsGatewayConfig.nextRequestCode()`), which
`filterEquals` ignores. An in-memory counter would restart at 1 after a
reboot and mix up the statuses of different recipients.

**The queue is persistent, and a report is re-signed at each attempt.** A job
is written to SQLite before anything is attempted, so the death of the process
loses nothing. The envelope's timestamp and nonce are set just before each
send and not when the report is queued: the server accepts a signature only
within a few minutes, so a report queued during an outage would otherwise
become permanently unacceptable and block every valid report behind it. A
duplicate stays impossible because each event carries a sequence number that
the server orders.

**The service type is `specialUse`, not `dataSync`.** Android 15 caps
`dataSync` at six hours per twenty-four, which no permanent alert channel
fits. The application is not distributed through Google Play, so the
justification Play would demand does not apply.

### Android's rate limit

Checked in the AOSP sources (`SmsUsageMonitor.java`, tags
`android-15.0.0_r36` and `android-16.0.0_r3`): `DEFAULT_SMS_MAX_COUNT = 30`
over `DEFAULT_SMS_CHECK_PERIOD = 60000` ms, counted **per package** and **in
segments**. Past that, the system raises a confirmation dialog — on a phone
nobody is watching, that means nothing leaves.

The service therefore spreads itself under the limit, with a minimum interval
of 2.5 s and a default budget of 24 segments per minute. The consequence to
announce: **40 recipients take about 100 seconds in GSM-7, and more than three
minutes in UCS-2.** A single lowercase `ç` is enough to push a message into
UCS-2: it is not in the GSM 03.38 alphabet, while the uppercase `Ç` is.

### Permissions added to the manifest

`SEND_SMS`, `RECEIVE_SMS`, `BROADCAST_SMS`, `READ_PHONE_STATE` (optional, to
name the SIM cards), `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_SPECIAL_USE` and `FOREGROUND_SERVICE_DATA_SYNC`.

The manifest sets `android:allowBackup="false"`: the HMAC secret and the
pending numbers never leave the device through an Android backup.

### Server prerequisites

The Odoo module `erplibre_mobile_gateway` must be installed, a gateway record
declared with the same device identifier, and the HMAC secret present in the
ENVIRONMENT of the Odoo process — never in the database, which travels in
every backup.

<!-- [fr] -->

## SmsGatewayPlugin

**Fichiers :**
- Pont TS : `src/plugins/smsGatewayPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/SmsGatewayPlugin.java`
- Service : `SmsGatewayService.java` — service de premier plan de type `specialUse`
- Récepteurs : `SmsResultReceiver.java`, `SmsInboundReceiver.java`, `SmsBootReceiver.java`
- File persistante : `SmsOutbox.java` (SQLite `erplibre_sms.db`)
- Réglages et compteurs : `SmsGatewayConfig.java` (SharedPreferences)
- Transport vers Odoo : `OdooReporter.java`
- Logique pure testable : `src/utils/smsGatewayUtils.ts`
- Écran : `src/components/options/sms_gateway/` — route `/options/sms_gateway`

**Nom d'enregistrement :** `SmsGateway`, et non `SmsGatewayPlugin`.

Transforme le téléphone en voie d'envoi des SMS d'un serveur Odoo distant. Le
téléphone INTERROGE Odoo en HTTPS sortant, envoie par sa propre carte SIM et
rend compte de chaque accusé. Le serveur ne joint jamais le téléphone : une
adresse dynamique et un NAT d'opérateur n'y changent rien, et aucune URL
publique n'est exposée. Trois routes portent tout, et elles ne nomment pas le
module parce que le module a été renommé et le protocole non :
`/erplibre_sms/poll` demande du travail et vaut signal de vie,
`/erplibre_sms/report` rend les accusés, `/erplibre_sms/inbound` remet un
message reçu.

Chaque corps est signé en HMAC-SHA256 sous l'en-tête `X-Erplibre-Signature`.

### API

| Méthode | Description |
|---------|-------------|
| `getCapabilities()` | Permissions, état de la SIM, cartes SIM, version d'Android, limite système de segments, et si l'application est le gestionnaire de SMS par défaut. |
| `requestSmsPermissions()` | Demande `SEND_SMS` et `RECEIVE_SMS` à l'exécution. |
| `configure(options)` | Enregistre l'URL d'Odoo, le secret HMAC, l'identifiant d'appareil, et au choix la SIM, la journalisation des corps, la tolérance du HTTP en clair vers une adresse privée, et l'audio d'appel de démonstration. **Refuse une URL non HTTPS**, sauf une adresse de bouclage, l'hôte d'un émulateur, ou une adresse privée quand `allowPlainLan` est posé. |
| `startGateway()` / `stopGateway()` | Démarre ou arrête le service. Refuse de démarrer sans permission ou sans configuration. |
| `getStatus()` | Service en marche, connecté, file, rapports en attente, segments de la dernière minute, dernière erreur. |
| `kick()` | Force un tour de boucle après une reconfiguration. |
| `clearLastError()` | Efface l'erreur affichée. |
| `requestDialerRole()` / `releaseDialerRole()` | Ouvre le dialogue système proposant le rôle de composeur, ou le rend. |
| `journalEntries(query)` / `clearJournal()` | Lit ou vide le journal local. |
| `requestBatteryExemption()` / `requestExactAlarms()` | Ouvre les écrans système dont dépend le cadencement. |

L'écran ne relit jamais ce qui est stocké : les trois champs partent vides à
chaque ouverture, et le greffon n'expose aucun accesseur pour eux.

### Trois points de conception à connaître avant d'y toucher

**L'action de l'intention d'accusé est FIXE.** Un `IntentFilter` apparie par
égalité exacte de chaîne : une action construite par travail
(`…SMS_SENT/<travail>/<indice>`) ne serait appariée par aucun filtre, et
**tous les accusés seraient perdus**. Odoo conclurait à un échec pour des
messages réellement partis, puis republierait — fausses alertes et doublons
systématiques. Ce qui rend chaque `PendingIntent` distinct est un code de
requête PERSISTÉ (`SmsGatewayConfig.nextRequestCode()`), que `filterEquals`
ignore. Un compteur en mémoire repartirait à 1 après un redémarrage et
mélangerait les statuts entre destinataires.

**La file est persistante, et un rapport est re-signé à chaque tentative.** Un
travail est écrit dans SQLite avant toute tentative : la mort du processus ne
perd rien. L'horodatage et le nonce de l'enveloppe sont posés juste avant
chaque envoi, et non à la mise en file : le serveur n'accepte une signature
que dans une fenêtre de quelques minutes, si bien qu'un rapport mis en file
pendant une coupure deviendrait sinon définitivement irrecevable et bloquerait
derrière lui tous les rapports valides. Le doublon reste impossible : chaque
évènement porte un numéro de séquence que le serveur ordonne.

**Le type de service est `specialUse`, pas `dataSync`.** Android 15 plafonne
`dataSync` à six heures par vingt-quatre, ce qu'aucun canal d'alerte permanent
ne tient. L'application n'étant pas distribuée par Google Play, la
justification que Play exigerait ne s'applique pas.

### Limite de débit d'Android

Vérifiée dans les sources AOSP (`SmsUsageMonitor.java`, étiquettes
`android-15.0.0_r36` et `android-16.0.0_r3`) : `DEFAULT_SMS_MAX_COUNT = 30`
sur `DEFAULT_SMS_CHECK_PERIOD = 60000` ms, compté **par nom de paquet** et
**en segments**. Au-delà, le système empile un dialogue de confirmation — sur
un téléphone que personne ne regarde, cela signifie que rien ne part.

Le service s'étale donc sous la limite, avec un intervalle minimal de 2,5 s et
un budget par défaut de 24 segments par minute. Conséquence à annoncer :
**40 destinataires prennent environ 100 secondes en GSM-7, et plus de trois
minutes en UCS-2.** Un seul `ç` minuscule suffit à faire basculer un message
en UCS-2 : il n'est pas dans l'alphabet GSM 03.38, contrairement au `Ç`
majuscule.

### Permissions ajoutées au manifeste

`SEND_SMS`, `RECEIVE_SMS`, `BROADCAST_SMS`, `READ_PHONE_STATE` (facultative,
pour nommer les cartes SIM), `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_SPECIAL_USE` et `FOREGROUND_SERVICE_DATA_SYNC`.

Le manifeste pose `android:allowBackup="false"` : le secret HMAC et les
numéros en attente ne quittent jamais l'appareil par une sauvegarde Android.

### Prérequis serveur

Le module Odoo `erplibre_mobile_gateway` doit être installé, une fiche
passerelle déclarée avec le même identifiant d'appareil, et le secret HMAC
présent dans l'ENVIRONNEMENT du processus Odoo — jamais en base, qui voyage
dans chaque sauvegarde.
