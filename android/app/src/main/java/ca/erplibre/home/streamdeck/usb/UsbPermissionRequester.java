package ca.erplibre.home.streamdeck.usb;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * USB permission for Stream Decks, one request per device, keyed by
 * (vendorId, productId, deviceName); see PermissionWaits for the rules.
 * request() shows the system permission dialog; awaitGrant() shows none
 * and waits for a grant from another path, as the confirmation Android
 * raises for a device the manifest's USB_DEVICE_ATTACHED filter matches.
 *
 * A request completes on the dialog's broadcast, or as soon as UsbManager
 * reports the permission held, whichever path granted it: a poll checks
 * every POLL_MS while a request is pending, and recheck() lets the owner
 * check at once on the attach intent and on activity resume. A request
 * nothing answers fails after TIMEOUT_MS with PermissionTimeoutException.
 *
 * Per-device PendingIntent slots (requestCode = device.getDeviceId()) keep
 * concurrent multi-deck requests independent: without a unique requestCode
 * the system collapses them into one and the second deck's dialog never
 * surfaces.
 */
public final class UsbPermissionRequester {

    private static final String TAG = "StreamDeckPerm";
    private static final String ACTION = "ca.erplibre.home.streamdeck.USB_PERMISSION";
    static final long TIMEOUT_MS = 30_000L;
    static final long POLL_MS = 500L;

    private final Context context;
    private final UsbManager usb;
    private final PermissionWaits<UsbDevice> waits;
    private final ScheduledExecutorService timer =
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "StreamDeckPerm-poll");
            t.setDaemon(true);
            return t;
        });
    /** The poll, running while a request is pending; guarded by this. */
    private ScheduledFuture<?> poll;

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
            boolean matched = waits.answered(key, granted);
            Log.i(TAG, "permission broadcast key=" + key + " granted=" + granted
                + " futurePresent=" + matched);
        }
    };

    public UsbPermissionRequester(Context context, UsbManager usb) {
        this.context = context;
        this.usb = usb;
        this.waits = new PermissionWaits<>(this::hasPermission,
            SystemClock::elapsedRealtime, TIMEOUT_MS);
        IntentFilter filter = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }
    }

    public void close() {
        try { context.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) {}
        waits.cancelAll();
        timer.shutdownNow();
    }

    /** The permission of {@code device}, through the system dialog unless
     *  it is held already or a dialog for it is already up. */
    public CompletableFuture<Boolean> request(UsbDevice device) {
        final String key = keyOf(device);
        PermissionWaits.Ticket t = waits.ask(key, device);
        if (t.future.isDone()) {
            Log.i(TAG, "request: already granted for " + key);
            return t.future;
        }
        if (!t.showDialog) {
            Log.i(TAG, "request: dedup, returning in-flight future for " + key);
            return t.future;
        }
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
        } catch (Throwable e) {
            Log.e(TAG, "usb.requestPermission threw for " + key, e);
            waits.failed(key);
            return t.future;
        }
        startPolling();
        return t.future;
    }

    /** The permission of {@code device} without a dialog: completes true
     *  once another path grants it, fails MISSING after TIMEOUT_MS. */
    public CompletableFuture<Boolean> awaitGrant(UsbDevice device) {
        String key = keyOf(device);
        CompletableFuture<Boolean> f = waits.await(key, device);
        if (!f.isDone()) {
            Log.i(TAG, "await: no dialog, waiting for a grant of " + key);
            startPolling();
        }
        return f;
    }

    /** Completes every pending request whose device now holds the
     *  permission, on the calling thread; returns how many. */
    public int recheck() {
        int n = waits.recheck();
        if (n > 0) Log.i(TAG, "recheck: " + n + " request(s) granted by another path");
        return n;
    }

    /** The system's confirmation is off the screen for every wait without
     *  a dialog started before {@code since} (SystemClock.elapsedRealtime):
     *  those still without the permission fail MISSING now instead of
     *  after TIMEOUT_MS. Returns how many failed. */
    public int confirmGone(long since) {
        int n = waits.confirmGone(since);
        if (n > 0) Log.i(TAG, "confirmGone: " + n + " wait(s) ended without a grant");
        return n;
    }

    /** {@code device} was unplugged: a request still waiting on it ends
     *  with DeviceDetachedException instead of expiring later. */
    public void forget(UsbDevice device) {
        String key = keyOf(device);
        if (waits.forget(key)) Log.i(TAG, "forget: " + key + " detached while waiting");
    }

    private void tick() {
        recheck();
        if (waits.expire() > 0) Log.w(TAG, "request: timeout");
        synchronized (this) {
            if (waits.isEmpty() && poll != null) {
                poll.cancel(false);
                poll = null;
            }
        }
    }

    private synchronized void startPolling() {
        if (poll != null) return;
        try {
            poll = timer.scheduleWithFixedDelay(this::tick, POLL_MS, POLL_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            waits.cancelAll();  // closed: nothing will answer
        }
    }

    private boolean hasPermission(UsbDevice d) {
        try { return usb.hasPermission(d); }
        catch (RuntimeException e) { return false; }
    }

    private static String keyOf(UsbDevice d) {
        return d.getVendorId() + ":" + d.getProductId() + ":" + d.getDeviceName();
    }
}
