package ca.erplibre.home;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Chat file transfer over ChatFileTransfer (OkHttp): GET as text, a
 * multipart upload streamed from a file, a download streamed to a file.
 * Every transfer runs on a worker thread, never the bridge thread.
 *
 * Files are named by uri (file: URI or absolute path) and must lie inside
 * filesDir/chat; any other path is rejected. A request that never reached
 * the server rejects with code UNSENT, a transfer stopped by cancel() with
 * code CANCELLED. Event chatFileProgress {id, done, total} (total null when
 * unknown) is emitted at most every 250 ms per transfer.
 */
@CapacitorPlugin(name = "ChatFile")
public class ChatFilePlugin extends Plugin {

    static final String UNSENT = "UNSENT";
    static final String CANCELLED = "CANCELLED";

    private static final long PROGRESS_EVERY_MS = 250;

    private final ChatFileTransfer transfer = new ChatFileTransfer();
    private final ExecutorService worker = Executors.newCachedThreadPool();

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
        worker.execute(() -> {
            try {
                File source = ChatFileTransfer.resolveInside(chatRoot(), uri);
                call.resolve(answer(transfer.upload(id, url, headers, fields, source,
                    name, mimetype, throttled(id))));
            } catch (Exception e) {
                reject(call, e);
            }
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
        worker.execute(() -> {
            try {
                File target = ChatFileTransfer.resolveInside(chatRoot(), uri);
                ChatFileTransfer.Download d = transfer.download(id, url, headers, target, throttled(id));
                JSObject result = new JSObject();
                result.put("status", d.status);
                result.put("size", d.size);
                result.put("sha1", d.sha1 == null ? JSONObject.NULL : d.sha1);
                result.put("mimetype", d.mimetype == null ? JSONObject.NULL : d.mimetype);
                call.resolve(result);
            } catch (Exception e) {
                reject(call, e);
            }
        });
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
