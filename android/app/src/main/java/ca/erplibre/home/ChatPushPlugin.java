package ca.erplibre.home;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ca.erplibre.home.chatpush.ChatPushJob;
import ca.erplibre.home.chatpush.ChatPushOpen;
import ca.erplibre.home.chatpush.ChatPushRuntime;

/**
 * Bridge between the chat's JavaScript and ChatPushRuntime, the native side
 * of the closed-app chat notifications.
 *
 * Every call that changes the runtime's state runs on one serial worker in
 * the order the calls arrive, so setNtfy's network check never holds the
 * Capacitor thread and a subscribe that follows it sees the stored server.
 * checkNow and decodeQr run on a second worker. A rejection names the step
 * that failed, never a token, a session id, a URL or an exception message.
 *
 * publishSettings ends by aligning the 15-minute job and the permanent
 * service with the new level (ChatPushJob.apply): the app is in the
 * foreground then, when Android lets it start a foreground service.
 *
 * The foreground flag is written on the main thread at resume and pause,
 * without waiting for the JavaScript. A notification tap reaching the
 * running activity is emitted as event pushOpen {url} (kept until a
 * listener takes it); one that launched the activity is read by
 * takeLaunchUrl.
 */
@CapacitorPlugin(name = "ChatPushPlugin")
public class ChatPushPlugin extends Plugin {

    private final ExecutorService serial = Executors.newSingleThreadExecutor();
    private final ExecutorService work = Executors.newSingleThreadExecutor();

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        ChatPushRuntime.setForeground(getContext(), true);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        ChatPushRuntime.setForeground(getContext(), false);
    }

    /**
     * BridgeActivity also passes its launch intent here once the bridge is
     * built; that one is left to takeLaunchUrl, so a launching tap is read
     * once, by the call the app makes at start.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        android.app.Activity activity = getActivity();
        if (activity != null && intent == activity.getIntent()) return;
        String url = ChatPushOpen.takeUrl(getContext(), intent);
        if (url == null) return;
        JSObject ev = new JSObject();
        ev.put("url", url);
        notifyListeners("pushOpen", ev, true);
    }

    @Override
    protected void handleOnDestroy() {
        serial.shutdown();
        work.shutdown();
        super.handleOnDestroy();
    }

    private ChatPushRuntime runtime() {
        return ChatPushRuntime.get(getContext());
    }

    private interface Step {
        void run(PluginCall call) throws Exception;
    }

    /** Runs step on the executor; any exception rejects with "<what> failed". */
    private void on(ExecutorService executor, final PluginCall call, final String what, final Step step) {
        executor.execute(() -> {
            try {
                step.run(call);
            } catch (Exception e) {
                call.reject(what + " failed");
            }
        });
    }

    private static String required(PluginCall call, String key) {
        String v = call.getString(key);
        if (v == null || v.isEmpty()) throw new IllegalArgumentException(key);
        return v;
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject out = new JSObject();
        out.put("realtime", ChatPushRuntime.realtimeBuild());
        call.resolve(out);
    }

    @PluginMethod
    public void publishSettings(PluginCall call) {
        on(serial, call, "publishSettings", c -> {
            JSArray accounts = c.getArray("accounts", new JSArray());
            Map<String, String> strings = new HashMap<>();
            JSObject s = c.getObject("strings", new JSObject());
            for (Iterator<String> it = s.keys(); it.hasNext();) {
                String k = it.next();
                strings.put(k, s.optString(k, ""));
            }
            runtime().publishSettings(c.getInt("level", 3), Boolean.TRUE.equals(c.getBoolean("allowHttp", false)),
                    strings, accounts);
            ChatPushJob.apply(getContext());
            c.resolve();
        });
    }

    @PluginMethod
    public void setNtfy(PluginCall call) {
        on(serial, call, "setNtfy", c -> {
            String token = c.getString("token", "");
            String reason = runtime().setNtfy(required(c, "url"), token == null ? "" : token,
                    required(c, "prefix"), c.getInt("cacheSeconds", 43200));
            JSObject out = new JSObject();
            out.put("ok", reason == null);
            out.put("reason", reason == null ? JSONObject.NULL : reason);
            c.resolve(out);
        });
    }

    @PluginMethod
    public void removeNtfy(PluginCall call) {
        on(serial, call, "removeNtfy", c -> {
            runtime().removeNtfy(required(c, "url"));
            c.resolve();
        });
    }

    @PluginMethod
    public void subscribe(PluginCall call) {
        on(serial, call, "subscribe", c -> {
            JSONObject s = runtime().subscribe(required(c, "configId"), required(c, "ntfyUrl"),
                    Boolean.TRUE.equals(c.getBoolean("renew", false)));
            c.resolve(JSObject.fromJSONObject(s));
        });
    }

    @PluginMethod
    public void unsubscribe(PluginCall call) {
        on(serial, call, "unsubscribe", c -> {
            runtime().unsubscribe(required(c, "configId"), c.getString("pendingEndpoint"));
            c.resolve();
        });
    }

    @PluginMethod
    public void mirrorSession(PluginCall call) {
        on(serial, call, "mirrorSession", c -> {
            String database = c.getString("database", "");
            runtime().mirrorSession(required(c, "configId"), required(c, "odooUrl"),
                    database == null ? "" : database, required(c, "sessionId"));
            c.resolve();
        });
    }

    @PluginMethod
    public void forgetSession(PluginCall call) {
        on(serial, call, "forgetSession", c -> {
            runtime().forgetSession(required(c, "configId"));
            c.resolve();
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        on(serial, call, "status", c -> {
            JSONObject h = runtime().health()
                    .put("batteryExempt", BatteryExemption.ignoringBatteryOptimizations(getContext()));
            c.resolve(JSObject.fromJSONObject(h));
        });
    }

    @PluginMethod
    public void checkNow(PluginCall call) {
        on(work, call, "checkNow", c -> {
            runtime().checkNow();
            c.resolve();
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        on(serial, call, "clear", c -> {
            Long channelId = c.getData().has("channelId") && !c.getData().isNull("channelId")
                    ? c.getData().getLong("channelId") : null;
            runtime().clear(required(c, "configId"), channelId,
                    Boolean.TRUE.equals(c.getBoolean("inbox", false)),
                    Boolean.TRUE.equals(c.getBoolean("summary", false)));
            c.resolve();
        });
    }

    @PluginMethod
    public void shown(PluginCall call) {
        on(serial, call, "shown", c -> {
            JSONArray tags = new JSONArray();
            for (String t : runtime().shown()) tags.put(new JSONObject().put("tag", t));
            JSObject out = new JSObject();
            out.put("tags", tags);
            c.resolve(out);
        });
    }

    @PluginMethod
    public void takeLaunchUrl(PluginCall call) {
        android.app.Activity activity = getActivity();
        String url = activity == null ? null : ChatPushOpen.takeUrl(getContext(), activity.getIntent());
        JSObject out = new JSObject();
        out.put("url", url == null ? JSONObject.NULL : url);
        call.resolve(out);
    }

    /**
     * The text of the first QR code in the image at path (a file path, or a
     * file: or content: URI), or null when there is none.
     */
    @PluginMethod
    public void decodeQr(PluginCall call) {
        on(work, call, "decodeQr", c -> {
            String path = required(c, "path");
            Uri uri = path.startsWith("content:") || path.startsWith("file:")
                    ? Uri.parse(path) : Uri.fromFile(new File(path));
            InputImage image = InputImage.fromFilePath(getContext(), uri);
            final BarcodeScanner scanner = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE).build());
            Task<List<Barcode>> task;
            try {
                task = scanner.process(image);
            } catch (RuntimeException e) {
                scanner.close();
                throw e;
            }
            task.addOnSuccessListener((List<Barcode> codes) -> {
                String text = null;
                for (Barcode b : codes) {
                    if (b.getRawValue() != null) {
                        text = b.getRawValue();
                        break;
                    }
                }
                JSObject out = new JSObject();
                out.put("text", text == null ? JSONObject.NULL : text);
                c.resolve(out);
                scanner.close();
            }).addOnFailureListener(e -> {
                c.reject("decodeQr failed");
                scanner.close();
            });
        });
    }

    @PluginMethod
    public void batteryExempt(PluginCall call) {
        JSObject out = new JSObject();
        out.put("exempt", BatteryExemption.ignoringBatteryOptimizations(getContext()));
        call.resolve(out);
    }

    /** Opens the system list of battery-optimisation exemptions, as the SMS gateway does. */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            BatteryExemption.openBatterySettings(getContext());
            call.resolve();
        } catch (Exception e) {
            call.reject("requestBatteryExemption failed");
        }
    }
}
