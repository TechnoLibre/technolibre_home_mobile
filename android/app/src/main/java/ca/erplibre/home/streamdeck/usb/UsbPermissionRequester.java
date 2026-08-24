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

/**
 * Requests USB permission for one device at a time and resolves a future when
 * the system broadcast comes back. Pending requests are de-duplicated by
 * (vendorId, productId, deviceName) so concurrent attach events don't pile up.
 */
public final class UsbPermissionRequester {

    private static final String TAG = "StreamDeckPerm";
    private static final String ACTION = "ca.erplibre.home.streamdeck.USB_PERMISSION";

    private final Context context;
    private final UsbManager usb;
    private final Map<String, CompletableFuture<Boolean>> pending = new HashMap<>();
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context ctx, Intent intent) {
            if (!ACTION.equals(intent.getAction())) return;
            UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
            if (dev == null) return;
            String key = keyOf(dev);
            CompletableFuture<Boolean> fut;
            synchronized (pending) { fut = pending.remove(key); }
            if (fut != null) fut.complete(granted);
            else Log.w(TAG, "permission broadcast for unknown key " + key + " granted=" + granted);
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
    }

    public CompletableFuture<Boolean> request(UsbDevice device) {
        if (usb.hasPermission(device)) {
            return CompletableFuture.completedFuture(true);
        }
        String key = keyOf(device);
        CompletableFuture<Boolean> fut;
        synchronized (pending) {
            CompletableFuture<Boolean> existing = pending.get(key);
            if (existing != null) return existing;
            fut = new CompletableFuture<>();
            pending.put(key, fut);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(context, 0, new Intent(ACTION).setPackage(context.getPackageName()), flags);
        usb.requestPermission(device, pi);
        return fut;
    }

    private static String keyOf(UsbDevice d) {
        return d.getVendorId() + ":" + d.getProductId() + ":" + d.getDeviceName();
    }
}
