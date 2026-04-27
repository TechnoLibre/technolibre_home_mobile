package ca.erplibre.home.streamdeck;

import android.content.Context;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;

import ca.erplibre.home.streamdeck.events.EventEmitter;
import ca.erplibre.home.streamdeck.usb.UsbHotplugReceiver;
import ca.erplibre.home.streamdeck.usb.UsbPermissionRequester;

/**
 * Capacitor plugin entry. Maintains one DeckSession per connected Stream Deck,
 * keyed by USB device name internally and exposed by serial number to JS.
 */
@CapacitorPlugin(name = "StreamDeckPlugin")
public class StreamDeckPlugin extends Plugin implements UsbHotplugReceiver.Listener {

    private static final String TAG = "StreamDeckPlugin";

    private UsbManager usb;
    private UsbHotplugReceiver hotplug;
    private UsbPermissionRequester permissions;

    /** Map keyed by USB device name (stable while plugged in). */
    private final Map<String, DeckSession> sessionsByDevice = new HashMap<>();
    /** Map keyed by serial number. Filled once the device is opened. */
    private final Map<String, DeckSession> sessionsBySerial = new HashMap<>();
    /** Last attach error per USB device name — surfaced via listAllUsbDevices
     * so the diagnostic UI can show why a known device is not in listDecks
     * even when the failure event was emitted before any listener attached. */
    private final Map<String, String> lastAttachError = new HashMap<>();

    private final EventEmitter emitter = (name, data) -> notifyListeners(name, data);

    @Override
    public void load() {
        Context ctx = getContext();
        usb = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        permissions = new UsbPermissionRequester(ctx, usb);
        hotplug = new UsbHotplugReceiver(this);
        hotplug.attach(ctx);
        scanExistingDevices();
    }

    @Override
    protected void handleOnDestroy() {
        if (hotplug != null) hotplug.detach(getContext());
        if (permissions != null) permissions.close();
        synchronized (sessionsByDevice) {
            for (DeckSession s : sessionsByDevice.values()) s.close("app_destroyed");
            sessionsByDevice.clear();
            sessionsBySerial.clear();
        }
    }

    private void scanExistingDevices() {
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (!DeckRegistry.isElgato(d.getVendorId())) continue;
            onDeckAttached(d);
        }
    }

    @Override
    public void onDeckAttached(UsbDevice device) {
        final String name = device.getDeviceName();
        DeckSpec spec = DeckRegistry.lookup(device.getProductId());
        if (spec == null) {
            Log.w(TAG, "unknown Elgato product 0x" + Integer.toHexString(device.getProductId()));
            String reason =
                "unknown_product:0x" + Integer.toHexString(device.getProductId())
                + " (manufacturer=" + (device.getManufacturerName() != null ? device.getManufacturerName() : "?")
                + ", product=" + (device.getProductName() != null ? device.getProductName() : "?")
                + ")";
            recordAttachError(name, reason);
            JSObject ev = new JSObject();
            ev.put("deckId", "");
            ev.put("reason", reason);
            emitter.emit("permissionDenied", ev);
            return;
        }
        permissions.request(device).whenComplete((granted, err) -> {
            if (err != null || granted == null || !granted) {
                String reason = err != null ? err.getMessage() : "permission_denied";
                recordAttachError(name, reason);
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
                return;
            }
            DeckSession session = new DeckSession(spec, device, emitter);
            try {
                session.open(usb);
                synchronized (sessionsByDevice) {
                    sessionsByDevice.put(name, session);
                    if (!session.serial().isEmpty()) {
                        sessionsBySerial.put(session.serial(), session);
                    }
                    lastAttachError.remove(name);
                }
            } catch (DeckSession.DeckOpenException e) {
                String reason = e.getMessage();
                recordAttachError(name, reason);
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
            } catch (Throwable t) {
                String reason = "open_unexpected:" + t.getClass().getSimpleName()
                    + ":" + t.getMessage();
                recordAttachError(name, reason);
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
            }
        });
    }

    private void recordAttachError(String deviceName, String reason) {
        synchronized (sessionsByDevice) {
            lastAttachError.put(deviceName, reason);
        }
        Log.w(TAG, "attach failed for " + deviceName + ": " + reason);
    }

    @Override
    public void onDeckDetached(UsbDevice device) {
        DeckSession session;
        synchronized (sessionsByDevice) {
            session = sessionsByDevice.remove(device.getDeviceName());
            if (session != null) sessionsBySerial.remove(session.serial());
        }
        if (session != null) session.close("usb_lost");
    }

    // ─────────────────────────── Plugin methods ──────────────────────────────

    @PluginMethod
    public void listDecks(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (sessionsByDevice) {
            for (DeckSession s : sessionsByDevice.values()) {
                arr.put(infoOf(s));
            }
        }
        JSObject r = new JSObject();
        r.put("decks", arr);
        call.resolve(r);
    }

    /**
     * Diagnostic: returns every USB device the phone currently sees,
     * including non-Elgato ones. Lets the diagnostic UI distinguish:
     *   - empty list             → USB OTG not working at all (cable / phone)
     *   - Elgato vendor present  → registered, plugin will pick it up
     *   - unknown vendor/product → device works, but our registry needs the PID
     */
    @PluginMethod
    public void listAllUsbDevices(PluginCall call) {
        JSArray arr = new JSArray();
        Map<String, UsbDevice> all = usb.getDeviceList();
        for (UsbDevice d : all.values()) {
            JSObject o = new JSObject();
            o.put("deviceName", d.getDeviceName());
            o.put("vendorId", d.getVendorId());
            o.put("productId", d.getProductId());
            o.put("vendorIdHex", "0x" + Integer.toHexString(d.getVendorId()));
            o.put("productIdHex", "0x" + Integer.toHexString(d.getProductId()));
            o.put("productName", d.getProductName() != null ? d.getProductName() : "");
            o.put("manufacturerName",
                d.getManufacturerName() != null ? d.getManufacturerName() : "");
            o.put("serial",
                tryGetSerial(d));
            o.put("isElgato", DeckRegistry.isElgato(d.getVendorId()));
            o.put("knownStreamDeck", DeckRegistry.lookup(d.getProductId()) != null
                && DeckRegistry.isElgato(d.getVendorId()));
            o.put("hasPermission", usb.hasPermission(d));
            // True if the plugin currently has an open DeckSession for this
            // USB device path — i.e. the deck would also appear in listDecks.
            boolean inSession;
            String lastErr;
            synchronized (sessionsByDevice) {
                inSession = sessionsByDevice.containsKey(d.getDeviceName());
                lastErr = lastAttachError.get(d.getDeviceName());
            }
            o.put("inSession", inSession);
            o.put("lastAttachError", lastErr != null ? lastErr : "");
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("devices", arr);
        call.resolve(r);
    }

    /**
     * Toggle the per-session reader-thread raw input dump. When on, every
     * successful interrupt-IN transfer emits a `rawInputReport` event with
     * the first 32 bytes hex — used by the diagnostic UI to verify the
     * deck is actually sending data when buttons are pressed.
     */
    @PluginMethod
    public void setDebugLogging(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        DeckSession.setDebugLogging(enabled);
        JSObject r = new JSObject();
        r.put("enabled", enabled);
        call.resolve(r);
    }

    /**
     * Walk every USB device and re-run onDeckAttached for known Elgato
     * Stream Decks that already have permission but aren't open. Useful
     * when the diagnostic UI subscribes after the boot-time attach
     * already failed silently.
     */
    @PluginMethod
    public void retryAttach(PluginCall call) {
        int retried = 0;
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (!DeckRegistry.isElgato(d.getVendorId())) continue;
            if (DeckRegistry.lookup(d.getProductId()) == null) continue;
            boolean already;
            synchronized (sessionsByDevice) {
                already = sessionsByDevice.containsKey(d.getDeviceName());
            }
            if (already) continue;
            if (!usb.hasPermission(d)) continue;
            onDeckAttached(d);
            retried++;
        }
        JSObject r = new JSObject();
        r.put("retried", retried);
        call.resolve(r);
    }

    private String tryGetSerial(UsbDevice d) {
        try {
            // getSerialNumber requires permission on Android 10+; may return null
            String s = d.getSerialNumber();
            return s != null ? s : "";
        } catch (SecurityException e) {
            return "(no permission)";
        } catch (Exception e) {
            return "";
        }
    }

    @PluginMethod
    public void getDeckInfo(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        call.resolve(infoOf(s));
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        JSObject r = new JSObject();
        r.put("granted", true);
        call.resolve(r);
    }

    /**
     * Ask the OS for permission on a USB device that hasn't been opened
     * yet (so it's not in sessions/listDecks). Used by the diagnostic UI
     * when an Elgato device shows up under listAllUsbDevices but
     * permission was denied or never asked.
     */
    @PluginMethod
    public void requestPermissionForUsb(PluginCall call) {
        String deviceName = call.getString("deviceName");
        if (deviceName == null) { call.reject("missing:deviceName"); return; }
        UsbDevice dev = usb.getDeviceList().get(deviceName);
        if (dev == null) { call.reject("no_such_device:" + deviceName); return; }
        permissions.request(dev).whenComplete((granted, err) -> {
            JSObject r = new JSObject();
            r.put("granted", granted != null && granted);
            if (err != null) r.put("error", err.getMessage());
            call.resolve(r);
            // If granted, kick off the same flow the hotplug receiver uses
            // so the deck enters listDecks.
            if (granted != null && granted && DeckRegistry.isElgato(dev.getVendorId())) {
                onDeckAttached(dev);
            }
        });
    }

    @PluginMethod
    public void reset(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        try { s.reset(); call.resolve(); }
        catch (DeckSession.DeckIoException e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void setBrightness(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        int pct = call.getInt("percent", 50);
        try { s.setBrightness(pct); call.resolve(); }
        catch (DeckSession.DeckIoException e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void setKeyImage(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        Integer key = call.getInt("key");
        if (key == null || key < 0 || key >= s.spec().keyCount) {
            call.reject("invalid_key:" + key); return;
        }
        String b64 = call.getString("bytes");
        if (b64 == null) { call.reject("missing:bytes"); return; }
        byte[] raw;
        try { raw = Base64.decode(b64, Base64.NO_WRAP); }
        catch (IllegalArgumentException e) { call.reject("bad_base64"); return; }

        s.queue().offerCoalesce(new ImageWriteJob(s, key, raw, call));
        call.setKeepAlive(true);
    }

    @PluginMethod
    public void clearKey(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        Integer key = call.getInt("key");
        if (key == null) { call.reject("missing:key"); return; }
        byte[] black;
        if (s.spec().keyImageFormat == DeckSpec.ImageFormat.JPEG) {
            black = MINIMAL_BLACK_JPEG;
        } else {
            black = MINIMAL_BLACK_PNG;
        }
        s.queue().offerCoalesce(new ImageWriteJob(s, key, black, call));
        call.setKeepAlive(true);
    }

    @PluginMethod
    public void clearAllKeys(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        try { s.reset(); call.resolve(); }
        catch (DeckSession.DeckIoException e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void setLcdImage(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        if (s.spec().lcdW == 0) { call.reject("unsupported:no_lcd"); return; }
        byte[] raw = decodeBytes(call); if (raw == null) return;
        s.queue().offerCoalesce(new LcdWriteJob(
            s, 0, 0, s.spec().lcdW, s.spec().lcdH, raw, call, "lcd"));
        call.setKeepAlive(true);
    }

    @PluginMethod
    public void setLcdRegion(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        if (s.spec().lcdW == 0) { call.reject("unsupported:no_lcd"); return; }
        Integer x = call.getInt("x"); Integer y = call.getInt("y");
        Integer w = call.getInt("w"); Integer h = call.getInt("h");
        if (x == null || y == null || w == null || h == null) {
            call.reject("missing:x_y_w_h"); return;
        }
        byte[] raw = decodeBytes(call); if (raw == null) return;
        String slot = "lcd:" + x + "," + y + "," + w + "," + h;
        s.queue().offerCoalesce(new LcdWriteJob(s, x, y, w, h, raw, call, slot));
        call.setKeepAlive(true);
    }

    @PluginMethod
    public void setInfoBar(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        if (s.spec().infoBarCount == 0) { call.reject("unsupported:no_infobar"); return; }
        Integer index = call.getInt("index");
        if (index == null) { call.reject("missing:index"); return; }
        if (index < 0 || index >= s.spec().infoBarCount) {
            call.reject("invalid_index:" + index); return;
        }
        byte[] raw = decodeBytes(call); if (raw == null) return;
        s.queue().offerCoalesce(new NeoInfoBarWriteJob(s, index, raw, call));
        call.setKeepAlive(true);
    }

    private byte[] decodeBytes(PluginCall call) {
        String b64 = call.getString("bytes");
        if (b64 == null) { call.reject("missing:bytes"); return null; }
        try { return Base64.decode(b64, Base64.NO_WRAP); }
        catch (IllegalArgumentException e) { call.reject("bad_base64"); return null; }
    }

    // ──────────────────────────────── Helpers ────────────────────────────────

    private DeckSession requireSession(PluginCall call) {
        String id = call.getString("deckId");
        if (id == null) { call.reject("missing:deckId"); return null; }
        DeckSession s;
        synchronized (sessionsByDevice) { s = sessionsBySerial.get(id); }
        if (s == null) { call.reject("no_such_deck:" + id); return null; }
        return s;
    }

    private static JSObject infoOf(DeckSession s) {
        DeckSpec spec = s.spec();
        JSObject o = new JSObject();
        o.put("deckId", s.serial());
        o.put("model", spec.model);
        o.put("productId", spec.productId);
        o.put("rows", spec.rows);
        o.put("cols", spec.cols);
        o.put("keyCount", spec.keyCount);
        JSObject keyImg = new JSObject();
        keyImg.put("w", spec.keyImageW);
        keyImg.put("h", spec.keyImageH);
        keyImg.put("format", spec.keyImageFormat == DeckSpec.ImageFormat.JPEG ? "jpeg"
                          : spec.keyImageFormat == DeckSpec.ImageFormat.BMP_BGR_ROT180 ? "bmp_bgr_rot180"
                          : "bmp_bgr_rot270");
        keyImg.put("rotation", spec.keyImageRotation);
        o.put("keyImage", keyImg);
        o.put("dialCount", spec.dialCount);
        if (spec.lcdW > 0) {
            JSObject lcd = new JSObject();
            lcd.put("w", spec.lcdW); lcd.put("h", spec.lcdH);
            o.put("lcd", lcd);
        }
        if (spec.infoBarCount > 0) {
            JSObject ib = new JSObject();
            ib.put("w", spec.infoBarW); ib.put("h", spec.infoBarH); ib.put("count", spec.infoBarCount);
            o.put("infoBars", ib);
        }
        o.put("touchPoints", spec.touchPoints);
        o.put("firmwareVersion", s.firmware());
        JSArray caps = new JSArray();
        for (String c : spec.capabilities) caps.put(c);
        o.put("capabilities", caps);
        return o;
    }

    /** Tiny black JPEG placeholder for clearKey on JPEG models. */
    private static final byte[] MINIMAL_BLACK_JPEG = Base64.decode(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
        + "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9sAQwEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
        + "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAA"
        + "AAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEA"
        + "AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/AAH/2Q==", Base64.NO_WRAP);

    /** 1×1 black PNG placeholder for clearKey on BMP models. */
    private static final byte[] MINIMAL_BLACK_PNG = Base64.decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        Base64.NO_WRAP);
}
