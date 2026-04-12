package ca.erplibre.home;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

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

    /** Shared with WhisperDownloadService so the service can call back into JS. */
    static volatile WhisperPlugin instance = null;

    /** Callback ID of the PluginCall saved by downloadModelForeground(). */
    static volatile String pendingForegroundCallId = null;

    /** Set to true to abort an in-progress WakeLock download. */
    private volatile boolean cancelRequested = false;

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
            call.reject("Model file not found: " + f.getAbsolutePath());
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
                call.reject("Failed to initialise whisper context from: " + absolutePath);
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
            call.reject("Missing audioPath parameter");
            return;
        }
        if (contextPtr == 0) {
            call.reject("No model loaded — call loadModel() first");
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
            call.reject("Audio file not found: " + audioFile.getAbsolutePath());
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
                call.reject("Transcription failed: " + e.getMessage(), e);
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
            call.reject("Missing url parameter");
            return;
        }

        cancelRequested = false;
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
                    call.reject("Too many redirects");
                    return;
                }

                long serverContent = conn.getContentLengthLong();
                long total = serverContent > 0 ? resumeBytes + serverContent : 0;

                try (InputStream     in  = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(partial, doAppend)) {

                    byte[] buf    = new byte[64 * 1024];
                    long received = resumeBytes;
                    int  n;

                    while (!cancelRequested && (n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        received += n;

                        JSObject evt = new JSObject();
                        evt.put("ratio",    total > 0 ? (double) received / total : 0.0);
                        evt.put("received", received);
                        evt.put("total",    total);
                        notifyListeners("downloadProgress", evt);
                    }
                }

                if (cancelRequested) {
                    // Keep .partial file — next retry can resume from here
                    Log.i(TAG, "Download of " + model + " cancelled — partial file kept for resume");
                    call.reject("Download cancelled");
                    return;
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

                Log.i(TAG, "Model download complete: " + dest.getAbsolutePath());
                JSObject result = new JSObject();
                result.put("path", dest.getAbsolutePath());
                call.resolve(result);

            } catch (Exception e) {
                Log.e(TAG, "downloadModel failed", e);
                // Keep .partial file — allows resume on next attempt
                call.reject("Download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                wl.release();
            }
        }).start();
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
     */
    @PluginMethod
    public void downloadModelForeground(PluginCall call) {
        String model  = call.getString("model", "tiny");
        String urlStr = call.getString("url");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("Missing url parameter");
            return;
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
     * For WakeLock mode: sets the cancel flag; the loop exits on next chunk.
     * For Foreground Service: sends a cancel intent to the service.
     * The .partial file is KEPT so the next attempt can resume via Range.
     */
    @PluginMethod
    public void cancelDownload(PluginCall call) {
        cancelRequested = true;
        // Also stop any running foreground service
        Intent stopIntent = new Intent(getContext(), WhisperDownloadService.class);
        stopIntent.setAction(WhisperDownloadService.ACTION_CANCEL);
        getContext().startService(stopIntent);
        call.resolve();
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
            call.reject("Download failed: " + message);
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
            call.reject("Download cancelled");
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
            call.reject("Failed to delete model file: " + f.getAbsolutePath());
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
