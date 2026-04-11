package ca.erplibre.home;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.PixelCopy;
import android.view.Window;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Capacitor plugin for on-device OCR text detection.
 *
 * Uses PixelCopy (API 26+) to capture the current window composited frame
 * (which includes the native camera SurfaceView layer) and Google ML Kit
 * Text Recognition to detect text blocks in that frame.
 *
 * JavaScript surface:
 *   startScan({ intervalMs? })  → void   (starts periodic OCR, fires "textDetected" events)
 *   stopScan()                  → void
 *
 * Events:
 *   "textDetected" → { blocks: [{ text, x, y, width, height }] }
 *   Coordinates are normalised to [0, 1] relative to the captured window size.
 */
@CapacitorPlugin(name = "OcrPlugin")
public class OcrPlugin extends Plugin {

    private static final String TAG = "OcrPlugin";

    private final TextRecognizer recognizer =
            TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

    private final AtomicBoolean isScanning = new AtomicBoolean(false);
    private HandlerThread handlerThread;
    private Handler bgHandler;
    private int intervalMs = 900;

    // ─────────────────────────────────────────────────────────────────────────

    @PluginMethod
    public void startScan(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("OCR scanning requires Android 8.0 (API 26) or higher");
            return;
        }

        intervalMs = call.getInt("intervalMs", 900);

        if (isScanning.getAndSet(true)) {
            // Already running — just update interval
            call.resolve();
            return;
        }

        handlerThread = new HandlerThread("OcrScanThread");
        handlerThread.start();
        bgHandler = new Handler(handlerThread.getLooper());

        // Brief delay so the camera preview has time to appear
        bgHandler.postDelayed(this::doScan, 250);
        call.resolve();
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private void stopInternal() {
        isScanning.set(false);
        if (bgHandler != null) {
            bgHandler.removeCallbacksAndMessages(null);
        }
        if (handlerThread != null) {
            handlerThread.quitSafely();
            handlerThread = null;
        }
        bgHandler = null;
    }

    private void doScan() {
        if (!isScanning.get()) return;

        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            return;
        }

        Window window = activity.getWindow();

        // Get the window size on the UI thread (required for PixelCopy)
        int[] dims = new int[2];
        activity.runOnUiThread(() -> {
            dims[0] = window.getDecorView().getWidth();
            dims[1] = window.getDecorView().getHeight();
        });

        // Slight wait for runOnUiThread to complete
        try { Thread.sleep(30); } catch (InterruptedException ignored) {}

        int w = dims[0];
        int h = dims[1];
        if (w == 0 || h == 0) {
            scheduleNext();
            return;
        }

        Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PixelCopy.request(window, bitmap, result -> {
                if (result == PixelCopy.SUCCESS) {
                    analyzeAndNotify(bitmap, w, h);
                } else {
                    Log.w(TAG, "PixelCopy failed with code: " + result);
                    scheduleNext();
                }
            }, bgHandler);
        }
        // scheduleNext() is called inside analyzeAndNotify (or on failure above)
    }

    private void analyzeAndNotify(Bitmap bitmap, int bmpW, int bmpH) {
        InputImage image = InputImage.fromBitmap(bitmap, 0);

        recognizer.process(image)
            .addOnSuccessListener(text -> {
                JSArray blocks = new JSArray();

                for (Text.TextBlock block : text.getTextBlocks()) {
                    Rect box = block.getBoundingBox();
                    if (box == null) continue;

                    // Skip empty or whitespace-only text
                    String blockText = block.getText().trim();
                    if (blockText.isEmpty()) continue;

                    JSObject b = new JSObject();
                    b.put("text",   blockText);
                    b.put("x",      (double) box.left    / bmpW);
                    b.put("y",      (double) box.top     / bmpH);
                    b.put("width",  (double) box.width() / bmpW);
                    b.put("height", (double) box.height() / bmpH);
                    blocks.put(b);
                }

                JSObject result = new JSObject();
                result.put("blocks", blocks);
                notifyListeners("textDetected", result);
                bitmap.recycle();
                scheduleNext();
            })
            .addOnFailureListener(e -> {
                Log.e(TAG, "ML Kit OCR failed", e);
                bitmap.recycle();
                scheduleNext();
            });
    }

    private void scheduleNext() {
        if (!isScanning.get() || bgHandler == null) return;
        bgHandler.postDelayed(this::doScan, intervalMs);
    }
}
