package ca.erplibre.home.streamdeck;

import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
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

import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
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

    /** Open sessions by USB device name and by serial. A session leaves it
     *  from its own close(), whoever closed it, so a deck whose reader
     *  failed can be attached again. */
    private final SessionRegistry<DeckSession> registry =
        new SessionRegistry<>(new SessionRegistry.Hooks<DeckSession>() {
            @Override public boolean isOpen(DeckSession s) { return s.isOpen(); }
            @Override public void connected(DeckSession s) {
                // The spec's payload: JS caches the deck from `info`
                // without a getDeckInfo round-trip.
                JSObject ev = new JSObject();
                ev.put("deckId", s.serial());
                ev.put("info", infoOf(s));
                emitter.emit("deckConnected", ev);
            }
            @Override public void disconnected(DeckSession s, String reason) {
                JSObject ev = new JSObject();
                ev.put("deckId", s.serial());
                if (reason != null) ev.put("reason", reason);
                emitter.emit("deckDisconnected", ev);
            }
        });
    /** Last attach error per USB device name — surfaced via listAllUsbDevices
     * so the diagnostic UI can show why a known device is not in listDecks
     * even when the failure event was emitted before any listener attached. */
    private final Map<String, String> lastAttachError = new HashMap<>();

    /** Pending detach close jobs, keyed by USB deviceName. Detach events
     *  are debounced — some Android stacks fire detach immediately
     *  followed by a fresh attach (transient enumeration). Closing the
     *  session synchronously on detach + opening a new one on attach
     *  causes the reader thread to die mid-flight and surfaces as
     *  "buttons work once then stop". */
    private final Map<String, Runnable> pendingCloseJobs = new HashMap<>();
    private static final long DETACH_DEBOUNCE_MS = 250L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** Single shared partial wake lock — held while the keepAwake option
     *  is on and at least one session is open, so the USB bus doesn't
     *  suspend after the first interrupt-IN event. updateWakeLock()
     *  is the only place that takes or drops it. */
    private PowerManager.WakeLock wakeLock;
    /** Both off by default; see DeckPowerOptions. */
    private DeckPowerOptions power;

    /** "Wake the phone on a deck press while the host activity is
     *  paused" — armed by the JS-side Mise en veille checkbox via
     *  setWakeOnKeyPress. Static so the per-session keyPressHook can
     *  read it without holding a reference to the plugin. */
    private static volatile boolean wakeOnKeyPress = false;
    /** True between handleOnPause and handleOnResume — the only window
     *  where the wake-on-press path should actually fire an intent.
     *  Without this gate every press would relaunch MainActivity even
     *  while the user is already looking at the app. */
    private static volatile boolean activityPaused = false;

    private final EventEmitter emitter = (name, data) -> notifyListeners(name, data);

    @Override
    public void load() {
        Context ctx = getContext();
        usb = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        permissions = new UsbPermissionRequester(ctx, usb);
        power = DeckPowerOptions.of(ctx);
        hotplug = new UsbHotplugReceiver(this);
        hotplug.attach(ctx);
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ErpLibre:StreamDeck");
            wakeLock.setReferenceCounted(false);
        } catch (Throwable t) {
            Log.w(TAG, "wake lock init failed: " + t.getMessage());
        }
        // The lifecycle service runs only to receive onTaskRemoved on
        // swipe-from-recents — the Activity lifecycle does not guarantee
        // onDestroy on that path, so handleOnDestroy alone leaves the deck
        // painted with the last tile. The service has no other duties.
        // Arm the wake-on-keypress path: every keyChanged in DeckSession
        // calls this hook, which only does something when the user
        // opted in (wakeOnKeyPress) and the activity is currently
        // paused (locked screen / backgrounded).
        DeckSession.setKeyPressHook(this::onDeckKeyPressed);
        StreamDeckLifecycleService.setTaskRemovedHandler(this::resetAllSessions);
        try {
            ctx.startService(new Intent(ctx, StreamDeckLifecycleService.class));
        } catch (Throwable t) {
            Log.w(TAG, "startService(StreamDeckLifecycleService) failed: " + t.getMessage());
        }
        scanExistingDevices();
    }

    @Override
    protected void handleOnPause() { activityPaused = true; super.handleOnPause(); }

    @Override
    protected void handleOnResume() { activityPaused = false; super.handleOnResume(); }

    @Override
    protected void handleOnDestroy() {
        DeckSession.setKeyPressHook(null);
        if (hotplug != null) hotplug.detach(getContext());
        if (permissions != null) permissions.close();
        resetAllSessions();
        for (DeckSession s : registry.sessions()) s.close("app_destroyed");
        StreamDeckLifecycleService.setTaskRemovedHandler(null);
        if (wakeLock != null) {
            try { if (wakeLock.isHeld()) wakeLock.release(); }
            catch (Throwable ignored) { /* ignore */ }
        }
    }

    /**
     * Best-effort blank-every-deck. Called on both handleOnDestroy and
     * the lifecycle service's onTaskRemoved so a swipe-from-recents (which
     * may skip onDestroy) still clears the LCDs. reset() is a synchronous
     * feature-report write that bypasses the writer queue, so it lands
     * even when image jobs are still pending. Failures are logged and
     * never propagated — at this point we may be racing the OS killing
     * the process and a crash here would surface as a misleading ANR.
     */
    private void resetAllSessions() {
        for (DeckSession s : registry.sessions()) {
            try { s.reset(); }
            catch (Throwable t) {
                Log.w(TAG, "reset failed for " + s.serial() + ": " + t.getMessage());
            }
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

        // Cancel any in-flight detach close — the device just bounced
        // (transient enumeration) and we want to keep the existing
        // session alive instead of churning through a close+reopen.
        Runnable pending;
        synchronized (pendingCloseJobs) { pending = pendingCloseJobs.remove(name); }
        if (pending != null) {
            mainHandler.removeCallbacks(pending);
            Log.i(TAG, "onDeckAttached: cancelled pending close for " + name + " (transient detach)");
        }

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

        // Idempotent: the reservation is held from here until the session
        // is registered or the attempt fails. A second attach meanwhile —
        // hotplug noise, a debounced bounce, or requestPermissionForUsb
        // resolving the same permission future — is refused instead of
        // opening a parallel session that would steal the interface from
        // the first and orphan its threads. An open session is reused.
        if (!registry.reserve(name)) {
            Log.i(TAG, "onDeckAttached: " + name + " already open or opening — skipping");
            return;
        }
        permissions.request(device).whenComplete((granted, err) -> {
            if (err != null || granted == null || !granted) {
                registry.release(name);
                String reason = err != null ? err.getMessage() : "permission_denied";
                recordAttachError(name, reason);
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
                return;
            }
            DeckSession session = new DeckSession(spec, device, emitter, this::onSessionClosed);
            try {
                session.open(usb);
                if (!registry.register(name, session.serial(), session)) {
                    // Detached while opening, or closed itself before
                    // registration: nothing stays registered, and an
                    // open session here would run without an owner.
                    Log.w(TAG, "onDeckAttached: " + name + " left while opening — closing");
                    session.close("usb_lost");
                    return;
                }
                synchronized (lastAttachError) { lastAttachError.remove(name); }
                // Read after registering: setPowerOptions reaches every
                // registered session, so a change in between is not lost.
                session.setHeartbeat(power.heartbeat());
                updateWakeLock();
            } catch (DeckSession.DeckOpenException e) {
                registry.release(name);
                String reason = e.getMessage();
                recordAttachError(name, reason);
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
            } catch (Throwable t) {
                registry.release(name);
                session.close("open_failed");
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
        synchronized (lastAttachError) {
            lastAttachError.put(deviceName, reason);
        }
        Log.w(TAG, "attach failed for " + deviceName + ": " + reason);
    }

    @Override
    public void onDeckDetached(UsbDevice device) {
        final String name = device.getDeviceName();
        // Debounce: ThinkPhone (and a few other Android stacks) emit
        // detach + attach in tight succession after the first interrupt
        // event. Closing the session synchronously here would tear the
        // reader thread down and leave subsequent presses unobserved.
        // Schedule the close, and let onDeckAttached cancel it if the
        // device comes back within DETACH_DEBOUNCE_MS.
        Runnable closeJob = () -> {
            synchronized (pendingCloseJobs) { pendingCloseJobs.remove(name); }
            // An attach still waiting on permission or open() for this
            // device will fail to register and close what it opened.
            registry.release(name);
            DeckSession session = registry.byDevice(name);
            if (session != null) {
                Log.i(TAG, "onDeckDetached: closing session for " + name + " (debounce expired)");
                session.close("usb_lost");
            }
            updateWakeLock();
        };
        synchronized (pendingCloseJobs) {
            Runnable prev = pendingCloseJobs.put(name, closeJob);
            if (prev != null) mainHandler.removeCallbacks(prev);
        }
        Log.i(TAG, "onDeckDetached: scheduled close for " + name + " in " + DETACH_DEBOUNCE_MS + " ms");
        mainHandler.postDelayed(closeJob, DETACH_DEBOUNCE_MS);
    }

    /**
     * CloseListener of every session, on the thread that closed it — the
     * reader thread when the USB pipe failed. Unregistering here, not only
     * on detach, is what lets onDeckAttached and retryAttach open the same
     * device again.
     */
    private void onSessionClosed(DeckSession session, String reason) {
        String name = session.device().getDeviceName();
        if (registry.unregister(name, session, reason)) {
            Log.i(TAG, "session for " + name + " closed (" + reason + ") — unregistered");
        }
        updateWakeLock();
    }

    /** Take or drop the partial wake lock to match the keepAwake option
     *  and the open sessions. Synchronized: sessions close on their own
     *  threads while the option changes on the plugin thread. */
    private synchronized void updateWakeLock() {
        if (wakeLock == null || power == null) return;
        boolean want = power.holdWakeLock(!registry.isEmpty());
        try {
            if (want && !wakeLock.isHeld()) wakeLock.acquire();
            else if (!want && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable t) {
            Log.w(TAG, "wake lock update failed: " + t.getMessage());
        }
    }

    // ─────────────────────────── Plugin methods ──────────────────────────────

    @PluginMethod
    public void listDecks(PluginCall call) {
        JSArray arr = new JSArray();
        for (DeckSession s : registry.sessions()) arr.put(infoOf(s));
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
            inSession = registry.hasSession(d.getDeviceName());
            synchronized (lastAttachError) { lastErr = lastAttachError.get(d.getDeviceName()); }
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
     * Switch the reader thread strategy. "userequest" / "bulk" both
     * use the interrupt-IN endpoint; "polled" uses GET_REPORT on the
     * control endpoint as a last-resort path for kernels that shadow-
     * consume the interrupt path entirely. Takes effect on next
     * session open — caller should follow with restartSessions.
     */
    @PluginMethod
    public void setReaderMode(PluginCall call) {
        String mode = call.getString("mode");
        if (mode == null) { call.reject("missing:mode"); return; }
        DeckSession.setReaderMode(mode);
        JSObject r = new JSObject();
        r.put("mode", DeckSession.getReaderMode());
        call.resolve(r);
    }

    @PluginMethod
    public void getReaderMode(PluginCall call) {
        JSObject r = new JSObject();
        r.put("mode", DeckSession.getReaderMode());
        call.resolve(r);
    }

    // Back-compat with older JS bridges still expecting the boolean form.
    @PluginMethod
    public void setReaderUseBulk(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        DeckSession.setReaderUseBulk(enabled);
        JSObject r = new JSObject();
        r.put("enabled", enabled);
        call.resolve(r);
    }

    @PluginMethod
    public void getReaderUseBulk(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", DeckSession.getReaderUseBulk());
        call.resolve(r);
    }

    /**
     * Close every open session and re-attach. Lets the user apply
     * setReaderUseBulk without unplugging the deck.
     */
    @PluginMethod
    public void restartSessions(PluginCall call) {
        int closed = 0;
        java.util.List<UsbDevice> toReattach = new java.util.ArrayList<>();
        for (DeckSession s : registry.sessions()) {
            toReattach.add(s.device());
            s.close("restart_requested");   // unregisters through onSessionClosed
            closed++;
        }
        for (UsbDevice d : toReattach) {
            if (DeckRegistry.isElgato(d.getVendorId())) onDeckAttached(d);
        }
        JSObject r = new JSObject();
        r.put("restarted", closed);
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
            if (registry.isBusy(d.getDeviceName())) continue;
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

    /** Drop every queued image-write for a deck without disturbing the
     *  reader. Called by the camera streamer right after it stops, so
     *  the writer thread doesn't spend the next ~300 ms draining stale
     *  frames — that bulk-OUT pressure makes the deck firmware miss
     *  Note-key presses long after the user expects the home tile back. */
    @PluginMethod
    public void clearPendingWrites(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        int dropped = s.queue().dropPending();
        JSObject ret = new JSObject();
        ret.put("dropped", dropped);
        call.resolve(ret);
    }

    @PluginMethod
    public void setBrightness(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        int pct = call.getInt("percent", 50);
        try { s.setBrightness(pct); call.resolve(); }
        catch (DeckSession.DeckIoException e) { call.reject(e.getMessage()); }
    }

    /**
     * Arm or disarm the wake-on-keypress path. When armed, every key
     * press while the host activity is paused (phone screen off /
     * MainActivity backgrounded) acquires a screen-bright wake lock
     * and re-launches MainActivity so the user lands back where the
     * deck press would normally take them.
     */
    @PluginMethod
    public void setWakeOnKeyPress(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        wakeOnKeyPress = enabled;
        JSObject r = new JSObject();
        r.put("enabled", enabled);
        call.resolve(r);
    }

    /**
     * The two power options, both false until the user turns them on:
     * showOverLockScreen (read by MainActivity on a deck launch) and
     * keepAwake (partial wake lock and per-session heartbeat).
     */
    @PluginMethod
    public void getPowerOptions(PluginCall call) {
        call.resolve(powerOptionsJson());
    }

    /**
     * Change either option or both; an absent field is left as it is.
     * keepAwake applies at once to the open sessions and the wake lock.
     * Resolves with both values as stored.
     */
    @PluginMethod
    public void setPowerOptions(PluginCall call) {
        Boolean show = call.getBoolean("showOverLockScreen");
        Boolean keep = call.getBoolean("keepAwake");
        if (show != null) power.setShowOverLockScreen(show);
        if (keep != null) {
            power.setKeepAwake(keep);
            for (DeckSession s : registry.sessions()) s.setHeartbeat(power.heartbeat());
            updateWakeLock();
        }
        call.resolve(powerOptionsJson());
    }

    private JSObject powerOptionsJson() {
        JSObject r = new JSObject();
        r.put("showOverLockScreen", power.showOverLockScreen());
        r.put("keepAwake", power.keepAwake());
        return r;
    }

    /**
     * keyPressHook from DeckSession. Fires on every accepted key down
     * (release events are filtered upstream). Cheap fast-path: bail
     * unless both the user opted in and the activity is currently
     * paused — otherwise this runs on every press and we don't want
     * to relaunch the activity while the user is already in it.
     */
    @SuppressWarnings("deprecation")
    private void onDeckKeyPressed() {
        if (!wakeOnKeyPress) return;
        if (!activityPaused) return;
        Context ctx = getContext();
        if (ctx == null) return;
        try {
            // SCREEN_BRIGHT_WAKE_LOCK + ACQUIRE_CAUSES_WAKEUP +
            // ON_AFTER_RELEASE is the smallest API surface that
            // actually wakes the display from off — modern guidance
            // is FLAG_TURN_SCREEN_ON on the activity, but that only
            // works if the activity is *being launched* into the
            // foreground. We need the wake to happen even when the
            // OS is throttling activity launches, so the deprecated
            // wake lock combo is the right tool here.
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                int flags = PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                          | PowerManager.ACQUIRE_CAUSES_WAKEUP
                          | PowerManager.ON_AFTER_RELEASE;
                PowerManager.WakeLock wl = pm.newWakeLock(flags, "ErpLibre:DeckWake");
                wl.acquire(3000L);  // 3 s — plenty for the activity to pull focus
            }
            // Bring MainActivity back to the front so the press lands
            // on a live UI. SINGLE_TOP avoids a duplicate instance,
            // REORDER_TO_FRONT covers the case where the activity is
            // still in the back stack but not on top. EXTRA_DECK_WAKE
            // marks the launch as the deck's: MainActivity shows over the
            // keyguard only for such a launch, and only with the
            // showOverLockScreen option; otherwise the screen lights on
            // the lock screen.
            Intent i = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (i != null) {
                i.putExtra(DeckPowerOptions.EXTRA_DECK_WAKE, true);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                         | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                         | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                ctx.startActivity(i);
            }
        } catch (Throwable t) {
            Log.w(TAG, "wake-on-press failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void setKeyImage(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        Integer key = call.getInt("key");
        String err = KeyImages.checkKey(key, s.spec());
        if (err != null) { call.reject(err); return; }
        byte[] raw = decodeBytes(call); if (raw == null) return;
        err = KeyImages.checkSize(raw, s.spec());
        if (err != null) { call.reject(err); return; }

        s.queue().offerCoalesce(new ImageWriteJob(s, key, raw, call));
        call.setKeepAlive(true);
    }

    /**
     * Streaming-friendly batch: queues N key writes through a single JNI
     * crossing. Each entry is fire-and-forget on the WriterQueue (no
     * per-key resolve), so the call returns the moment everything is
     * decoded and offered. The queue's coalescing keeps backpressure
     * bounded — only the latest job per key actually hits USB. An entry
     * with a bad key, bad base64 or an oversized image counts as dropped.
     */
    @PluginMethod
    public void setKeyImagesBatch(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        JSArray entries = call.getArray("entries");
        if (entries == null) { call.reject("missing:entries"); return; }
        int queued = 0;
        int dropped = 0;
        for (int i = 0; i < entries.length(); i++) {
            try {
                org.json.JSONObject o = entries.getJSONObject(i);
                int key = o.getInt("key");
                String b64 = o.getString("bytes");
                if (KeyImages.checkKey(key, s.spec()) != null) { dropped++; continue; }
                byte[] raw;
                try { raw = Base64.decode(b64, Base64.NO_WRAP); }
                catch (IllegalArgumentException ex) { dropped++; continue; }
                if (KeyImages.checkSize(raw, s.spec()) != null) { dropped++; continue; }
                s.queue().offerCoalesce(new ImageWriteJob(s, key, raw, null));
                queued++;
            } catch (Throwable t) {
                dropped++;
            }
        }
        JSObject r = new JSObject();
        r.put("queued", queued);
        r.put("dropped", dropped);
        call.resolve(r);
    }

    @PluginMethod
    public void clearKey(PluginCall call) {
        DeckSession s = requireSession(call); if (s == null) return;
        Integer key = call.getInt("key");
        String err = KeyImages.checkKey(key, s.spec());
        if (err != null) { call.reject(err); return; }
        // Black at the key's native size, already in the wire format: the
        // deck does not scale what it receives to fill the key.
        byte[] black;
        try { black = s.encoder().blank(s.spec().keyImageW, s.spec().keyImageH); }
        catch (ImageEncoder.ImageEncodeException e) { call.reject(e.getMessage()); return; }
        s.queue().offerCoalesce(ImageWriteJob.preEncoded(s, key, black, call));
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
        DeckSession s = registry.bySerial(id);
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
}
