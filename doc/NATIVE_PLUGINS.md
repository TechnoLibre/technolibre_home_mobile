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
