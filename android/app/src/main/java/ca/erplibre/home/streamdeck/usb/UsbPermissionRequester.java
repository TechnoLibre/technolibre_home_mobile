package ca.erplibre.home.streamdeck.usb;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Log;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Requests USB permission for one device at a time and resolves a future when
 * the system broadcast comes back. Pending requests are de-duplicated by
 * (vendorId, productId, deviceName) so concurrent attach events don't pile up.
 *
 * Per-device PendingIntent slots (requestCode = device.getDeviceId()) keep
 * concurrent multi-deck requests independent — without a unique requestCode
 * the system collapses them into one and the second deck's dialog never
 * surfaces.
 */
public final class UsbPermissionRequester {

    private static final String TAG = "StreamDeckPerm";
    private static final String ACTION = "ca.erplibre.home.streamdeck.USB_PERMISSION";
    private static final long TIMEOUT_SECONDS = 30L;

    private final Context context;
    private final UsbManager usb;
    private final Map<String, CompletableFuture<Boolean>> pending = new HashMap<>();
    private final ScheduledExecutorService timeouts =
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "StreamDeckPerm-timeout");
            t.setDaemon(true);
            return t;
        });
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context ctx, Intent intent) {
            if (!ACTION.equals(intent.getAction())) return;
            UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
            if (dev == null) {
                Log.w(TAG, "permission broadcast with no EXTRA_DEVICE granted=" + granted);
                return;
            }
            String key = keyOf(dev);
            CompletableFuture<Boolean> fut;
            synchronized (pending) { fut = pending.remove(key); }
            Log.i(TAG, "permission broadcast key=" + key + " granted=" + granted
                + " futurePresent=" + (fut != null));
            if (fut != null) fut.complete(granted);
        }
    };

    public UsbPermissionRequester(Context context, UsbManager usb) {
        this.context = context;
        this.usb = usb;
        IntentFilter filter = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }
    }

    public void close() {
        try { context.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) {}
        synchronized (pending) {
            for (CompletableFuture<Boolean> f : pending.values()) f.complete(false);
            pending.clear();
        }
        timeouts.shutdownNow();
    }

    public CompletableFuture<Boolean> request(UsbDevice device) {
        if (usb.hasPermission(device)) {
            Log.i(TAG, "request: already granted for " + keyOf(device));
            return CompletableFuture.completedFuture(true);
        }
        final String key = keyOf(device);
        CompletableFuture<Boolean> fut;
        boolean isFresh;
        synchronized (pending) {
            CompletableFuture<Boolean> existing = pending.get(key);
            if (existing != null && !existing.isDone()) {
                Log.i(TAG, "request: dedup, returning in-flight future for " + key);
                return existing;
            }
            fut = new CompletableFuture<>();
            pending.put(key, fut);
            isFresh = true;
        }
        // Per-device requestCode keeps multi-deck PendingIntents distinct.
        // Without it, two simultaneous permission requests collapse into a
        // single PendingIntent slot and Android never surfaces the second
        // dialog — the future then hangs forever.
        int requestCode = device.getDeviceId();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(
            context,
            requestCode,
            new Intent(ACTION).setPackage(context.getPackageName()),
            flags);
        Log.i(TAG, "request: dispatch usb.requestPermission key=" + key
            + " requestCode=" + requestCode);
        try {
            usb.requestPermission(device, pi);
        } catch (Throwable t) {
            Log.e(TAG, "usb.requestPermission threw for " + key, t);
            synchronized (pending) { pending.remove(key); }
            fut.complete(false);
            return fut;
        }
        // Safety net: if the broadcast never comes back (dialog dismissed
        // by the system, OEM quirk, hub re-enumeration), unstick the UI
        // after TIMEOUT_SECONDS so the user can click the button again.
        if (isFresh) {
            timeouts.schedule(() -> {
                CompletableFuture<Boolean> stuck;
                synchronized (pending) {
                    stuck = pending.get(key);
                    if (stuck != null && !stuck.isDone()) {
                        pending.remove(key);
                    } else {
                        stuck = null;
                    }
                }
                if (stuck != null) {
                    Log.w(TAG, "request: timeout, completing as denied for " + key);
                    stuck.complete(false);
                }
            }, TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
        return fut;
    }

    private static String keyOf(UsbDevice d) {
        return d.getVendorId() + ":" + d.getProductId() + ":" + d.getDeviceName();
    }
}
