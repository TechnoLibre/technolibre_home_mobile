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
        DeckSpec spec = DeckRegistry.lookup(device.getProductId());
        if (spec == null) {
            Log.w(TAG, "unknown Elgato product 0x" + Integer.toHexString(device.getProductId()));
            return;
        }
        permissions.request(device).whenComplete((granted, err) -> {
            if (err != null || granted == null || !granted) {
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", err != null ? err.getMessage() : "permission_denied");
                emitter.emit("permissionDenied", ev);
                return;
            }
            DeckSession session = new DeckSession(spec, device, emitter);
            try {
                session.open(usb);
                synchronized (sessionsByDevice) {
                    sessionsByDevice.put(device.getDeviceName(), session);
                    if (!session.serial().isEmpty()) {
                        sessionsBySerial.put(session.serial(), session);
                    }
                }
            } catch (DeckSession.DeckOpenException e) {
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", e.getMessage());
                emitter.emit("permissionDenied", ev);
            }
        });
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
        // Neo info bars use a different command byte than Plus LCD. Wiring is
        // deferred to a separate plan once the protocol is cross-checked
        // against python-elgato-streamdeck StreamDeckNeo.py — see "Out of scope"
        // in the spec.
        call.reject("unsupported:neo_infobar_pending_protocol_verification");
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
