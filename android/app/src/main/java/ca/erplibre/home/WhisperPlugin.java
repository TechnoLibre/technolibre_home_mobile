package ca.erplibre.home;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Capacitor plugin for on-device audio transcription using whisper.cpp.
 *
 * JavaScript surface:
 *   isModelLoaded()                    → { loaded: boolean }
 *   loadModel({ model })               → void
 *   getModelPath({ model })            → { path, exists }
 *   transcribe({ audioPath, lang? })   → { text }
 *   unloadModel()                      → void
 *
 * Events fired during transcribe():
 *   "progress"  →  { ratio: number, text: string }
 */
@CapacitorPlugin(name = "WhisperPlugin")
public class WhisperPlugin extends Plugin {

    private static final String TAG = "WhisperPlugin";

    /** The currently loaded context pointer (0 = none). */
    private long contextPtr    = 0;
    /** Model name that is currently loaded, e.g. "tiny". */
    private String loadedModel = null;

    // ─────────────────────────────────────────────────────────────────────────

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

    @PluginMethod
    public void loadModel(PluginCall call) {
        String model = call.getString("model", "tiny");
        File f = modelFile(model);

        if (!f.exists()) {
            call.reject("Model file not found: " + f.getAbsolutePath());
            return;
        }

        // Already loaded?
        if (model.equals(loadedModel) && contextPtr != 0) {
            call.resolve();
            return;
        }

        String absolutePath = f.getAbsolutePath();
        new Thread(() -> {
            // Free previous context if any
            if (contextPtr != 0) {
                WhisperLib.freeContext(contextPtr);
                contextPtr    = 0;
                loadedModel   = null;
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

        // Normalise path: strip Capacitor WebView prefix or file:// scheme so
        // the plugin always receives a plain absolute filesystem path.
        // Handles:
        //   https://localhost/_capacitor_file_/storage/…  →  /storage/…  (default)
        //   https://localhost/_capacitor_file/storage/…   →  /storage/…  (older builds)
        //   capacitor://localhost/_capacitor_file_/storage/…  →  /storage/…
        //   file:///storage/…  →  /storage/…
        int capIdx = audioPath.indexOf("/_capacitor_file");
        if (capIdx >= 0) {
            // Skip past "/_capacitor_file" then any trailing underscores, then "/"
            int pathStart = capIdx + "/_capacitor_file".length();
            while (pathStart < audioPath.length() && audioPath.charAt(pathStart) == '_') {
                pathStart++;
            }
            audioPath = audioPath.substring(pathStart); // starts with "/"
        } else if (audioPath.startsWith("file:///")) {
            audioPath = audioPath.substring(7);   // keep leading /
        } else if (audioPath.startsWith("file://")) {
            audioPath = audioPath.substring(7);
        }

        Log.i(TAG, "transcribe NORMALISED path: [" + audioPath + "]");

        // Resolve relative paths (audio recordings) against the app files dir
        File audioFile = audioPath.startsWith("/")
                ? new File(audioPath)
                : new File(getContext().getFilesDir(), audioPath);

        if (!audioFile.exists()) {
            call.reject("Audio file not found: " + audioFile.getAbsolutePath());
            return;
        }

        final long ctxPtr      = contextPtr;
        final String filePath  = audioFile.getAbsolutePath();
        final String language  = lang;

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

    /**
     * Download a model file directly in Java using HttpURLConnection.
     * Streams the response in 64 KB chunks straight to disk — no base64
     * conversion, no large in-memory buffers, safe for files > 100 MB.
     *
     * Fires "downloadProgress" events: { ratio, received, total }
     * Resolves with { path } on success, rejects on error.
     */
    @PluginMethod
    public void downloadModel(PluginCall call) {
        String model  = call.getString("model", "tiny");
        String urlStr = call.getString("url");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("Missing url parameter");
            return;
        }

        File dest = modelFile(model);
        dest.getParentFile().mkdirs();

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                // Follow redirects manually so HTTPS→HTTPS CDN redirects work
                URL url = new URL(urlStr);
                for (int hop = 0; hop < 5; hop++) {
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(30_000);
                    conn.setReadTimeout(60_000);
                    conn.connect();
                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_PERM
                            || status == HttpURLConnection.HTTP_MOVED_TEMP
                            || status == 307 || status == 308) {
                        String location = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        url  = new URL(location);
                        continue;
                    }
                    break;
                }

                if (conn == null) {
                    call.reject("Too many redirects");
                    return;
                }

                long total = conn.getContentLengthLong();

                try (InputStream in  = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(dest)) {

                    byte[] buf      = new byte[64 * 1024];
                    long  received  = 0;
                    int   n;

                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        received += n;

                        JSObject evt = new JSObject();
                        evt.put("ratio",    total > 0 ? (double) received / total : 0.0);
                        evt.put("received", received);
                        evt.put("total",    total);
                        notifyListeners("downloadProgress", evt);
                    }
                }

                JSObject result = new JSObject();
                result.put("path", dest.getAbsolutePath());
                call.resolve(result);

            } catch (Exception e) {
                Log.e(TAG, "downloadModel failed", e);
                if (dest.exists()) dest.delete(); // remove partial file
                call.reject("Download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

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
        if (f.exists()) {
            if (!f.delete()) {
                call.reject("Failed to delete model file: " + f.getAbsolutePath());
                return;
            }
            Log.i(TAG, "Model deleted: " + f.getAbsolutePath());
        }
        call.resolve();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private File modelFile(String model) {
        // Stored at: <filesDir>/whisper/ggml-<model>.bin
        return new File(getContext().getFilesDir(), "whisper/ggml-" + model + ".bin");
    }

    private void notifyProgress(double ratio, String text) {
        JSObject data = new JSObject();
        data.put("ratio", ratio);
        data.put("text", text);
        notifyListeners("progress", data);
    }
}
