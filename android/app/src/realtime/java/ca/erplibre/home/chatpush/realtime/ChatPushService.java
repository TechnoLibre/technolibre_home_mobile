package ca.erplibre.home.chatpush.realtime;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import ca.erplibre.home.chatpush.ChatPushRuntime;
import ca.erplibre.home.chatpush.PermanentNotice;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * The permanent service of chat push levels 1 and 2: it keeps the process
 * in the foreground so the ntfy streams stay open with the app closed, and
 * holds the shared permanent notification (PermanentNotice, holder CHAT)
 * whose line says the listening state.
 *
 * Type specialUse, not dataSync: Android 15 caps dataSync at six hours per
 * twenty-four, and the connection must stay open.
 *
 * Each start holds the notice first, before the runtime is built, so the
 * foreground deadline is met; a start Android refuses (app in the
 * background) stops the service without a sticky restart, and health then
 * reports it dead. The level is re-read at each start, when wifi comes or
 * goes (level 2 listens in realtime on wifi or charger only) and when the
 * charger is plugged or unplugged; a returning network only reopens the
 * waiting streams. A level that no longer wants the service stops it, with
 * stopSelfResult on the latest start id so a newer start is never lost.
 *
 * No wakelock is held while waiting: the device sleeps between messages,
 * and a permanent wakelock is what vendor app killers act on. The engine
 * takes a short one around each streamed message (ChatPushRuntime). This
 * class is in its own source set, left out by -PnoChatRealtime; the rest
 * of the app reaches it by class name only.
 */
public class ChatPushService extends Service {

    private static final String TAG = "ChatPushService";

    private ChatPushRuntime runtime;
    private ExecutorService worker;
    private ConnectivityManager.NetworkCallback networkCallback;
    private BroadcastReceiver powerReceiver;
    private boolean started;
    private volatile int lastStartId;
    /** Whether the default network was wifi or ethernet at the last callback; null before the first. */
    private Boolean onWifi;

    @Override
    public void onCreate() {
        super.onCreate();
        worker = Executors.newSingleThreadExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        // the first start holds with an empty line: the runtime is built after the deadline is met
        String line = runtime == null ? "" : runtime.permanentLine();
        if (!PermanentNotice.hold(this, PermanentNotice.Holder.CHAT, line)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (runtime == null) {
            runtime = ChatPushRuntime.get(this);
            PermanentNotice.update(this, PermanentNotice.Holder.CHAT, runtime.permanentLine());
        }
        if (!started) {
            started = true;
            runtime.serviceStarted(next -> PermanentNotice.update(this, PermanentNotice.Holder.CHAT, next));
            registerNetworkCallback();
            registerPowerReceiver();
        }
        reapply();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (networkCallback != null) {
            try {
                ConnectivityManager cm = getSystemService(ConnectivityManager.class);
                if (cm != null) cm.unregisterNetworkCallback(networkCallback);
            } catch (IllegalArgumentException ignored) {
                // already unregistered
            }
            networkCallback = null;
        }
        if (powerReceiver != null) {
            try {
                unregisterReceiver(powerReceiver);
            } catch (IllegalArgumentException ignored) {
                // already unregistered
            }
            powerReceiver = null;
        }
        if (started) runtime.serviceStopped();
        PermanentNotice.release(this, PermanentNotice.Holder.CHAT);
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Applies the level on the worker (leaving realtime polls, on the network); stops when it is not wanted. */
    private void reapply() {
        submit(() -> {
            if (!runtime.applyRealtime()) stopSelfResult(lastStartId);
        });
    }

    private void submit(Runnable r) {
        try {
            worker.execute(() -> {
                try {
                    r.run();
                } catch (RuntimeException e) {
                    // the class only: a message may carry a URL
                    Log.w(TAG, "policy not applied: " + e.getClass().getSimpleName());
                }
            });
        } catch (RejectedExecutionException e) {
            // the service is being destroyed
        }
    }

    private void registerNetworkCallback() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                submit(runtime::onNetworkAvailable);
            }

            /**
             * Called on every network change and for signal changes too: only
             * a wifi change re-reads the level. The first call records the
             * state onStartCommand already applied.
             */
            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                boolean wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
                Boolean was = onWifi;
                onWifi = wifi;
                if (was != null && was != wifi) reapply();
            }
        };
        try {
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException e) {
            Log.w(TAG, "network callback unavailable: " + e.getClass().getSimpleName());
            networkCallback = null;
        }
    }

    private void registerPowerReceiver() {
        powerReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                reapply();
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        // system broadcasts reach a receiver that is not exported
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(powerReceiver, filter);
        }
    }
}
