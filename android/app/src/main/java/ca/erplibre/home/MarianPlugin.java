package ca.erplibre.home;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Capacitor plugin for on-device FR↔EN translation using MarianMT
 * (Helsinki-NLP opus-mt models, ONNX format) + SentencePiece tokenizer.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 * 1. Clone sentencepiece (for the JNI tokenizer):
 *    git clone --depth=1 https://github.com/google/sentencepiece \
 *        android/app/src/main/cpp/sentencepiece
 *
 * 2. Add ONNX Runtime to android/app/build.gradle:
 *    implementation 'com.microsoft.onnxruntime:onnxruntime-android:1.20.0'
 *
 * 3. Register this plugin in MainActivity.java:
 *    add(MarianPlugin.class);
 *
 * ── Model files ────────────────────────────────────────────────────────────
 * Downloaded at runtime to <filesDir>/marian/{direction}/:
 *   encoder.onnx   — ONNX encoder  (~40 MB quantized)
 *   decoder.onnx   — ONNX decoder  (~40 MB quantized)
 *   source.spm     — SentencePiece vocab for source language
 *   target.spm     — SentencePiece vocab for target language
 *
 * Model source: Helsinki-NLP/opus-mt-{direction} (ONNX via Xenova exports)
 * ── Special tokens ─────────────────────────────────────────────────────────
 * For Helsinki-NLP opus-mt models (config.json):
 *   eos_token_id           = 0
 *   decoder_start_token_id = 65000  (same as pad_token_id)
 */
@CapacitorPlugin(name = "MarianPlugin")
public class MarianPlugin extends Plugin {

    private static final String TAG = "MarianPlugin";

    // Special token IDs for Helsinki-NLP opus-mt models
    private static final int EOS_TOKEN_ID = 0;
    private static final int PAD_TOKEN_ID = 65000; // forced decoder BOS

    // Max generated tokens (prevents infinite loop)
    private static final int MAX_OUTPUT_LEN = 256;

    // ── Model download URLs ──────────────────────────────────────────────────
    // Source: Helsinki-NLP (spm files) + Xenova (quantized ONNX exports)
    // Update these URLs if the HuggingFace paths change.
    private static final String HF_BASE = "https://huggingface.co";

    private static final Map<String, String[]> MODEL_URLS = new HashMap<>();
    static {
        final String HNBase  = HF_BASE + "/Helsinki-NLP";
        final String XenBase = HF_BASE + "/Xenova";

        MODEL_URLS.put("fr-en", new String[]{
            XenBase + "/opus-mt-fr-en/resolve/main/onnx/encoder_model_quantized.onnx",
            XenBase + "/opus-mt-fr-en/resolve/main/onnx/decoder_model_quantized.onnx",
            HNBase  + "/opus-mt-fr-en/resolve/main/source.spm",
            HNBase  + "/opus-mt-fr-en/resolve/main/target.spm",
        });
        MODEL_URLS.put("en-fr", new String[]{
            XenBase + "/opus-mt-en-fr/resolve/main/onnx/encoder_model_quantized.onnx",
            XenBase + "/opus-mt-en-fr/resolve/main/onnx/decoder_model_quantized.onnx",
            HNBase  + "/opus-mt-en-fr/resolve/main/source.spm",
            HNBase  + "/opus-mt-en-fr/resolve/main/target.spm",
        });
    }

    /** Stored file names for each downloaded file (same order as MODEL_URLS values). */
    private static final String[] FILE_NAMES = {
        "encoder.onnx",
        "decoder.onnx",
        "source.spm",
        "target.spm",
    };

    // ── State ────────────────────────────────────────────────────────────────

    /** Serial executor: one download or translation at a time. */
    private final ExecutorService executor  = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelFlag  = new AtomicBoolean(false);

    /** Cached ORT sessions (lazy-loaded, kept for the current direction). */
    private OrtEnvironment ortEnv         = null;
    private String         loadedDir      = null; // direction currently loaded
    private OrtSession     encoderSession = null;
    private OrtSession     decoderSession = null;
    private long           srcSpmPtr      = 0L;
    private long           tgtSpmPtr      = 0L;

    // ── Capacitor methods ─────────────────────────────────────────────────────

    @PluginMethod
    public void isModelDownloaded(PluginCall call) {
        final String direction = call.getString("direction");
        if (direction == null) { call.reject("direction required"); return; }

        final File dir = modelDir(direction);
        final boolean exists = Arrays.stream(FILE_NAMES)
            .allMatch(name -> new File(dir, name).exists());

        final JSObject out = new JSObject();
        out.put("exists", exists);
        call.resolve(out);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void downloadModel(PluginCall call) {
        final String direction = call.getString("direction");
        if (direction == null) { call.reject("direction required"); return; }
        if (!MODEL_URLS.containsKey(direction)) {
            call.reject("Unknown direction: " + direction);
            return;
        }

        call.setKeepAlive(true);
        cancelFlag.set(false);

        executor.submit(() -> {
            try {
                final File dir = modelDir(direction);
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();

                final String[] urls = MODEL_URLS.get(direction);
                for (int i = 0; i < FILE_NAMES.length; i++) {
                    if (cancelFlag.get()) { call.reject("Download cancelled"); return; }

                    final String fileName = FILE_NAMES[i];
                    final String fileUrl  = urls[i];
                    final File   outFile  = new File(dir, fileName);
                    final File   partFile = new File(dir, fileName + ".partial");
                    final int    fileIdx  = i;

                    downloadFile(fileUrl, partFile, outFile, (received, total) -> {
                        final JSObject progress = new JSObject();
                        progress.put("direction",     direction);
                        progress.put("file",          fileName);
                        progress.put("percent",       total > 0 ? (int)(received * 100L / total) : 0);
                        progress.put("receivedBytes", received);
                        progress.put("totalBytes",    total);
                        notifyListeners("downloadProgress", progress);
                    });

                    if (cancelFlag.get()) {
                        // Clean up incomplete file
                        partFile.delete();
                        outFile.delete();
                        call.reject("Download cancelled");
                        return;
                    }
                }

                call.resolve();

            } catch (Exception e) {
                Log.e(TAG, "Download failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : "Download failed");
            }
        });
    }

    @PluginMethod
    public void translate(PluginCall call) {
        if (!MarianLib.isAvailable()) {
            call.reject("MarianMT native library not compiled. " +
                "Clone sentencepiece into android/app/src/main/cpp/sentencepiece/ and rebuild.");
            return;
        }

        final String text      = call.getString("text");
        final String direction = call.getString("direction");
        if (text == null || direction == null) {
            call.reject("text and direction required");
            return;
        }
        if (!MODEL_URLS.containsKey(direction)) {
            call.reject("Unknown direction: " + direction);
            return;
        }

        executor.submit(() -> {
            try {
                final String result = runTranslation(text.trim(), direction);
                final JSObject out  = new JSObject();
                out.put("text", result);
                call.resolve(out);
            } catch (Exception e) {
                Log.e(TAG, "Translation failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : "Translation failed");
            }
        });
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        final String direction = call.getString("direction");
        if (direction == null) { call.reject("direction required"); return; }

        // Unload cached sessions if this direction is currently loaded
        if (direction.equals(loadedDir)) unloadSessions();

        final File dir = modelDir(direction);
        if (dir.exists()) {
            final File[] files = dir.listFiles();
            if (files != null) for (File f : files) f.delete();
            dir.delete();
        }
        call.resolve();
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        cancelFlag.set(true);
        call.resolve();
    }

    // ── Translation core ──────────────────────────────────────────────────────

    private String runTranslation(String text, String direction) throws Exception {
        final File dir = modelDir(direction);
        for (String name : FILE_NAMES) {
            if (!new File(dir, name).exists()) {
                throw new Exception("Model not downloaded for direction: " + direction);
            }
        }

        // Load (or reuse) sessions
        if (!direction.equals(loadedDir)) {
            unloadSessions();
            loadSessions(dir, direction);
        }

        // 1. Tokenise source
        final int[] rawIds = MarianLib.encode(srcSpmPtr, text);
        // Append EOS
        final long[] inputIds = new long[rawIds.length + 1];
        for (int i = 0; i < rawIds.length; i++) inputIds[i] = rawIds[i];
        inputIds[rawIds.length] = EOS_TOKEN_ID;

        // 2. Build encoder inputs (batch_size=1)
        final long[][] encInputIds  = new long[][]{inputIds};
        final long[][] encAttnMask  = new long[][]{onesLong(inputIds.length)};

        final Map<String, OnnxTensor> encIn = new HashMap<>();
        encIn.put("input_ids",      OnnxTensor.createTensor(ortEnv, encInputIds));
        encIn.put("attention_mask", OnnxTensor.createTensor(ortEnv, encAttnMask));

        // 3. Run encoder
        final float[][][] hiddenStates;
        try (OrtSession.Result encOut = encoderSession.run(encIn)) {
            hiddenStates = (float[][][]) ((OnnxTensor) encOut.get("last_hidden_state").get()).getValue();
        }
        // Close encoder input tensors
        for (OnnxTensor t : encIn.values()) t.close();

        // 4. Greedy decode
        final List<Long> decoderIds = new ArrayList<>();
        decoderIds.add((long) PAD_TOKEN_ID); // forced BOS

        for (int step = 0; step < MAX_OUTPUT_LEN; step++) {
            final long[]   decIdsArr = toLongArray(decoderIds);
            final long[][] decInput  = new long[][]{decIdsArr};

            final Map<String, OnnxTensor> decIn = new HashMap<>();
            decIn.put("input_ids",              OnnxTensor.createTensor(ortEnv, decInput));
            decIn.put("encoder_hidden_states",  OnnxTensor.createTensor(ortEnv, hiddenStates));
            decIn.put("encoder_attention_mask", OnnxTensor.createTensor(ortEnv, encAttnMask));

            final int nextToken;
            try (OrtSession.Result decOut = decoderSession.run(decIn)) {
                final float[][][] logits = (float[][][]) ((OnnxTensor) decOut.get("logits").get()).getValue();
                // Take argmax at the last decoder position
                nextToken = argmax(logits[0][decoderIds.size() - 1]);
            }
            for (OnnxTensor t : decIn.values()) t.close();

            if (nextToken == EOS_TOKEN_ID) break;
            decoderIds.add((long) nextToken);
        }

        // 5. Decode token IDs → text (skip forced BOS at index 0)
        final int[] outputIds = new int[decoderIds.size() - 1];
        for (int i = 1; i < decoderIds.size(); i++) {
            outputIds[i - 1] = (int)(long) decoderIds.get(i);
        }
        return MarianLib.decode(tgtSpmPtr, outputIds);
    }

    private void loadSessions(File dir, String direction) throws Exception {
        if (ortEnv == null) ortEnv = OrtEnvironment.getEnvironment();

        final OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setIntraOpNumThreads(4);

        encoderSession = ortEnv.createSession(new File(dir, "encoder.onnx").getAbsolutePath(), opts);
        decoderSession = ortEnv.createSession(new File(dir, "decoder.onnx").getAbsolutePath(), opts);
        srcSpmPtr = MarianLib.loadModel(new File(dir, "source.spm").getAbsolutePath());
        tgtSpmPtr = MarianLib.loadModel(new File(dir, "target.spm").getAbsolutePath());

        if (srcSpmPtr == 0L || tgtSpmPtr == 0L) {
            unloadSessions();
            throw new Exception("Failed to load SentencePiece tokenizer");
        }

        loadedDir = direction;
        Log.i(TAG, "Sessions loaded for direction: " + direction);
    }

    private void unloadSessions() {
        try { if (encoderSession != null) encoderSession.close(); } catch (Exception ignored) {}
        try { if (decoderSession != null) decoderSession.close(); } catch (Exception ignored) {}
        if (srcSpmPtr != 0L) MarianLib.freeModel(srcSpmPtr);
        if (tgtSpmPtr != 0L) MarianLib.freeModel(tgtSpmPtr);
        encoderSession = null;
        decoderSession = null;
        srcSpmPtr = 0L;
        tgtSpmPtr = 0L;
        loadedDir = null;
    }

    // ── File download ─────────────────────────────────────────────────────────

    @FunctionalInterface
    interface ProgressCallback {
        void onProgress(long received, long total);
    }

    /**
     * Download a single file with HTTP Range resume support.
     * Partial progress is saved in {outFile}.partial until the download completes,
     * then the partial file is renamed to outFile.
     */
    private void downloadFile(
        String urlStr, File partFile, File outFile, ProgressCallback cb
    ) throws Exception {
        if (outFile.exists()) return; // already done

        final long existing  = partFile.exists() ? partFile.length() : 0L;
        final URL  url       = new URL(urlStr);
        final HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(60_000);
        conn.setRequestProperty("User-Agent", "ERPLibreHome/1.0");
        if (existing > 0L) {
            conn.setRequestProperty("Range", "bytes=" + existing + "-");
        }
        conn.connect();

        final int code = conn.getResponseCode();
        if (code != 200 && code != 206) {
            conn.disconnect();
            throw new Exception("HTTP " + code + " downloading " + urlStr);
        }

        final long contentLen = conn.getContentLengthLong();
        final long total      = (code == 206) ? (contentLen + existing) : contentLen;
        long received         = existing;

        try (InputStream  in  = conn.getInputStream();
             RandomAccessFile raf = new RandomAccessFile(partFile, "rw")) {
            if (existing > 0L) raf.seek(existing);
            final byte[] buf = new byte[65_536]; // 64 KB chunks
            int n;
            while ((n = in.read(buf)) != -1) {
                if (cancelFlag.get()) throw new Exception("Download cancelled by user");
                raf.write(buf, 0, n);
                received += n;
                cb.onProgress(received, total > 0 ? total : received);
            }
        } finally {
            conn.disconnect();
        }

        if (!partFile.renameTo(outFile)) {
            throw new Exception("Failed to rename partial file: " + partFile.getAbsolutePath());
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private File modelDir(String direction) {
        return new File(getContext().getFilesDir(), "marian/" + direction);
    }

    private static long[] onesLong(int length) {
        final long[] arr = new long[length];
        Arrays.fill(arr, 1L);
        return arr;
    }

    private static long[] toLongArray(List<Long> list) {
        final long[] arr = new long[list.size()];
        for (int i = 0; i < list.size(); i++) arr[i] = list.get(i);
        return arr;
    }

    private static int argmax(float[] arr) {
        int best = 0;
        for (int i = 1; i < arr.length; i++) {
            if (arr[i] > arr[best]) best = i;
        }
        return best;
    }
}
