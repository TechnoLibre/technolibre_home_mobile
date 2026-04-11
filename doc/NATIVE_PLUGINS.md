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
| `getModelPath({ model })` | Retourne `{ path: string; exists: boolean }` — chemin absolu du binaire sur l'appareil. |
| `downloadModel({ model, url })` | Télécharge le binaire GGML en streaming natif (64 KB/chunk, `HttpURLConnection`) avec redirect manuel. Fire des événements `downloadProgress`. Résout avec `{ path }`. |
| `transcribe({ audioPath, lang? })` | Transcrit un fichier audio. `audioPath` est relatif à `filesDir`. `lang` est un code BCP-47 (défaut `"fr"`). Résout avec `{ text }`. |
| `unloadModel()` | Libère le modèle de la mémoire. |
| `addListener("progress", fn)` | Progression de la transcription. `fn` reçoit `{ ratio: number; text: string }`. |
| `addListener("downloadProgress", fn)` | Progression du téléchargement. `fn` reçoit `{ ratio: number; received: number; total: number }`. |

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
