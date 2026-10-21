package ca.erplibre.home.streamdeck.usb;

/**
 * Completes a permission future whose device was unplugged before any
 * answer: the request has nothing left to open, and a later deadline must
 * not report on a device that is gone. The message is the reason a joined
 * requestPermission call reports.
 */
public final class DeviceDetachedException extends Exception {

    public static final String REASON = "device_detached";

    public DeviceDetachedException() { super(REASON); }
}
