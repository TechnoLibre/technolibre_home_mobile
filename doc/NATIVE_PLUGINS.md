
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

## SmsGatewayPlugin

**Fichiers :**
- Bridge TS : `src/plugins/smsGatewayPlugin.ts`
- Implémentation Java : `android/app/src/main/java/ca/erplibre/home/SmsGatewayPlugin.java`
- Service : `SmsGatewayService.java` — Foreground Service de type `specialUse`
- Récepteurs : `SmsResultReceiver.java`, `SmsInboundReceiver.java`, `SmsBootReceiver.java`
- File persistante : `SmsOutbox.java` (SQLite `erplibre_sms.db`)
- Configuration et compteurs : `SmsGatewayConfig.java` (SharedPreferences)
- Transport vers Odoo : `OdooReporter.java`
- Logique pure testable : `src/utils/smsGatewayUtils.ts`
- Écran : `src/components/options/sms_gateway/` — route `/options/sms_gateway`

**Nom d'enregistrement :** `SmsGateway` (et non `SmsGatewayPlugin`).

Transforme le téléphone en passerelle SMS pour un serveur Odoo distant. Odoo
publie une demande d'envoi sur un sujet **ntfy** ; le service, abonné en sortant,
la consomme et envoie par la carte SIM, puis rend compte en HTTPS. Aucune URL
publique n'est exposée : le serveur n'a jamais besoin de joindre le téléphone,
ce qui fonctionne derrière une IP dynamique et un NAT d'opérateur.

### API

| Méthode | Description |
|---------|-------------|
| `getCapabilities()` | Permissions, état de la SIM, liste des cartes SIM, version d'Android, limite système de segments, et si l'app est le gestionnaire de SMS par défaut. |
| `requestSmsPermissions()` | Demande `SEND_SMS` et `RECEIVE_SMS` à l'exécution. Résout avec l'état obtenu. |
| `configure(options)` | Enregistre URL ntfy, sujet, jeton, URL Odoo, secret HMAC, identifiant d'appareil, SIM. **Refuse toute URL non HTTPS.** |
| `startGateway()` / `stopGateway()` | Démarre ou arrête le service. Refuse de démarrer sans permission ou sans configuration. |
| `getStatus()` | État complet : service actif, abonnement ntfy, file d'attente, rapports en attente, segments de la minute écoulée, dernière erreur. |
| `kick()` | Force un tour de boucle après reconfiguration. |
| `clearLastError()` | Efface la dernière erreur affichée. |

### Trois points de conception à connaître avant d'y toucher

**L'action des intentions d'accusé est FIXE.** Un `IntentFilter` apparie par
égalité exacte de chaîne : une action construite par travail
(`…SMS_SENT/<job>/<index>`) ne serait appariée par aucun filtre, et **100 % des
accusés seraient perdus**. Odoo conclurait à un échec pour des SMS réellement
partis, puis republierait — fausses alertes et doublons systématiques. L'unicité
entre segments vient d'un **code de requête persisté**
(`SmsGatewayConfig.nextRequestCode()`), que `filterEquals` ignore mais qui rend
chaque `PendingIntent` distinct. Un compteur en mémoire repartirait à 1 après un
redémarrage et mélangerait les statuts entre destinataires.

**La file est persistante, et l'ordre est invariant.** Un travail est inséré dans
SQLite *avant* que l'identifiant du dernier événement ntfy ne soit avancé.
L'inverse perdrait des messages sans trace : après une mort du processus, la
reprise `?since=` sauterait un message qui n'existait plus qu'en mémoire.

**Le type de service est `specialUse`, pas `dataSync`.** Android 15 plafonne
`dataSync` à six heures par période de vingt-quatre heures, ce qui est
incompatible avec un canal d'alerte permanent. L'application n'étant pas
distribuée par Google Play, la justification que Play exigerait ne s'applique
pas.

### Limite de débit d'Android

Vérifiée dans les sources AOSP (`SmsUsageMonitor.java`, étiquettes
`android-15.0.0_r36` et `android-16.0.0_r3`) : `DEFAULT_SMS_MAX_COUNT = 30` sur
`DEFAULT_SMS_CHECK_PERIOD = 60000` ms, compté **par nom de paquet** et **en
segments**. Au-delà, le système empile un dialogue de confirmation — sur un
téléphone que personne ne regarde, cela signifie que rien ne part.

Le service s'étale donc sous la limite, avec un intervalle minimal de 2,5 s et un
budget par défaut de 24 segments par minute. Conséquence à annoncer :
**40 destinataires prennent environ 100 secondes en GSM-7, et plus de trois
minutes en UCS-2.** Un seul `ç` minuscule suffit à faire basculer un message en
UCS-2 : il n'est pas dans l'alphabet GSM 03.38, contrairement au `Ç` majuscule.

### Permissions ajoutées au manifeste

`SEND_SMS`, `RECEIVE_SMS`, `READ_PHONE_STATE` (facultative, pour nommer les
SIM), `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE_SPECIAL_USE`.

Le secret HMAC et les numéros en attente sont exclus des sauvegardes Android par
`res/xml/backup_rules.xml` et `res/xml/data_extraction_rules.xml`.

### Prérequis serveur

Le module Odoo `erplibre_mobile_passerelle` doit être installé, une passerelle déclarée, et le
secret HMAC présent dans l'environnement du processus Odoo. **Le serveur ntfy
doit avoir TLS et l'authentification activés** : le script d'installation fourni
avec ERPLibre les laisse désactivés, et les numéros comme le contenu des messages
transiteraient en clair sur un sujet lisible par quiconque en connaît le nom.
