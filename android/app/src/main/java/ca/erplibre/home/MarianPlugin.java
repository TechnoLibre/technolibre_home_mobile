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
 * For Helsinki-NLP opus-mt models (Xenova ONNX exports):
 *   eos_token_id              = 0  (all directions)
 *   decoder_start_token_id    = vocab_size - 1  (= pad_token_id)
 *     fr-en: 59513  (vocab_size 59514, French → English)
 *     en-fr: 59513  (vocab_size 59514, same French decoder SPM)
 *
 * Note: the config.json for the multilingual opus-mt-en-ROMANCE model reports
 * vocab_size=65001, but Xenova/opus-mt-en-fr uses the same French target
 * vocabulary (59514 tokens).  Using 65000 as BOS causes OrtInvalidArgument.
 */
@CapacitorPlugin(name = "MarianPlugin")
public class MarianPlugin extends Plugin {

    private static final String TAG = "MarianPlugin";

    // Special token IDs for Helsinki-NLP opus-mt models (Xenova ONNX exports).
    // EOS is 0 for all opus-mt directions.
    // DECODER_START = decoder_start_token_id = pad_token_id = vocab_size - 1.
    // Both fr-en and en-fr use the same French SPM (59514 tokens) as the
    // decoder/target vocabulary, so decoder_start_token_id = 59513 for both.
    private static final int EOS_TOKEN_ID = 0;

    private static final Map<String, Integer> DECODER_START = new HashMap<>();
    static {
        DECODER_START.put("fr-en", 59513);
        DECODER_START.put("en-fr", 59513);
    }

    // Max generated tokens (prevents infinite loop)
    private static final int MAX_OUTPUT_LEN = 256;
    // Beam width for beam search decoding (4 is standard for MarianMT)
    private static final int BEAM_WIDTH     = 4;

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

        Log.d(TAG, "[" + direction + "] src tokens (" + rawIds.length + "): " + Arrays.toString(rawIds));

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

        // 4. Beam search decode
        final int        decoderBos = DECODER_START.getOrDefault(direction, 0);
        Log.d(TAG, "[" + direction + "] BOS=" + decoderBos);
        final List<Long> decoderIds = beamSearch(hiddenStates, encAttnMask, decoderBos);

        // 5. Decode token IDs → text
        final int[] outputIds = new int[decoderIds.size()];
        for (int i = 0; i < decoderIds.size(); i++) outputIds[i] = (int)(long) decoderIds.get(i);
        Log.d(TAG, "[" + direction + "] out tokens (" + outputIds.length + "): " + Arrays.toString(outputIds));
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

        // ── Warm-up pass ─────────────────────────────────────────────────────
        // On Android, ORT quantized kernels are JIT-compiled lazily: the very
        // first session.run() after createSession() triggers compilation inline
        // and may produce incorrect output while the compiled kernel is being
        // installed.  All subsequent calls use the compiled version and are
        // correct.  Running one dummy forward pass here ensures real translate()
        // calls always use the compiled kernels.
        warmUpSessions(direction);
    }

    /**
     * Run a single dummy encoder + decoder forward pass to prime ORT's JIT
     * kernel compilation for this direction.  Output is discarded.
     * Failures are logged but never propagated — this is best-effort only.
     */
    private void warmUpSessions(String direction) {
        try {
            Log.d(TAG, "Warming up sessions for direction: " + direction);

            // Minimal encoder input: a single EOS token.
            final long[][] dummyIds  = new long[][]{{(long) EOS_TOKEN_ID}};
            final long[][] dummyMask = new long[][]{{1L}};

            final Map<String, OnnxTensor> encIn = new HashMap<>();
            encIn.put("input_ids",      OnnxTensor.createTensor(ortEnv, dummyIds));
            encIn.put("attention_mask", OnnxTensor.createTensor(ortEnv, dummyMask));

            final float[][][] dummyHidden;
            try (OrtSession.Result encOut = encoderSession.run(encIn)) {
                dummyHidden = (float[][][])
                    ((OnnxTensor) encOut.get("last_hidden_state").get()).getValue();
            }
            for (OnnxTensor t : encIn.values()) t.close();

            // Minimal decoder input: a single BOS token.
            final int bos = DECODER_START.getOrDefault(direction, 0);
            final long[][] decIds = new long[][]{{(long) bos}};

            final Map<String, OnnxTensor> decIn = new HashMap<>();
            decIn.put("input_ids",              OnnxTensor.createTensor(ortEnv, decIds));
            decIn.put("encoder_hidden_states",  OnnxTensor.createTensor(ortEnv, dummyHidden));
            decIn.put("encoder_attention_mask", OnnxTensor.createTensor(ortEnv, dummyMask));

            try (OrtSession.Result ignored = decoderSession.run(decIn)) { /* discard */ }
            for (OnnxTensor t : decIn.values()) t.close();

            Log.d(TAG, "Warm-up done for direction: " + direction);
        } catch (Exception e) {
            Log.w(TAG, "Warm-up skipped (non-fatal): " + e.getMessage());
        }
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

    // ── Beam search ───────────────────────────────────────────────────────────

    /**
     * Beam search decoder.
     *
     * Keeps BEAM_WIDTH candidate sequences at each step.  At every step each
     * active beam is expanded to BEAM_WIDTH new candidates (top-k from the
     * decoder logits).  Beams that produce EOS are moved to the finished list.
     * The best finished sequence (by length-normalised log-prob) is returned as
     * a list of token IDs with BOS and EOS already stripped.
     */
    private List<Long> beamSearch(
            float[][][] hiddenStates, long[][] encAttnMask, int bos) throws Exception {

        List<long[]> activeTokens   = new ArrayList<>();
        List<Double> activeScores   = new ArrayList<>();
        List<long[]> finishedTokens = new ArrayList<>();
        List<Double> finishedScores = new ArrayList<>();

        // Seed: single beam containing only BOS
        activeTokens.add(new long[]{(long) bos});
        activeScores.add(0.0);

        for (int step = 0; step < MAX_OUTPUT_LEN && !activeTokens.isEmpty(); step++) {

            // ── Expand every active beam ──────────────────────────────────────
            final List<long[]> candTokens = new ArrayList<>();
            final List<Double> candScores = new ArrayList<>();

            for (int b = 0; b < activeTokens.size(); b++) {
                final long[]   seq    = activeTokens.get(b);
                final long[][] decIn2 = new long[][]{seq};

                final Map<String, OnnxTensor> decIn = new HashMap<>();
                decIn.put("input_ids",              OnnxTensor.createTensor(ortEnv, decIn2));
                decIn.put("encoder_hidden_states",  OnnxTensor.createTensor(ortEnv, hiddenStates));
                decIn.put("encoder_attention_mask", OnnxTensor.createTensor(ortEnv, encAttnMask));

                final float[] logits;
                try (OrtSession.Result decOut = decoderSession.run(decIn)) {
                    final float[][][] all = (float[][][])
                        ((OnnxTensor) decOut.get("logits").get()).getValue();
                    logits = all[0][seq.length - 1]; // logits at last position
                }
                for (OnnxTensor t : decIn.values()) t.close();

                final float[] lp      = logSoftmax(logits);
                final int[]   topToks = topK(lp, BEAM_WIDTH);

                if (step == 0) {
                    // Log first-step candidates to diagnose BOS/vocab issues
                    final StringBuilder sb = new StringBuilder("[beam] step0 top-" + BEAM_WIDTH + ": ");
                    for (int t : topToks) sb.append(t).append("(").append(String.format("%.3f", lp[t])).append(") ");
                    Log.d(TAG, sb.toString());
                    Log.d(TAG, "[beam] vocab_size (approx) = " + logits.length);
                }

                for (int tok : topToks) {
                    final long[] newSeq = Arrays.copyOf(seq, seq.length + 1);
                    newSeq[seq.length] = (long) tok;
                    candTokens.add(newSeq);
                    candScores.add(activeScores.get(b) + lp[tok]);
                }
            }

            // ── Rank all candidates by length-normalised score ────────────────
            final List<Integer> order = new ArrayList<>();
            for (int i = 0; i < candTokens.size(); i++) order.add(i);
            order.sort((i, j) -> {
                double si = lengthNorm(candScores.get(i), candTokens.get(i).length - 1);
                double sj = lengthNorm(candScores.get(j), candTokens.get(j).length - 1);
                return Double.compare(sj, si); // descending
            });

            // ── Route top-BEAM_WIDTH into active or finished ──────────────────
            activeTokens.clear();
            activeScores.clear();

            for (int idx : order) {
                if (activeTokens.size() >= BEAM_WIDTH) break;
                final long[] seq   = candTokens.get(idx);
                final double score = candScores.get(idx);
                if (seq[seq.length - 1] == EOS_TOKEN_ID) {
                    finishedTokens.add(seq);
                    finishedScores.add(score);
                } else {
                    activeTokens.add(seq);
                    activeScores.add(score);
                }
            }

            if (finishedTokens.size() >= BEAM_WIDTH) break; // enough hypotheses
        }

        // Move remaining active beams (hit MAX_OUTPUT_LEN) into finished
        finishedTokens.addAll(activeTokens);
        finishedScores.addAll(activeScores);

        if (finishedTokens.isEmpty()) return new ArrayList<>();

        // ── Pick best finished beam ───────────────────────────────────────────
        int    bestIdx   = 0;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < finishedTokens.size(); i++) {
            int    genLen = finishedTokens.get(i).length - 1; // exclude BOS
            double ns     = lengthNorm(finishedScores.get(i), genLen);
            if (ns > bestScore) { bestScore = ns; bestIdx = i; }
        }

        // Return token IDs, stripping BOS (index 0) and any trailing EOS
        final long[]    best   = finishedTokens.get(bestIdx);
        final List<Long> result = new ArrayList<>();
        for (int i = 1; i < best.length; i++) {
            if (best[i] == EOS_TOKEN_ID) break;
            result.add(best[i]);
        }
        return result;
    }

    /** Length normalisation with alpha = 0.6 (standard for MarianMT). */
    private static double lengthNorm(double score, int genLen) {
        return score / Math.pow(Math.max(genLen, 1), 0.6);
    }

    /** Numerically stable log-softmax. */
    private static float[] logSoftmax(float[] logits) {
        float max = logits[0];
        for (float v : logits) if (v > max) max = v;
        double sum = 0.0;
        for (float v : logits) sum += Math.exp(v - max);
        final float logSum = (float)(max + Math.log(sum));
        final float[] out  = new float[logits.length];
        for (int i = 0; i < logits.length; i++) out[i] = logits[i] - logSum;
        return out;
    }

    /** Returns the indices of the top-k largest elements, highest first. */
    private static int[] topK(float[] arr, int k) {
        final int[]     result = new int[k];
        final boolean[] used   = new boolean[arr.length];
        for (int r = 0; r < k; r++) {
            int best = -1;
            for (int j = 0; j < arr.length; j++) {
                if (!used[j] && (best < 0 || arr[j] > arr[best])) best = j;
            }
            result[r] = best;
            if (best >= 0) used[best] = true;
        }
        return result;
    }
}
