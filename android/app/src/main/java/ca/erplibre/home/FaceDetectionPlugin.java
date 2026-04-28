package ca.erplibre.home;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.util.List;

/**
 * One-shot face detection bridge for the camera streamer. The streamer
 * encodes a low-res JPEG of the live video, hands the base64 bytes to
 * detectFaces(), and uses the returned bounding boxes to draw green
 * borders on deck tiles that frame a face.
 *
 * Why a bridge instead of running ML Kit on a Java-owned camera:
 * the camera is opened via getUserMedia in the WebView and we don't
 * want to fight Android for a second camera handle. Round-tripping
 * a small JPEG (~10 ms encode + ~30 ms ML Kit on a mid-range phone)
 * fits comfortably under our 5–10 fps target.
 */
@CapacitorPlugin(name = "FaceDetectionPlugin")
public class FaceDetectionPlugin extends Plugin {

    private static final String TAG = "FaceDetectionPlugin";

    // FAST mode + no landmarks/contours — we only need bounding boxes,
    // and FAST roughly halves inference time vs. ACCURATE on Pixel-class
    // hardware. min face size 0.15 trims noise from background blobs.
    private final FaceDetector detector = FaceDetection.getClient(
        new FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
            .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
            .setMinFaceSize(0.15f)
            .build());

    @PluginMethod
    public void detectFaces(PluginCall call) {
        String b64 = call.getString("jpegBase64");
        if (b64 == null || b64.isEmpty()) {
            call.reject("missing_jpegBase64");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("bad_base64", e);
            return;
        }
        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bmp == null) {
            call.reject("decode_failed");
            return;
        }
        final int w = bmp.getWidth();
        final int h = bmp.getHeight();
        InputImage image = InputImage.fromBitmap(bmp, 0);
        detector.process(image)
            .addOnSuccessListener(faces -> {
                JSArray arr = new JSArray();
                for (Face f : faces) {
                    Rect r = f.getBoundingBox();
                    if (r == null) continue;
                    JSObject o = new JSObject();
                    // Normalised [0,1] coords — caller knows the frame
                    // size it sent us anyway, and decoupling lets the
                    // streamer downscale freely without a coord rewrite.
                    o.put("x",      (double) r.left    / w);
                    o.put("y",      (double) r.top     / h);
                    o.put("width",  (double) r.width() / w);
                    o.put("height", (double) r.height() / h);
                    arr.put(o);
                }
                bmp.recycle();
                JSObject ret = new JSObject();
                ret.put("faces", arr);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                Log.w(TAG, "ML Kit face detection failed", e);
                bmp.recycle();
                call.reject("mlkit_failure", e);
            });
    }
}
