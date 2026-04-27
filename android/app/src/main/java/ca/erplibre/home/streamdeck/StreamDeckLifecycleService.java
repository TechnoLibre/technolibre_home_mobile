package ca.erplibre.home.streamdeck;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

/**
 * Started service whose only job is to receive {@link #onTaskRemoved} when
 * the user swipes the app off the recents screen, and run a registered
 * cleanup callback before the OS reclaims the process.
 *
 * The Android Activity lifecycle does not guarantee onDestroy on a swipe-
 * away — the system can kill the process directly. Service.onTaskRemoved
 * is the only Android-blessed hook for that path. Without this, the deck
 * keeps the last painted tile until USB is unplugged or the app reopens.
 *
 * Plugin starts the service in load() and registers the runnable that
 * iterates open DeckSessions and issues a synchronous reset() control
 * transfer. The service stops itself once the runnable returns.
 */
public class StreamDeckLifecycleService extends Service {

    private static final String TAG = "StreamDeckLifecycle";

    private static volatile Runnable taskRemovedHandler;

    public static void setTaskRemovedHandler(Runnable handler) {
        taskRemovedHandler = handler;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // The service exists only as a lifecycle hook holder. Nothing to do
        // proactively; we don't want auto-restart after kill.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Runnable r = taskRemovedHandler;
        Log.i(TAG, "onTaskRemoved (handler=" + (r != null) + ")");
        if (r != null) {
            try { r.run(); }
            catch (Throwable t) { Log.w(TAG, "task-removed handler threw", t); }
        }
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }
}
