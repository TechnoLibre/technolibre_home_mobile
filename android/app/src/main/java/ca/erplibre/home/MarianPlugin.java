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
 * ── Model variants ─────────────────────────────────────────────────────────
 * Six variants: {fr-en,en-fr} × {tiny,base,large}
 *   tiny  — quantized (int8)    ~82 MB   fast, lower quality
 *   base  — float32             ~182 MB  balanced (recommended)
 *   large — TC-Big quantized    ~300 MB  best quality, slower
 *
 * Downloaded at runtime to <filesDir>/marian/{model}/  e.g. marian/fr-en-base/
 *   encoder.onnx  — ONNX encoder
 *   decoder.onnx  — ONNX decoder
 *   source.spm    — SentencePiece vocab for source language
 *   target.spm    — SentencePiece vocab for target language
 *
 * ── Special tokens ─────────────────────────────────────────────────────────
 * EOS = 0 for all Helsinki-NLP opus-mt models.
 * BOS (decoder_start_token_id) = vocab_size - 1.
 * vocab_size is auto-detected during the warm-up pass by inspecting
 * logits.length — no hard-coded values needed.
 */
@CapacitorPlugin(name = "MarianPlugin")
public class MarianPlugin extends Plugin {

    private static final String TAG = "MarianPlugin";

    private static final int EOS_TOKEN_ID = 0;

    // Max generated tokens (prevents infinite loop)
    private static final int MAX_OUTPUT_LEN = 256;
    // Beam width for beam search decoding
    private static final int BEAM_WIDTH     = 4;

    // BOS tokens auto-detected during warm-up (vocab_size - 1).
    // Populated lazily; fallback = 59513 (opus-mt tiny/base).
    private static final Map<String, Integer> DETECTED_BOS = new HashMap<>();

    // ── Model download URLs ──────────────────────────────────────────────────
    private static final String HF_BASE = "https://huggingface.co";

    /**
     * MODEL_VARIANTS maps each model key to 4 download URLs:
     *   [0] encoder ONNX
     *   [1] decoder ONNX
     *   [2] source SentencePiece model
     *   [3] target SentencePiece model
     */
    private static final Map<String, String[]> MODEL_VARIANTS = new HashMap<>();
    static {
        final String Xen = HF_BASE + "/Xenova";
        final String HN  = HF_BASE + "/Helsinki-NLP";

        // ── FR → EN ──────────────────────────────────────────────────────────

        MODEL_VARIANTS.put("fr-en-tiny", new String[]{
            Xen + "/opus-mt-fr-en/resolve/main/onnx/encoder_model_quantized.onnx",
            Xen + "/opus-mt-fr-en/resolve/main/onnx/decoder_model_quantized.onnx",
            HN  + "/opus-mt-fr-en/resolve/main/source.spm",
            HN  + "/opus-mt-fr-en/resolve/main/target.spm",
        });
        MODEL_VARIANTS.put("fr-en-base", new String[]{
            Xen + "/opus-mt-fr-en/resolve/main/onnx/encoder_model.onnx",
            Xen + "/opus-mt-fr-en/resolve/main/onnx/decoder_model.onnx",
            HN  + "/opus-mt-fr-en/resolve/main/source.spm",
            HN  + "/opus-mt-fr-en/resolve/main/target.spm",
        });
        MODEL_VARIANTS.put("fr-en-large", new String[]{
            Xen + "/opus-mt-tc-big-fr-en/resolve/main/onnx/encoder_model_quantized.onnx",
            Xen + "/opus-mt-tc-big-fr-en/resolve/main/onnx/decoder_model_quantized.onnx",
            HN  + "/opus-mt-tc-big-fr-en/resolve/main/source.spm",
            HN  + "/opus-mt-tc-big-fr-en/resolve/main/target.spm",
        });

        // ── EN → FR ──────────────────────────────────────────────────────────

        MODEL_VARIANTS.put("en-fr-tiny", new String[]{
            Xen + "/opus-mt-en-fr/resolve/main/onnx/encoder_model_quantized.onnx",
            Xen + "/opus-mt-en-fr/resolve/main/onnx/decoder_model_quantized.onnx",
            HN  + "/opus-mt-en-fr/resolve/main/source.spm",
            HN  + "/opus-mt-en-fr/resolve/main/target.spm",
        });
        MODEL_VARIANTS.put("en-fr-base", new String[]{
            Xen + "/opus-mt-en-fr/resolve/main/onnx/encoder_model.onnx",
            Xen + "/opus-mt-en-fr/resolve/main/onnx/decoder_model.onnx",
            HN  + "/opus-mt-en-fr/resolve/main/source.spm",
            HN  + "/opus-mt-en-fr/resolve/main/target.spm",
        });
        MODEL_VARIANTS.put("en-fr-large", new String[]{
            Xen + "/opus-mt-tc-big-en-fr/resolve/main/onnx/encoder_model_quantized.onnx",
            Xen + "/opus-mt-tc-big-en-fr/resolve/main/onnx/decoder_model_quantized.onnx",
            HN  + "/opus-mt-tc-big-en-fr/resolve/main/source.spm",
            HN  + "/opus-mt-tc-big-en-fr/resolve/main/target.spm",
        });
    }

    /** Stored file names for each downloaded file (same order as MODEL_VARIANTS values). */
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

    /** Cached ORT sessions (lazy-loaded, kept for the currently loaded model). */
    private OrtEnvironment ortEnv          = null;
    private String         loadedModel     = null; // model key currently loaded
    private OrtSession     encoderSession  = null;
    private OrtSession     decoderSession  = null;
    private long           srcSpmPtr       = 0L;
    private long           tgtSpmPtr       = 0L;

    // ── Capacitor methods ─────────────────────────────────────────────────────

    @PluginMethod
    public void isModelDownloaded(PluginCall call) {
        final String model = call.getString("model");
        if (model == null) { call.reject("model required"); return; }

        final File dir = modelDir(model);
        final boolean exists = Arrays.stream(FILE_NAMES)
            .allMatch(name -> new File(dir, name).exists());

        final JSObject out = new JSObject();
        out.put("exists", exists);
        call.resolve(out);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void downloadModel(PluginCall call) {
        final String model = call.getString("model");
        if (model == null) { call.reject("model required"); return; }
        if (!MODEL_VARIANTS.containsKey(model)) {
            call.reject("Unknown model: " + model);
            return;
        }

        call.setKeepAlive(true);
        cancelFlag.set(false);

        executor.submit(() -> {
            try {
                final File dir = modelDir(model);
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();

                final String[] urls = MODEL_VARIANTS.get(model);
                for (int i = 0; i < FILE_NAMES.length; i++) {
                    if (cancelFlag.get()) { call.reject("Download cancelled"); return; }

                    final String fileName = FILE_NAMES[i];
                    final String fileUrl  = urls[i];
                    final File   outFile  = new File(dir, fileName);
                    final File   partFile = new File(dir, fileName + ".partial");

                    downloadFile(fileUrl, partFile, outFile, (received, total) -> {
                        final JSObject progress = new JSObject();
                        progress.put("model",         model);
                        progress.put("file",          fileName);
                        progress.put("percent",       total > 0 ? (int)(received * 100L / total) : 0);
                        progress.put("receivedBytes", received);
                        progress.put("totalBytes",    total);
                        notifyListeners("downloadProgress", progress);
                    });

                    if (cancelFlag.get()) {
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

        final String text  = call.getString("text");
        final String model = call.getString("model");
        if (text == null || model == null) {
            call.reject("text and model required");
            return;
        }
        if (!MODEL_VARIANTS.containsKey(model)) {
            call.reject("Unknown model: " + model);
            return;
        }

        executor.submit(() -> {
            try {
                final String result = runTranslation(text.trim(), model);
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
        final String model = call.getString("model");
        if (model == null) { call.reject("model required"); return; }

        if (model.equals(loadedModel)) unloadSessions();

        final File dir = modelDir(model);
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

    private String runTranslation(String text, String model) throws Exception {
        final File dir = modelDir(model);
        for (String name : FILE_NAMES) {
            if (!new File(dir, name).exists()) {
                throw new Exception("Model not downloaded: " + model);
            }
        }

        if (!model.equals(loadedModel)) {
            unloadSessions();
            loadSessions(dir, model);
        }

        // 1. Tokenise source
        final int[] rawIds = MarianLib.encode(srcSpmPtr, text);
        final long[] inputIds = new long[rawIds.length + 1];
        for (int i = 0; i < rawIds.length; i++) inputIds[i] = rawIds[i];
        inputIds[rawIds.length] = EOS_TOKEN_ID;

        Log.d(TAG, "[" + model + "] src tokens (" + rawIds.length + "): " + Arrays.toString(rawIds));

        // 2. Build encoder inputs (batch_size=1)
        final long[][] encInputIds = new long[][]{inputIds};
        final long[][] encAttnMask = new long[][]{onesLong(inputIds.length)};

        final Map<String, OnnxTensor> encIn = new HashMap<>();
        encIn.put("input_ids",      OnnxTensor.createTensor(ortEnv, encInputIds));
        encIn.put("attention_mask", OnnxTensor.createTensor(ortEnv, encAttnMask));

        // 3. Run encoder
        final float[][][] hiddenStates;
        try (OrtSession.Result encOut = encoderSession.run(encIn)) {
            hiddenStates = (float[][][]) ((OnnxTensor) encOut.get("last_hidden_state").get()).getValue();
        }
        for (OnnxTensor t : encIn.values()) t.close();

        // 4. Beam search decode using auto-detected BOS
        final int        bos        = DETECTED_BOS.getOrDefault(model, 59513);
        final List<Long> decoderIds = beamSearch(hiddenStates, encAttnMask, bos);

        // 5. Decode token IDs → text
        final int[] outputIds = new int[decoderIds.size()];
        for (int i = 0; i < decoderIds.size(); i++) outputIds[i] = (int)(long) decoderIds.get(i);
        Log.d(TAG, "[" + model + "] out tokens (" + outputIds.length + "): " + Arrays.toString(outputIds));
        return MarianLib.decode(tgtSpmPtr, outputIds);
    }

    private void loadSessions(File dir, String model) throws Exception {
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

        loadedModel = model;
        Log.i(TAG, "Sessions loaded for model: " + model);

        warmUpSessions(model);
    }

    /**
     * Run a dummy encoder + decoder forward pass to prime ORT's JIT kernel
     * compilation and auto-detect BOS = vocab_size - 1 from logits.length.
     * Failures are logged but never propagated — this is best-effort only.
     */
    private void warmUpSessions(String model) {
        try {
            Log.d(TAG, "Warming up: " + model);

            // Minimal encoder input: single EOS token.
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

            // Minimal decoder input: EOS as placeholder BOS (always a valid token ID).
            // We read logits.length to determine the real vocab_size.
            final long[][] decIds = new long[][]{{(long) EOS_TOKEN_ID}};

            final Map<String, OnnxTensor> decIn = new HashMap<>();
            decIn.put("input_ids",              OnnxTensor.createTensor(ortEnv, decIds));
            decIn.put("encoder_hidden_states",  OnnxTensor.createTensor(ortEnv, dummyHidden));
            decIn.put("encoder_attention_mask", OnnxTensor.createTensor(ortEnv, dummyMask));

            try (OrtSession.Result decOut = decoderSession.run(decIn)) {
                final float[][][] allLogits = (float[][][])
                    ((OnnxTensor) decOut.get("logits").get()).getValue();
                final int vocabSize   = allLogits[0][0].length;
                final int detectedBos = vocabSize - 1;
                DETECTED_BOS.put(model, detectedBos);
                Log.i(TAG, "Auto-detected BOS=" + detectedBos
                    + " (vocab_size=" + vocabSize + ") for model=" + model);
            }
            for (OnnxTensor t : decIn.values()) t.close();

            Log.d(TAG, "Warm-up done: " + model);
        } catch (Exception e) {
            Log.w(TAG, "Warm-up skipped (non-fatal): " + e.getMessage());
            DETECTED_BOS.putIfAbsent(model, 59513); // safe fallback for opus-mt tiny/base
        }
    }

    private void unloadSessions() {
        try { if (encoderSession != null) encoderSession.close(); } catch (Exception ignored) {}
        try { if (decoderSession != null) decoderSession.close(); } catch (Exception ignored) {}
        if (srcSpmPtr != 0L) MarianLib.freeModel(srcSpmPtr);
        if (tgtSpmPtr != 0L) MarianLib.freeModel(tgtSpmPtr);
        encoderSession = null;
        decoderSession = null;
        srcSpmPtr  = 0L;
        tgtSpmPtr  = 0L;
        loadedModel = null;
    }

    // ── File download ─────────────────────────────────────────────────────────

    @FunctionalInterface
    interface ProgressCallback {
        void onProgress(long received, long total);
    }

    /**
     * Download a single file with HTTP Range resume support.
     * Saves progress to {outFile}.partial; renames to outFile on completion.
     */
    private void downloadFile(
        String urlStr, File partFile, File outFile, ProgressCallback cb
    ) throws Exception {
        if (outFile.exists()) return;

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
            final byte[] buf = new byte[65_536];
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

    private File modelDir(String model) {
        return new File(getContext().getFilesDir(), "marian/" + model);
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
     * Keeps BEAM_WIDTH candidate sequences at each step.  Beams ending with EOS
     * are moved to the finished list.  The best finished sequence (by
     * length-normalised log-prob) is returned with BOS and EOS stripped.
     */
    private List<Long> beamSearch(
            float[][][] hiddenStates, long[][] encAttnMask, int bos) throws Exception {

        List<long[]> activeTokens   = new ArrayList<>();
        List<Double> activeScores   = new ArrayList<>();
        List<long[]> finishedTokens = new ArrayList<>();
        List<Double> finishedScores = new ArrayList<>();

        activeTokens.add(new long[]{(long) bos});
        activeScores.add(0.0);

        for (int step = 0; step < MAX_OUTPUT_LEN && !activeTokens.isEmpty(); step++) {

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
                    logits = all[0][seq.length - 1];
                }
                for (OnnxTensor t : decIn.values()) t.close();

                final float[] lp      = logSoftmax(logits);
                final int[]   topToks = topK(lp, BEAM_WIDTH);

                for (int tok : topToks) {
                    final long[] newSeq = Arrays.copyOf(seq, seq.length + 1);
                    newSeq[seq.length] = (long) tok;
                    candTokens.add(newSeq);
                    candScores.add(activeScores.get(b) + lp[tok]);
                }
            }

            final List<Integer> order = new ArrayList<>();
            for (int i = 0; i < candTokens.size(); i++) order.add(i);
            order.sort((i, j) -> {
                double si = lengthNorm(candScores.get(i), candTokens.get(i).length - 1);
                double sj = lengthNorm(candScores.get(j), candTokens.get(j).length - 1);
                return Double.compare(sj, si);
            });

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

            if (finishedTokens.size() >= BEAM_WIDTH) break;
        }

        finishedTokens.addAll(activeTokens);
        finishedScores.addAll(activeScores);

        if (finishedTokens.isEmpty()) return new ArrayList<>();

        int    bestIdx   = 0;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < finishedTokens.size(); i++) {
            int    genLen = finishedTokens.get(i).length - 1;
            double ns     = lengthNorm(finishedScores.get(i), genLen);
            if (ns > bestScore) { bestScore = ns; bestIdx = i; }
        }

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
