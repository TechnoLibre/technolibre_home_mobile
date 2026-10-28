package ca.erplibre.home.chatpush;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import ca.erplibre.home.BuildConfig;

/**
 * Reaches the permanent chat service by class name only: a build made with
 * -PnoChatRealtime leaves the class and its manifest entry out, and then
 * available() is false and start/stop do nothing.
 */
final class RealtimeHost {

    static final String SERVICE_CLASS = "ca.erplibre.home.chatpush.realtime.ChatPushService";

    private static final String TAG = "ChatPushRealtime";

    private RealtimeHost() {}

    /** BuildConfig.CHAT_REALTIME and the service class loads. */
    static boolean available() {
        return service() != null;
    }

    private static Class<?> service() {
        if (!BuildConfig.CHAT_REALTIME) return null;
        try {
            return Class.forName(SERVICE_CLASS);
        } catch (ClassNotFoundException | LinkageError e) {
            return null;
        }
    }

    /**
     * Starts the service in the foreground, or, when it already runs, hands
     * it a plain start so it re-reads the level (a started service may be
     * started again from the background). Android refuses a foreground
     * start from the background unless the app is exempt from battery
     * optimisation (or the caller is a boot receiver): the refusal is logged
     * by its class and the next job run tries again.
     */
    static void start(Context c) {
        Class<?> cls = service();
        if (cls == null) return;
        Intent i = new Intent(c, cls);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ChatPushRuntime.serviceRunning()) {
                c.startForegroundService(i);
            } else {
                c.startService(i);
            }
        } catch (IllegalStateException | SecurityException e) {
            Log.w(TAG, "service not started: " + e.getClass().getSimpleName());
        }
    }

    /** Stops the service; stopService is allowed from the background, unlike a start. */
    static void stop(Context c) {
        Class<?> cls = service();
        if (cls == null) return;
        try {
            c.stopService(new Intent(c, cls));
        } catch (IllegalStateException | SecurityException e) {
            Log.w(TAG, "service not stopped: " + e.getClass().getSimpleName());
        }
    }
}
