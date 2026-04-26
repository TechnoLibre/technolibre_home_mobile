package ca.erplibre.home.streamdeck.usb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;

import ca.erplibre.home.streamdeck.DeckRegistry;

/**
 * Receives USB attach / detach broadcasts for Elgato Stream Deck devices.
 * Filters by vendor 0x0fd9 before dispatching so unrelated devices don't trigger anything.
 *
 * Owner is responsible for register/unregister via attach()/detach().
 */
public final class UsbHotplugReceiver extends BroadcastReceiver {

    public interface Listener {
        void onDeckAttached(UsbDevice device);
        void onDeckDetached(UsbDevice device);
    }

    private final Listener listener;

    public UsbHotplugReceiver(Listener listener) { this.listener = listener; }

    public void attach(Context context) {
        IntentFilter f = new IntentFilter();
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(this, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(this, f);
        }
    }

    public void detach(Context context) {
        try { context.unregisterReceiver(this); } catch (IllegalArgumentException ignored) {}
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
        if (dev == null || !DeckRegistry.isElgato(dev.getVendorId())) return;
        if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())) {
            listener.onDeckAttached(dev);
        } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
            listener.onDeckDetached(dev);
        }
    }
}
