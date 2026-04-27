package ca.erplibre.home.streamdeck;

import android.util.Log;

/**
 * JNI shim to libusb-style USBDEVFS ioctls. Used by the Stream Deck reader
 * fallback when Java's UsbDeviceConnection.claimInterface(force=true) is
 * not enough to win the interrupt-IN endpoint from a kernel HID driver
 * that's quietly consuming our reads (Lenovo ThinkPhone, Pixel 6, etc).
 *
 * The native side calls USBDEVFS_DISCONNECT to detach the in-kernel
 * driver before claiming, then USBDEVFS_BULK for the actual reads. See
 * cpp/native_usb.cpp for the implementation.
 */
public final class NativeUsb {

    private static final String TAG = "NativeUsb";
    private static boolean loaded = false;
    private static String  loadError = "";

    static {
        try {
            System.loadLibrary("native_usb");
            loaded = true;
        } catch (Throwable t) {
            loaded = false;
            loadError = t.getClass().getSimpleName() + ":" + t.getMessage();
            Log.w(TAG, "native_usb library not loaded — native reader unavailable: " + loadError);
        }
    }

    public static boolean isLoaded() { return loaded; }
    public static String  loadError() { return loadError; }

    /** Detach in-kernel driver from interface. 0 = ok or no driver. <0 = -errno. */
    public static native int nativeDisconnectKernel(int fd, int interfaceNum);
    /** Claim the interface via USBDEVFS_CLAIMINTERFACE. 0 = ok, <0 = -errno. */
    public static native int nativeClaimInterface(int fd, int interfaceNum);
    /** Release the interface. */
    public static native int nativeReleaseInterface(int fd, int interfaceNum);
    /** Bulk read (kernel routes interrupt endpoints same way). Returns bytes
     *  read or -errno. -110 (ETIMEDOUT) means timeout, retry. */
    public static native int nativeBulkRead(int fd, int endpoint, byte[] buf, int timeoutMs);

    private NativeUsb() {}
}
