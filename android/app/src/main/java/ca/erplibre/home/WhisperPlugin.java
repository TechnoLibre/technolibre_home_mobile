package ca.erplibre.home;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Capacitor plugin for on-device audio transcription using whisper.cpp.
 *
 * JavaScript surface:
 *   isModelLoaded()                            → { loaded: boolean }
 *   loadModel({ model })                       → void
 *   getModelPath({ model })                    → { path, exists }
 *   downloadModel({ model, url })              → { path }   (WakeLock + Range resume)
 *   downloadModelForeground({ model, url })    → { path }   (Foreground Service)
 *   cancelDownload()                           → void
 *   transcribe({ audioPath, lang? })           → { text }
 *   unloadModel()                              → void
 *   deleteModel({ model })                     → void
 *
 * Events fired during transcribe():
 *   "progress"          → { ratio: number, text: string }
 *
 * Events fired during download (both modes):
 *   "downloadProgress"  → { ratio: number, received: number, total: number }
 */
@CapacitorPlugin(name = "WhisperPlugin")
public class WhisperPlugin extends Plugin {

    private static final String TAG = "WhisperPlugin";

    /** Broadcast action to cancel a WakeLock-mode download from the notification. */
    private static final String ACTION_CANCEL_WAKELOCK =
        "ca.erplibre.home.CANCEL_WAKELOCK_DOWNLOAD";

    /** Shared with WhisperDownloadService so the service can call back into JS. */
    static volatile WhisperPlugin instance = null;

    /** Callback ID of the PluginCall saved by downloadModelForeground(). */
    static volatile String pendingForegroundCallId = null;

    /** Per-model cancel flags for WakeLock downloads. */
    private final java.util.concurrent.ConcurrentHashMap<String, Boolean> cancelSet =
        new java.util.concurrent.ConcurrentHashMap<>();

    private boolean isCancelled(String model) { return cancelSet.containsKey(model); }
    private void clearCancel(String model) { cancelSet.remove(model); }

    /** Returns the notification ID to use for a given model's WakeLock download. */
    private static int wakelockNotifId(String model) {
        switch (model) {
            case "tiny":             return 9002;
            case "base":             return 9003;
            case "small":            return 9004;
            case "medium":           return 9005;
            case "large-v3-turbo":   return 9006;
            case "distil-large-v3":  return 9007;
            default:                 return 9008;
        }
    }

    /** The currently loaded context pointer (0 = none). */
    private long contextPtr    = 0;
    /** Model name that is currently loaded, e.g. "tiny". */
    private String loadedModel = null;

    // ─────────────────────────────────────────────────────────────────────────

    @Override
    public void load() {
        instance = this;
        createNotificationChannel();
    }

    /** Create the notification channel used by WhisperDownloadService (idempotent). */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                WhisperDownloadService.CHANNEL_ID,
                "Téléchargement modèle Whisper",
                NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("Progression des téléchargements de modèles Whisper");
            NotificationManager nm = (NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(ch);
        }
    }

    // ─── Model info ───────────────────────────────────────────────────────────

    @PluginMethod
    public void isModelLoaded(PluginCall call) {
        JSObject result = new JSObject();
        result.put("loaded", contextPtr != 0);
        call.resolve(result);
    }

    @PluginMethod
    public void getModelPath(PluginCall call) {
        String model = call.getString("model", "tiny");
        File f = modelFile(model);
        JSObject result = new JSObject();
        result.put("path",   f.getAbsolutePath());
        result.put("exists", f.exists());
        call.resolve(result);
    }

    // ─── Load / unload ────────────────────────────────────────────────────────

    @PluginMethod
    public void loadModel(PluginCall call) {
        String model = call.getString("model", "tiny");
        File f = modelFile(model);

        if (!f.exists()) {
            call.reject("Fichier modèle introuvable : " + f.getAbsolutePath());
            return;
        }

        if (model.equals(loadedModel) && contextPtr != 0) {
            call.resolve();
            return;
        }

        String absolutePath = f.getAbsolutePath();
        new Thread(() -> {
            if (contextPtr != 0) {
                WhisperLib.freeContext(contextPtr);
                contextPtr  = 0;
                loadedModel = null;
            }
            Log.i(TAG, "Loading model: " + absolutePath);
            long ptr = WhisperLib.initContext(absolutePath);
            if (ptr == 0) {
                call.reject("Échec d'initialisation du contexte Whisper : " + absolutePath);
            } else {
                contextPtr  = ptr;
                loadedModel = model;
                Log.i(TAG, "Model loaded: " + model);
                call.resolve();
            }
        }).start();
    }

    @PluginMethod
    public void unloadModel(PluginCall call) {
        if (contextPtr != 0) {
            WhisperLib.freeContext(contextPtr);
            contextPtr  = 0;
            loadedModel = null;
            Log.i(TAG, "Model unloaded");
        }
        call.resolve();
    }

    // ─── Transcription ────────────────────────────────────────────────────────

    @PluginMethod
    public void transcribe(PluginCall call) {
        String audioPath = call.getString("audioPath");
        String lang      = call.getString("lang", "fr");

        if (audioPath == null || audioPath.isEmpty()) {
            call.reject("Paramètre audioPath manquant");
            return;
        }
        if (contextPtr == 0) {
            call.reject("Aucun modèle chargé — appelez loadModel() en premier");
            return;
        }

        Log.i(TAG, "transcribe RAW path: [" + audioPath + "]");

        int capIdx = audioPath.indexOf("/_capacitor_file");
        if (capIdx >= 0) {
            int pathStart = capIdx + "/_capacitor_file".length();
            while (pathStart < audioPath.length() && audioPath.charAt(pathStart) == '_') {
                pathStart++;
            }
            audioPath = audioPath.substring(pathStart);
        } else if (audioPath.startsWith("file:///")) {
            audioPath = audioPath.substring(7);
        } else if (audioPath.startsWith("file://")) {
            audioPath = audioPath.substring(7);
        }

        Log.i(TAG, "transcribe NORMALISED path: [" + audioPath + "]");

        File audioFile = audioPath.startsWith("/")
                ? new File(audioPath)
                : new File(getContext().getFilesDir(), audioPath);

        if (!audioFile.exists()) {
            call.reject("Fichier audio introuvable : " + audioFile.getAbsolutePath());
            return;
        }

        final long   ctxPtr   = contextPtr;
        final String filePath = audioFile.getAbsolutePath();
        final String language = lang;

        new Thread(() -> {
            try {
                notifyProgress(0.1, "Décodage audio…");
                float[] pcm = AudioConverter.convertToWhisperFormat(filePath);

                notifyProgress(0.3, "Transcription en cours…");
                String text = WhisperLib.transcribeAudio(ctxPtr, pcm, language);

                notifyProgress(1.0, "Terminé");

                JSObject result = new JSObject();
                result.put("text", text.trim());
                call.resolve(result);

            } catch (Exception e) {
                Log.e(TAG, "Transcription failed", e);
                call.reject("Échec de la transcription : " + e.getMessage(), e);
            }
        }).start();
    }

    // ─── Download (WakeLock + HTTP Range resume) ──────────────────────────────

    /**
     * Download a model using a PARTIAL_WAKE_LOCK so the CPU and network
     * remain active when the screen turns off.
     *
     * Supports resuming interrupted downloads via HTTP Range header:
     * if a .partial file exists from a previous attempt, the download
     * continues from where it left off.
     *
     * Progress is reported via "downloadProgress" events: { ratio, received, total }
     * Resolves with { path } on success, rejects on error or cancel.
     * A cancelled download KEEPS the .partial file so the next attempt can resume.
     */
    @PluginMethod
    public void downloadModel(PluginCall call) {
        String model  = call.getString("model", "tiny");
        String urlStr = call.getString("url");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("Paramètre URL manquant");
            return;
        }

        clearCancel(model);
        File dest    = modelFile(model);
        File partial = partialFile(model);
        dest.getParentFile().mkdirs();

        // Resume from previous partial download if available
        long resumeFrom = partial.exists() ? partial.length() : 0;
        boolean appending = resumeFrom > 0;
        if (appending) {
            Log.i(TAG, "Resuming download of " + model + " from byte " + resumeFrom);
        }

        // Keep CPU + network alive while the screen is off
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK, "ERPLibreHome::ModelDownload"
        );
        wl.acquire(45 * 60 * 1000L); // 45-minute hard cap

        // Show a progress notification so the user can monitor the download
        // even when the app is in the background.
        NotificationManager nm = (NotificationManager)
            getContext().getSystemService(Context.NOTIFICATION_SERVICE);

        // BroadcastReceiver for the "Annuler" notification button
        BroadcastReceiver cancelReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                cancelSet.put(model, Boolean.TRUE);
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_CANCEL_WAKELOCK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(cancelReceiver, filter,
                Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(cancelReceiver, filter);
        }
        nm.notify(wakelockNotifId(model), buildWakelockNotification(model, 0));

        new Thread(() -> {
            HttpURLConnection conn = null;
            long resumeBytes  = resumeFrom;
            boolean doAppend  = appending;

            try {
                URL url = new URL(urlStr);

                // Follow redirects manually (HTTPS CDN redirects)
                for (int hop = 0; hop < 5; hop++) {
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(30_000);
                    conn.setReadTimeout(60_000);
                    if (resumeBytes > 0) {
                        conn.setRequestProperty("Range", "bytes=" + resumeBytes + "-");
                    }
                    conn.connect();
                    int status = conn.getResponseCode();

                    if (status == HttpURLConnection.HTTP_MOVED_PERM
                            || status == HttpURLConnection.HTTP_MOVED_TEMP
                            || status == 307 || status == 308) {
                        String location = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn      = null;
                        url       = new URL(location);
                        resumeBytes = 0;  // don't resume after redirect
                        doAppend    = false;
                        continue;
                    }

                    // 206 Partial Content = server accepted the Range request
                    if (status != HttpURLConnection.HTTP_PARTIAL) {
                        // Server ignored Range → start fresh
                        resumeBytes = 0;
                        doAppend    = false;
                        if (partial.exists()) partial.delete();
                    }
                    break;
                }

                if (conn == null) {
                    call.reject("Trop de redirections");
                    return;
                }

                long serverContent = conn.getContentLengthLong();
                long total = serverContent > 0 ? resumeBytes + serverContent : 0;

                // ── Multi-thread fast download ────────────────────────────────
                // For fresh downloads with a known Content-Length, split the file
                // into 4 parallel HTTP Range requests to saturate the connection.
                // Falls back to single-thread for resumes or unknown sizes.
                if (!doAppend && total > 0) {
                    final URL  resolvedUrl = url;
                    final long fileSize    = total;
                    conn.disconnect();
                    conn = null; // prevent double-disconnect in finally

                    final int  N     = 4;
                    final long chunk = fileSize / N;

                    java.util.concurrent.ExecutorService pool =
                        java.util.concurrent.Executors.newFixedThreadPool(N);
                    java.util.concurrent.atomic.AtomicLong mtReceived =
                        new java.util.concurrent.atomic.AtomicLong(0);
                    java.util.concurrent.atomic.AtomicReference<Exception> mtError =
                        new java.util.concurrent.atomic.AtomicReference<>(null);
                    java.util.concurrent.CountDownLatch latch =
                        new java.util.concurrent.CountDownLatch(N);
                    java.util.concurrent.atomic.AtomicInteger mtNotifPct =
                        new java.util.concurrent.atomic.AtomicInteger(-1);

                    // Pre-allocate file so chunks can write at arbitrary offsets
                    try (java.io.RandomAccessFile preallocRaf =
                             new java.io.RandomAccessFile(partial, "rw")) {
                        preallocRaf.setLength(fileSize);
                    }

                    try (java.io.RandomAccessFile dlRaf =
                             new java.io.RandomAccessFile(partial, "rw");
                         java.nio.channels.FileChannel fc = dlRaf.getChannel()) {

                        for (int i = 0; i < N; i++) {
                            final long chunkStart = (long) i * chunk;
                            final long chunkEnd   = (i == N - 1)
                                ? fileSize - 1 : chunkStart + chunk - 1;

                            pool.submit(() -> {
                                HttpURLConnection chunkConn = null;
                                try {
                                    chunkConn = (HttpURLConnection)
                                        resolvedUrl.openConnection();
                                    chunkConn.setConnectTimeout(30_000);
                                    chunkConn.setReadTimeout(60_000);
                                    chunkConn.setRequestProperty(
                                        "Range",
                                        "bytes=" + chunkStart + "-" + chunkEnd);
                                    chunkConn.connect();
                                    if (chunkConn.getResponseCode()
                                            != HttpURLConnection.HTTP_PARTIAL) {
                                        mtError.compareAndSet(null, new Exception(
                                            "Le serveur ne supporte pas les téléchargements multi-segments"));
                                        return;
                                    }
                                    try (InputStream cin = chunkConn.getInputStream()) {
                                        byte[] buf    = new byte[64 * 1024];
                                        long writePos = chunkStart;
                                        int  n;
                                        while (!isCancelled(model)
                                                && (n = cin.read(buf)) != -1) {
                                            java.nio.ByteBuffer bb =
                                                java.nio.ByteBuffer.wrap(buf, 0, n);
                                            while (bb.hasRemaining()) {
                                                int w = fc.write(bb, writePos);
                                                writePos += w;
                                            }
                                            long tot = mtReceived.addAndGet(n);
                                            int  pct = (int)(tot * 100 / fileSize);
                                            int  prev = mtNotifPct.get();
                                            if (pct != prev
                                                    && mtNotifPct.compareAndSet(prev, pct)) {
                                                nm.notify(wakelockNotifId(model),
                                                    buildWakelockNotification(model, pct));
                                                JSObject evt = new JSObject();
                                                evt.put("model",    model);
                                                evt.put("ratio",    (double) tot / fileSize);
                                                evt.put("received", tot);
                                                evt.put("total",    fileSize);
                                                notifyListeners("downloadProgress", evt);
                                            }
                                        }
                                    }
                                } catch (Exception e) {
                                    mtError.compareAndSet(null, e);
                                } finally {
                                    if (chunkConn != null) chunkConn.disconnect();
                                    latch.countDown();
                                }
                            });
                        }

                        latch.await(); // wait for all 4 chunks to finish
                    }
                    pool.shutdown();

                    if (mtError.get() != null) {
                        // Multi-thread partial file has gaps — delete it so the
                        // next retry starts fresh (avoids corrupt resume offset).
                        if (partial.exists()) partial.delete();
                        Log.e(TAG, "Téléchargement multi-segments échoué", mtError.get());
                        call.reject("Échec du téléchargement : " + mtError.get().getMessage());
                        return;
                    }

                    if (isCancelled(model)) {
                        clearCancel(model);
                        // Pre-allocated partial has data at arbitrary offsets and
                        // cannot be resumed sequentially — delete it.
                        if (partial.exists()) partial.delete();
                        Log.i(TAG, "Téléchargement de " + model + " annulé");
                        call.reject("Téléchargement annulé");
                        return;
                    }

                } else {
                    // ── Single-thread fallback (resume or unknown Content-Length) ──
                    try (InputStream     in  = conn.getInputStream();
                         FileOutputStream out = new FileOutputStream(partial, doAppend)) {

                        byte[] buf    = new byte[64 * 1024];
                        long received = resumeBytes;
                        int  n;
                        int  lastNotifPct = -1;

                        while (!isCancelled(model) && (n = in.read(buf)) != -1) {
                            out.write(buf, 0, n);
                            received += n;

                            JSObject evt = new JSObject();
                            evt.put("model",    model);
                            evt.put("ratio",    total > 0 ? (double) received / total : 0.0);
                            evt.put("received", received);
                            evt.put("total",    total);
                            notifyListeners("downloadProgress", evt);

                            int pct = total > 0 ? (int)(received * 100 / total) : 0;
                            if (pct != lastNotifPct) {
                                lastNotifPct = pct;
                                nm.notify(wakelockNotifId(model),
                                    buildWakelockNotification(model, pct));
                            }
                        }
                    }

                    if (isCancelled(model)) {
                        clearCancel(model);
                        Log.i(TAG, "Téléchargement de " + model
                            + " annulé — fichier partiel conservé");
                        call.reject("Téléchargement annulé");
                        return;
                    }
                }

                // Rename .partial → .bin atomically
                if (!partial.renameTo(dest)) {
                    // renameTo can fail across mount points; fall back to stream copy
                    try (InputStream  in  = new FileInputStream(partial);
                         FileOutputStream out = new FileOutputStream(dest)) {
                        byte[] buf = new byte[64 * 1024];
                        int    n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    }
                    partial.delete();
                }

                Log.i(TAG, "Téléchargement terminé : " + dest.getAbsolutePath());
                JSObject result = new JSObject();
                result.put("path", dest.getAbsolutePath());
                call.resolve(result);

            } catch (Exception e) {
                Log.e(TAG, "downloadModel failed", e);
                // Keep .partial file — allows resume on next attempt
                call.reject("Échec du téléchargement : " + e.getMessage());
            } finally {
                nm.cancel(wakelockNotifId(model));
                try { getContext().unregisterReceiver(cancelReceiver); }
                catch (IllegalArgumentException ignored) { /* already unregistered */ }
                if (conn != null) conn.disconnect();
                wl.release();
            }
        }).start();
    }

    /** Build the progress notification for WakeLock-mode downloads. */
    private Notification buildWakelockNotification(String model, int percent) {
        Intent cancelIntent = new Intent(ACTION_CANCEL_WAKELOCK);
        PendingIntent cancelPI = PendingIntent.getBroadcast(
            getContext(), 0, cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(getContext(), WhisperDownloadService.CHANNEL_ID)
            .setContentTitle("Téléchargement Whisper — " + model)
            .setContentText(percent + " %")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setProgress(100, percent, false)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Annuler", cancelPI)
            .setOngoing(true)
            .setSilent(true)
            .build();
    }

    // ─── Service status ───────────────────────────────────────────────────────

    /**
     * Returns the current foreground download service status.
     * Used by the JS layer to detect an in-progress download after the Activity
     * is recreated (when _activeDownload in TypeScript was reset to null).
     */
    @PluginMethod
    public void getServiceStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("downloading", WhisperDownloadService.downloading);
        String model = WhisperDownloadService.currentModel;
        result.put("model", model != null ? model : "");
        call.resolve(result);
    }

    // ─── Download (Foreground Service) ────────────────────────────────────────

    /**
     * Start a foreground-service download. The service runs in the background
     * with a persistent notification (including an "Annuler" action) and
     * survives screen-off without a WakeLock.
     *
     * The PluginCall is kept alive until the service calls back via
     * onForegroundDownloadComplete() / onForegroundDownloadError() /
     * onForegroundDownloadCancelled().
     *
     * If the service is already running for the same model (e.g. after Activity
     * recreation), we do NOT start a new service — we just update
     * pendingForegroundCallId so the existing thread resolves the new call.
     */
    @PluginMethod
    public void downloadModelForeground(PluginCall call) {
        String model  = call.getString("model", "tiny");
        String urlStr = call.getString("url");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("Paramètre URL manquant");
            return;
        }

        if (WhisperDownloadService.downloading) {
            if (model.equals(WhisperDownloadService.currentModel)) {
                // Re-attach: update pendingForegroundCallId so the running
                // thread will resolve this new JS Promise when it finishes.
                Log.i(TAG, "Re-attaching to running foreground download for: " + model);
                call.setKeepAlive(true);
                getBridge().saveCall(call);
                pendingForegroundCallId = call.getCallbackId();
                return;
            } else {
                call.reject("Un autre téléchargement est déjà en cours : "
                    + WhisperDownloadService.currentModel);
                return;
            }
        }

        // Keep the call alive until the service resolves it
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        pendingForegroundCallId = call.getCallbackId();

        Intent intent = new Intent(getContext(), WhisperDownloadService.class);
        intent.putExtra(WhisperDownloadService.EXTRA_MODEL, model);
        intent.putExtra(WhisperDownloadService.EXTRA_URL,   urlStr);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        // PluginCall stays pending — resolved by the callbacks below
    }

    /**
     * Cancel any in-progress download (WakeLock or Foreground Service).
     * For WakeLock mode: sets the per-model cancel flag; the loop exits on next chunk.
     * For Foreground Service: sends a cancel intent to the service.
     * If model is provided, only that model's download is cancelled.
     * The .partial file is KEPT so the next attempt can resume via Range.
     */
    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String model = call.getString("model", null);
        if (model != null && !model.isEmpty()) {
            cancelSet.put(model, Boolean.TRUE);
            if (model.equals(WhisperDownloadService.currentModel)) {
                sendForegroundCancelIntent();
            }
        } else {
            for (String m : new String[]{"tiny", "base", "small", "medium", "large-v3-turbo", "distil-large-v3"}) {
                cancelSet.put(m, Boolean.TRUE);
            }
            sendForegroundCancelIntent();
        }
        call.resolve();
    }

    private void sendForegroundCancelIntent() {
        Intent stopIntent = new Intent(getContext(), WhisperDownloadService.class);
        stopIntent.setAction(WhisperDownloadService.ACTION_CANCEL);
        getContext().startService(stopIntent);
    }

    // ─── Callbacks from WhisperDownloadService ────────────────────────────────

    /** Public bridge so WhisperDownloadService can emit events (notifyListeners is protected). */
    public void notifyDownloadProgress(JSObject evt) {
        notifyListeners("downloadProgress", evt);
    }

    /** Called by WhisperDownloadService on the service thread → dispatches on UI thread. */
    void onForegroundDownloadComplete(String path) {
        getActivity().runOnUiThread(() -> {
            String callId = pendingForegroundCallId;
            pendingForegroundCallId = null;
            if (callId == null) return;
            PluginCall call = getBridge().getSavedCall(callId);
            if (call == null) return;
            getBridge().releaseCall(call);
            JSObject result = new JSObject();
            result.put("path", path);
            call.resolve(result);
        });
    }

    void onForegroundDownloadError(String message) {
        getActivity().runOnUiThread(() -> {
            String callId = pendingForegroundCallId;
            pendingForegroundCallId = null;
            if (callId == null) return;
            PluginCall call = getBridge().getSavedCall(callId);
            if (call == null) return;
            getBridge().releaseCall(call);
            call.reject("Échec du téléchargement : " + message);
        });
    }

    void onForegroundDownloadCancelled() {
        getActivity().runOnUiThread(() -> {
            String callId = pendingForegroundCallId;
            pendingForegroundCallId = null;
            if (callId == null) return;
            PluginCall call = getBridge().getSavedCall(callId);
            if (call == null) return;
            getBridge().releaseCall(call);
            call.reject("Téléchargement annulé");
        });
    }

    // ─── Delete ───────────────────────────────────────────────────────────────

    @PluginMethod
    public void deleteModel(PluginCall call) {
        String model = call.getString("model", "tiny");

        // Unload from memory first if this model is currently active
        if (model.equals(loadedModel) && contextPtr != 0) {
            WhisperLib.freeContext(contextPtr);
            contextPtr  = 0;
            loadedModel = null;
            Log.i(TAG, "Model unloaded before delete: " + model);
        }

        File f = modelFile(model);
        if (f.exists() && !f.delete()) {
            call.reject("Impossible de supprimer le fichier modèle : " + f.getAbsolutePath());
            return;
        }

        // Also remove any partial file so a future download starts fresh
        File partial = partialFile(model);
        if (partial.exists()) {
            partial.delete();
            Log.i(TAG, "Partial file removed: " + partial.getName());
        }

        Log.i(TAG, "Model deleted: " + model);
        call.resolve();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Final model binary: <filesDir>/whisper/ggml-<model>.bin */
    private File modelFile(String model) {
        return new File(getContext().getFilesDir(), "whisper/ggml-" + model + ".bin");
    }

    /** Temporary file written during download: <filesDir>/whisper/ggml-<model>.partial */
    private File partialFile(String model) {
        return new File(getContext().getFilesDir(), "whisper/ggml-" + model + ".partial");
    }

    private void notifyProgress(double ratio, String text) {
        JSObject data = new JSObject();
        data.put("ratio", ratio);
        data.put("text", text);
        notifyListeners("progress", data);
    }
}
