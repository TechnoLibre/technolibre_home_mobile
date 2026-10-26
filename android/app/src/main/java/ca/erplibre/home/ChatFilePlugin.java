package ca.erplibre.home;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

/**
 * Chat file transfer over ChatFileTransfer (OkHttp): GET as text, a
 * multipart upload streamed from a file, a download streamed to a file.
 * Every transfer runs on a worker thread, never the bridge thread; its id
 * is reserved on the bridge thread first, so a cancel() that comes before
 * the worker starts it still stops it. Ids are unique per transfer: an id
 * held by a transfer still running is rejected (« id in use »).
 *
 * Files are named by uri (file: URI or absolute path) and must lie inside
 * filesDir/chat; any other path is rejected. A request that never reached
 * the server rejects with code UNSENT, a transfer stopped by cancel() with
 * code CANCELLED. Event chatFileProgress {id, done, total} (total null when
 * unknown) is emitted at most every 250 ms per transfer.
 *
 * toJpeg converts a picked image (HEIC to JPEG, a photo reduced before
 * sending) on the same workers, under the same chatRoot rule. openWith
 * hands a file of the same directory to Android's « open with » chooser
 * through the app's FileProvider (file_paths.xml « chat_files »).
 */
@CapacitorPlugin(name = "ChatFile")
public class ChatFilePlugin extends Plugin {

    static final String UNSENT = "UNSENT";
    static final String CANCELLED = "CANCELLED";
    /** Code of an openWith rejection when no app on the phone takes the file. */
    static final String NO_APP = "NO_APP";

    private static final long PROGRESS_EVERY_MS = 250;

    private final ChatFileTransfer transfer = new ChatFileTransfer();
    private final ExecutorService worker = Executors.newCachedThreadPool();
    /** One toJpeg at a time: a full-size photo decodes to tens of MB. */
    private final Semaphore conversions = new Semaphore(1);

    private File chatRoot() {
        return new File(getContext().getFilesDir(), "chat");
    }

    @PluginMethod
    public void getText(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Map<String, String> headers = strings(call.getObject("headers", new JSObject()));
        worker.execute(() -> {
            try {
                call.resolve(answer(transfer.getText(url, headers)));
            } catch (Exception e) {
                reject(call, e);
            }
        });
    }

    @PluginMethod
    public void upload(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        JSObject file = call.getObject("file");
        if (id == null || url == null || url.isEmpty() || file == null) {
            call.reject("id, url and file are required");
            return;
        }
        Map<String, String> headers = strings(call.getObject("headers", new JSObject()));
        Map<String, String> fields = strings(call.getObject("fields", new JSObject()));
        String uri = file.getString("uri");
        String name = file.getString("name", "file");
        String mimetype = file.getString("mimetype", "application/octet-stream");
        ChatFileTransfer.Slot slot = reserveOrReject(call, id);
        if (slot == null) return;
        worker.execute(() -> {
            JSObject result;
            try {
                File source = ChatFileTransfer.resolveInside(chatRoot(), uri);
                result = answer(transfer.upload(slot, url, headers, fields, source,
                    name, mimetype, throttled(id)));
            } catch (Exception e) {
                transfer.release(slot);
                reject(call, e);
                return;
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String uri = call.getString("uri");
        if (id == null || url == null || url.isEmpty() || uri == null) {
            call.reject("id, url and uri are required");
            return;
        }
        Map<String, String> headers = strings(call.getObject("headers", new JSObject()));
        ChatFileTransfer.Slot slot = reserveOrReject(call, id);
        if (slot == null) return;
        worker.execute(() -> {
            ChatFileTransfer.Download d;
            try {
                File target = ChatFileTransfer.resolveInside(chatRoot(), uri);
                d = transfer.download(slot, url, headers, target, throttled(id));
            } catch (Exception e) {
                transfer.release(slot);
                reject(call, e);
                return;
            }
            JSObject result = new JSObject();
            result.put("status", d.status);
            result.put("size", d.size);
            result.put("sha1", d.sha1 == null ? JSONObject.NULL : d.sha1);
            result.put("mimetype", d.mimetype == null ? JSONObject.NULL : d.mimetype);
            call.resolve(result);
        });
    }

    /**
     * Writes the image at from as a JPEG at to: {from, to, maxPx, quality}
     * → {size, width, height}. The EXIF orientation is applied, the long
     * side fitted to maxPx (0 keeps the size, ChatImageSize.fit), a
     * transparent image laid on white. The JPEG is written to « to.part »
     * then renamed, so to may be from and a failure leaves no partial file.
     * Android 9+ decodes with ImageDecoder (HEIC/HEIF included); older
     * versions with BitmapFactory, which rejects a HEIC. Conversions run
     * one at a time, the others waiting on their worker.
     */
    @PluginMethod
    public void toJpeg(PluginCall call) {
        String from = call.getString("from");
        String to = call.getString("to");
        int maxPx = call.getInt("maxPx", 0);
        int quality = call.getInt("quality", 92);
        if (from == null || to == null || quality < 0 || quality > 100) {
            call.reject("from, to and a quality from 0 to 100 are required");
            return;
        }
        worker.execute(() -> {
            Bitmap bitmap = null;
            boolean held = false;
            try {
                conversions.acquire();
                held = true;
                File source = ChatFileTransfer.resolveInside(chatRoot(), from);
                File target = ChatFileTransfer.resolveInside(chatRoot(), to);
                bitmap = decodeFitted(source, maxPx);
                long size = writeJpeg(bitmap, target, quality);
                JSObject result = new JSObject();
                result.put("size", size);
                result.put("width", bitmap.getWidth());
                result.put("height", bitmap.getHeight());
                call.resolve(result);
            } catch (Exception | OutOfMemoryError e) {
                String why = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                call.reject("ChatFile error: " + why);
            } finally {
                if (bitmap != null) bitmap.recycle();
                if (held) conversions.release();
            }
        });
    }

    /**
     * Opens a file of the chat directory in another app: {uri, mimetype,
     * title?}. The file is shared as a content: URI of the app's
     * FileProvider (never a file: URI, which Android refuses to pass on)
     * with a read grant, through a chooser titled title. Rejects with code
     * NO_APP when no app takes the mimetype, and when the file is missing
     * or outside the chat directory.
     */
    @PluginMethod
    public void openWith(PluginCall call) {
        String uri = call.getString("uri");
        String mimetype = call.getString("mimetype");
        if (uri == null || uri.isEmpty()) {
            call.reject("uri is required");
            return;
        }
        if (mimetype == null || mimetype.isEmpty()) mimetype = "application/octet-stream";
        String title = call.getString("title", "");
        try {
            File file = ChatFileTransfer.resolveInside(chatRoot(), uri);
            if (!file.isFile()) {
                call.reject("ChatFile error: no such file " + file.getName());
                return;
            }
            Uri content = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(content, mimetype);
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // createChooser carries the read grant over to the app picked
            Intent chooser = Intent.createChooser(view, title);
            if (getActivity() != null) {
                getActivity().startActivity(chooser);
            } else {
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(chooser);
            }
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("ChatFile error: no app opens " + mimetype, NO_APP, e);
        } catch (Exception e) {
            call.reject("ChatFile error: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) transfer.cancel(id);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
    }

    /** The image at source, upright and fitted to maxPx (ChatImageSize.fit). */
    private static Bitmap decodeFitted(File source, int maxPx) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(source), (decoder, info, src) -> {
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                int[] fit = ChatImageSize.fit(info.getSize().getWidth(), info.getSize().getHeight(), maxPx);
                decoder.setTargetSize(fit[0], fit[1]);
            });
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(source.getPath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("cannot decode " + source.getName());
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = ChatImageSize.sampleSize(bounds.outWidth, bounds.outHeight, maxPx);
        Bitmap decoded = BitmapFactory.decodeFile(source.getPath(), options);
        if (decoded == null) throw new IOException("cannot decode " + source.getName());
        int[] fit = ChatImageSize.fit(bounds.outWidth, bounds.outHeight, maxPx);
        Matrix matrix = orientation(new ExifInterface(source.getPath())
            .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL));
        matrix.preScale((float) fit[0] / decoded.getWidth(), (float) fit[1] / decoded.getHeight());
        Bitmap upright = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), matrix, true);
        if (upright != decoded) decoded.recycle();
        return upright;
    }

    /** The transform that shows an image of the given EXIF orientation upright. */
    private static Matrix orientation(int exif) {
        Matrix m = new Matrix();
        switch (exif) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.postRotate(90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.postRotate(-90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(-90); break;
            default: break;
        }
        return m;
    }

    /**
     * bitmap as a JPEG at target (through « target.part », renamed once
     * complete); a bitmap with transparency is laid on white first, as
     * JPEG has no alpha. Returns the bytes written.
     */
    private static long writeJpeg(Bitmap bitmap, File target, int quality) throws IOException {
        Bitmap opaque = bitmap;
        if (bitmap.hasAlpha()) {
            opaque = Bitmap.createBitmap(bitmap.getWidth(), bitmap.getHeight(), Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(opaque);
            canvas.drawColor(Color.WHITE);
            canvas.drawBitmap(bitmap, 0, 0, null);
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("cannot make " + parent.getName());
        }
        File part = new File(parent, target.getName() + ".part");
        try {
            try (FileOutputStream out = new FileOutputStream(part)) {
                if (!opaque.compress(Bitmap.CompressFormat.JPEG, quality, out)) {
                    throw new IOException("JPEG encoding failed");
                }
                out.getFD().sync();
            }
            if (!part.renameTo(target)) throw new IOException("cannot rename to " + target.getName());
            return target.length();
        } finally {
            if (part.exists()) part.delete();
            if (opaque != bitmap) opaque.recycle();
        }
    }

    /**
     * The id's hold for this call, taken on the bridge thread before the
     * worker starts; null (call rejected) when another transfer holds the id.
     * The transfer ends the hold before the call settles, so the caller may
     * reuse the id as soon as it has the answer.
     */
    private ChatFileTransfer.Slot reserveOrReject(PluginCall call, String id) {
        try {
            return transfer.reserve(id);
        } catch (ChatFileTransfer.IdInUseException e) {
            call.reject(e.getMessage());
            return null;
        }
    }

    private static void reject(PluginCall call, Exception e) {
        String msg = "ChatFile error: " + e.getMessage();
        if (e instanceof ChatFileTransfer.UnsentException) {
            call.reject(msg, UNSENT, e);
        } else if (e instanceof ChatFileTransfer.CancelledException) {
            call.reject(msg, CANCELLED, e);
        } else {
            call.reject(msg, e);
        }
    }

    /** Emits chatFileProgress for id, skipping updates that come within 250 ms of the last one sent. */
    private ChatFileTransfer.Progress throttled(String id) {
        final long[] last = {0};
        return (done, total) -> {
            long now = System.currentTimeMillis();
            if (now - last[0] < PROGRESS_EVERY_MS) return;
            last[0] = now;
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("done", done);
            data.put("total", total < 0 ? JSONObject.NULL : total);
            notifyListeners("chatFileProgress", data);
        };
    }

    private static JSObject answer(ChatFileTransfer.Answer a) {
        JSObject headers = new JSObject();
        for (Map.Entry<String, String> h : a.headers.entrySet()) headers.put(h.getKey(), h.getValue());
        JSObject result = new JSObject();
        result.put("status", a.status);
        result.put("headers", headers);
        result.put("data", a.data);
        return result;
    }

    /** The string values of a JS object, in its key order; null values are left out. */
    private static Map<String, String> strings(JSObject obj) {
        Map<String, String> out = new LinkedHashMap<>();
        if (obj == null) return out;
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (obj.isNull(key)) continue;
            String value = obj.optString(key, null);
            if (value != null) out.put(key, value);
        }
        return out;
    }
}
