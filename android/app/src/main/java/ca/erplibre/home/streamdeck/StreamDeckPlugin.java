package ca.erplibre.home.streamdeck;

import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.ViewTreeObserver;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
import ca.erplibre.home.streamdeck.events.EventEmitter;
import ca.erplibre.home.streamdeck.usb.DeviceDetachedException;
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
                // Under the registry monitor, so it precedes the policy's
                // closed() for this session, which runs after unregister.
                reattach.registered(s.device().getDeviceName());
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
    /** Reason of the last session close per USB device name, for
     *  getSessionHealth; guarded by itself. */
    private final Map<String, String> lastCloseReason = new HashMap<>();

    /** Pending detach close jobs, keyed by USB deviceName. Detach events
     *  are debounced — some Android stacks fire detach immediately
     *  followed by a fresh attach (transient enumeration). Closing the
     *  session synchronously on detach + opening a new one on attach
     *  causes the reader thread to die mid-flight and surfaces as
     *  "buttons work once then stop". */
    private final Map<String, Runnable> pendingCloseJobs = new HashMap<>();
    private static final long DETACH_DEBOUNCE_MS = 250L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** Reopens a deck whose session closed itself; see ReattachPolicy. */
    private final ReattachPolicy reattach = new ReattachPolicy(SystemClock::elapsedRealtime);
    /** Decks a restartSessions reopens once their close outlasts its wait. */
    private final RestartReopen restartReopen = new RestartReopen();
    /** Runs the retries; created in load(), shut down by stopReattach(). */
    private volatile ScheduledExecutorService reattachTimer;
    /** The retry waiting on reattachTimer, by USB device name. */
    private final ReattachTimers reattachTimers = new ReattachTimers((task, delayMs) -> {
        ScheduledExecutorService timer = this.reattachTimer;
        if (timer == null) return null;
        try {
            ScheduledFuture<?> f = timer.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> f.cancel(false);
        } catch (RejectedExecutionException e) {
            return null;  // shut down: the plugin is going away
        }
    });

    /** Single shared partial wake lock — held while the keepAwake option
     *  is on and at least one session is open, so the USB bus doesn't
     *  suspend after the first interrupt-IN event. updateWakeLock()
     *  is the only place that takes or drops it. */
    private PowerManager.WakeLock wakeLock;
    /** Both off by default; see DeckPowerOptions. */
    private DeckPowerOptions power;

    /** "Wake the phone on a deck press while the host activity is
     *  paused" — armed by the JS-side Mise en veille checkbox via
     *  setWakeOnKeyPress; it lights the screen only with showOverLockScreen
     *  on (see DeckPowerOptions.bringAppForwardOnKeyPress and
     *  wakeScreenOnKeyPress). Static so the per-session
     *  keyPressHook can read it without holding a reference to the plugin. */
    private static volatile boolean wakeOnKeyPress = false;
    /** True between handleOnPause and handleOnResume — the only window
     *  where the wake-on-press path should actually fire an intent.
     *  Without this gate every press would relaunch MainActivity even
     *  while the user is already looking at the app. */
    private static volatile boolean activityPaused = false;

    /** How long the app has held the screen, resumed and focused; fed on
     *  the main thread by handleOnResume, handleOnPause and focusWatch. */
    private final FocusSpan focusSpan = new FocusSpan();
    /** Ends the hotplug waits whose system confirmation is gone. */
    private final Runnable confirmCheck = this::endWaitsOfGoneConfirm;
    /** Window focus changes of the activity, into focusSpan; registered
     *  in load(). */
    private final ViewTreeObserver.OnWindowFocusChangeListener focusWatch =
        hasFocus -> onFocusSpan(focusSpan.focused(hasFocus, SystemClock.elapsedRealtime()));

    /** keyChanged goes through here: held while no JS key handler has
     *  said it listens (keyListenerReady), delivered once one has. A
     *  launch by USB attach lets the reader see a press before the page
     *  subscribes. Closed again by a page load (removeAllListeners). */
    private final KeyEventGate<JSObject> keyGate = new KeyEventGate<>(
        ev -> notifyListeners("keyChanged", ev),
        KeyEventGate.MAX_HELD, KeyEventGate.MAX_AGE_MS);

    private final EventEmitter emitter = (name, data) -> {
        if ("keyChanged".equals(name)) {
            keyGate.submit(data, SystemClock.elapsedRealtime());
        } else {
            notifyListeners(name, data);
        }
    };

    /** The bridge calls this on every page load, before the page's
     *  scripts run: key events wait for the new page's keyListenerReady. */
    @Override
    public void removeAllListeners() {
        keyGate.close();
        super.removeAllListeners();
    }

    /** The JS key handler is subscribed to keyChanged: deliver the key
     *  events held since launch or the last page load, at most
     *  KeyEventGate.MAX_HELD and none older than MAX_AGE_MS, then every
     *  later one directly. Resolves {delivered, dropped}. */
    @PluginMethod
    public void keyListenerReady(PluginCall call) {
        KeyEventGate.Release r = keyGate.open(SystemClock.elapsedRealtime());
        if (r.delivered > 0 || r.dropped > 0) {
            Log.i(TAG, "keyChanged held before the page listened: delivered "
                + r.delivered + ", dropped " + r.dropped);
        }
        JSObject ret = new JSObject();
        ret.put("delivered", r.delivered);
        ret.put("dropped", r.dropped);
        call.resolve(ret);
    }

    @Override
    public void load() {
        Context ctx = getContext();
        usb = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        permissions = new UsbPermissionRequester(ctx, usb);
        power = DeckPowerOptions.of(ctx);
        reattachTimer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "deck-reattach");
            t.setDaemon(true);
            return t;
        });
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
        // opted in (wakeOnKeyPress), the activity is currently paused
        // (locked screen / backgrounded), and the screen is lit already
        // or showOverLockScreen lets the press light it. The hook runs on
        // the main thread: PowerManager and startActivity are binder calls,
        // kept off the USB reader's path for each key report.
        DeckSession.setKeyPressHook(() -> mainHandler.post(this::onDeckKeyPressed));
        StreamDeckLifecycleService.setTaskRemovedHandler(() -> {
            stopReattach();
            resetAllSessions();
        });
        try {
            ctx.startService(new Intent(ctx, StreamDeckLifecycleService.class));
        } catch (Throwable t) {
            Log.w(TAG, "startService(StreamDeckLifecycleService) failed: " + t.getMessage());
        }
        watchWindowFocus(true);
        scanExistingDevices();
    }

    @Override
    protected void handleOnPause() {
        activityPaused = true;
        focusSpan.resumed(false, SystemClock.elapsedRealtime());
        super.handleOnPause();
    }

    /** focusWatch on the activity's window, {@code on} or off. The decor
     *  view's observer outlives its attachment: one taken before the
     *  window is attached merges into the window's own. */
    private void watchWindowFocus(boolean on) {
        android.app.Activity activity = getActivity();
        if (activity == null || activity.getWindow() == null) return;
        ViewTreeObserver vto = activity.getWindow().getDecorView().getViewTreeObserver();
        if (!vto.isAlive()) return;
        if (on) vto.addOnWindowFocusChangeListener(focusWatch);
        else vto.removeOnWindowFocusChangeListener(focusWatch);
    }

    /** A span of focusSpan {@code started}: endWaitsOfGoneConfirm runs once
     *  it may have lasted FocusSpan.SETTLE_MS. */
    private void onFocusSpan(boolean started) {
        if (!started) return;
        mainHandler.removeCallbacks(confirmCheck);
        mainHandler.postDelayed(confirmCheck, FocusSpan.SETTLE_MS);
    }

    /**
     * A hotplug attach waits for the system's confirmation, an activity
     * that takes the screen from the app. The app holding the screen again
     * for FocusSpan.SETTLE_MS means that confirmation is gone: accepted, its
     * grant completes the wait; cancelled or dismissed, nothing grants the
     * permission, so the wait fails permission_missing now rather than
     * after 30 s, and its journal line names the request permission
     * button. No dialog follows: the next comes from a new plug or that
     * button. A wait started during the span keeps waiting, its
     * confirmation possibly not up yet; with a locked phone, the app does
     * not hold the screen while the confirmation is still up.
     */
    private void endWaitsOfGoneConfirm() {
        if (permissions == null) return;
        long since = focusSpan.settledSince(SystemClock.elapsedRealtime());
        if (since < 0) return;
        permissions.confirmGone(since);
    }

    /**
     * A permission granted while the app was away, by the system's
     * confirmation or the settings, completes the request still waiting on
     * it. Then every permitted deck that nothing holds is opened
     * (ReattachPlan.returnDecks): one whose attach ended for lack of the
     * permission, or whose retries were given up for its permission.
     * A deck given up after its reopens failed stays closed, since
     * reopening it would start its retries over on each resume, and so
     * does a deck whose last attach failed to open it. A deck still without
     * permission is left alone, since opening it would raise the dialog;
     * its permissionDenied line says how to grant it. Off the main thread:
     * opening a deck makes EP0 transfers.
     */
    @Override
    protected void handleOnResume() {
        activityPaused = false;
        onFocusSpan(focusSpan.resumed(true, SystemClock.elapsedRealtime()));
        super.handleOnResume();
        runOffMain("deck-resume", () -> {
            if (permissions == null || usb == null) return;
            permissions.recheck();
            List<String> opened = attachReturnDeckNames(null);
            if (!opened.isEmpty()) Log.i(TAG, "resume: opening idle deck(s) " + opened);
        });
    }

    /**
     * The USB_DEVICE_ATTACHED intent of the manifest filter, delivered to
     * the running activity (singleTask) and, through BridgeActivity.load,
     * at a cold start too. Android sends it once the user accepted its
     * confirmation for the device, or at once when "always open" was ticked
     * for it: either way the permission is held. A request waiting on that
     * permission completes and opens the deck; with none waiting, the
     * deck is opened here if ReattachPlan.returnDecks picks it, as on
     * resume.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())) {
            return;
        }
        UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
        if (device == null || !DeckRegistry.isElgato(device.getVendorId())) return;
        runOffMain("deck-attach-intent", () -> {
            if (permissions == null || usb == null) return;
            permissions.recheck();
            List<String> opened =
                attachReturnDeckNames(Collections.singleton(device.getDeviceName()));
            if (!opened.isEmpty()) Log.i(TAG, "attach intent: opening " + opened);
        });
    }

    /** {@code task} on a daemon thread of its own: opening a deck makes EP0
     *  transfers, which the main thread cannot wait for. */
    private static void runOffMain(String threadName, Runnable task) {
        DeckOpenThread.start(threadName, task);
    }

    @Override
    protected void handleOnDestroy() {
        mainHandler.removeCallbacks(confirmCheck);
        watchWindowFocus(false);
        stopReattach();
        DeckSession.setKeyPressHook(null);
        if (hotplug != null) hotplug.detach(getContext());
        if (permissions != null) permissions.close();
        resetAllSessions();
        closeSessions(registry.sessions(), "app_destroyed", DeckSession.CLOSE_WAIT_MS);
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

    /**
     * Closes {@code sessions} side by side, each on its own thread, and
     * waits for them at most {@code boundMs}, 0 for not at all; see
     * ParallelClose. A close blocks while its session's workers end, which
     * neither the main thread nor the shared plugin thread can afford.
     */
    private void closeSessions(List<DeckSession> sessions, String reason, long boundMs) {
        List<Runnable> closes = new ArrayList<>();
        for (DeckSession s : sessions) closes.add(() -> s.close(reason));
        int running = ParallelClose.run(closes, "deck-close", boundMs);
        if (running > 0 && boundMs > 0) {
            Log.w(TAG, running + " session close(s) still running after " + boundMs
                + " ms (" + reason + ")");
        }
    }

    private void scanExistingDevices() {
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (!DeckRegistry.isElgato(d.getVendorId())) continue;
            attach(d, true);
        }
    }

    /**
     * Hotplug attach. Shows no permission dialog: for every known deck the
     * manifest's USB_DEVICE_ATTACHED filter makes Android raise its own
     * confirmation (see UsbDeviceFilterTest), which grants the permission
     * when accepted, or grants it silently once "always open" was ticked.
     * A dialog of the plugin's beside it is a second one, and the dialog
     * left unanswered never reports back. The attach waits for that grant
     * instead, 30 s at most; past that it fails permission_missing, and
     * the attach intent, the next resume or the request permission button
     * opens the deck. A confirmation cancelled or dismissed fails it
     * permission_missing sooner, once the app holds the screen again
     * (endWaitsOfGoneConfirm).
     */
    @Override
    public void onDeckAttached(UsbDevice device) {
        attach(device, false);
    }

    /**
     * Reserve, obtain the permission, open, register: the one path that
     * opens a deck. Without the permission, {@code showDialog} asks for it
     * through the system dialog; false waits for a grant from another path
     * (UsbPermissionRequester.awaitGrant). The open runs on the thread
     * DeckOpenThread picks: the caller when the permission is held already
     * and the caller is not the main thread, a thread of its own otherwise.
     */
    private void attach(UsbDevice device, boolean showDialog) {
        final String name = device.getDeviceName();

        // Cancel any in-flight detach close — the device just bounced
        // (transient enumeration) and we want to keep the existing
        // session alive instead of churning through a close+reopen.
        Runnable pending;
        synchronized (pendingCloseJobs) { pending = pendingCloseJobs.remove(name); }
        if (pending != null) {
            mainHandler.removeCallbacks(pending);
            Log.i(TAG, "attach: cancelled pending close for " + name + " (transient detach)");
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
            Log.i(TAG, "attach: " + name + " already open or opening — skipping");
            return;
        }
        CompletableFuture<Boolean> permitted = showDialog
            ? permissions.request(device)
            : permissions.awaitGrant(device);
        // Never on the thread that completes the permission: see
        // DeckOpenThread.
        Executor opener = DeckOpenThread.choose(permitted.isDone(),
            Looper.myLooper() == Looper.getMainLooper());
        permitted.whenCompleteAsync((granted, err) -> {
            if (causeOf(err) instanceof DeviceDetachedException) {
                // The detach close job released the reservation already,
                // and a device back under this name may hold a new one.
                Log.i(TAG, "attach: " + name + " unplugged while waiting for its permission");
                return;
            }
            if (err != null || granted == null || !granted) {
                // Recorded before the release: ReattachPlan.returnDecks
                // reads the failure of a deck it finds free.
                String reason = err != null ? causeOf(err).getMessage() : "permission_denied";
                recordAttachError(name, reason);
                registry.release(name);
                applyReattach(name, "", reattach.attachFailed(name, reason));
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
                    Log.w(TAG, "attach: " + name + " left while opening — closing");
                    closeSessions(Collections.singletonList(session), "usb_lost", 0);
                    return;
                }
                synchronized (lastAttachError) { lastAttachError.remove(name); }
                // Read after registering: setPowerOptions reaches every
                // registered session, so a change in between is not lost.
                session.setHeartbeat(power.heartbeat());
                updateWakeLock();
            } catch (DeckSession.DeckOpenException e) {
                String reason = e.getMessage();
                recordAttachError(name, reason);
                registry.release(name);
                applyReattach(name, readableSerial(device), reattach.attachFailed(name, reason));
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
            } catch (Throwable t) {
                String reason = "open_unexpected:" + t.getClass().getSimpleName()
                    + ":" + t.getMessage();
                recordAttachError(name, reason);
                registry.release(name);
                closeSessions(Collections.singletonList(session), "open_failed", 0);
                applyReattach(name, readableSerial(device), reattach.attachFailed(name, reason));
                JSObject ev = new JSObject();
                ev.put("deckId", "");
                ev.put("reason", reason);
                emitter.emit("permissionDenied", ev);
            }
        }, opener);
    }

    /** {@code err} without the CompletionException a dependent stage
     *  wraps it in; null stays null. */
    private static Throwable causeOf(Throwable err) {
        return err instanceof CompletionException && err.getCause() != null
            ? err.getCause() : err;
    }

    private String lastAttachErrorOf(String deviceName) {
        synchronized (lastAttachError) { return lastAttachError.get(deviceName); }
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
        // The device is gone: a retry has nothing to open, and the
        // hotplug attach handles its return.
        forgetReattach(name);
        // The restart's late-reopen mark is dropped by the close job only:
        // through a detach and attach bounce, the attach finds the late
        // close still registered and skips, and the mark is what reopens
        // the deck once that close ends. On a real unplug, a close ending
        // inside the debounce finds no device and reopens nothing.
        // Debounce: ThinkPhone (and a few other Android stacks) emit
        // detach + attach in tight succession after the first interrupt
        // event. Closing the session synchronously here would tear the
        // reader thread down and leave subsequent presses unobserved.
        // Schedule the close, and let attach cancel it if the
        // device comes back within DETACH_DEBOUNCE_MS.
        Runnable closeJob = () -> {
            synchronized (pendingCloseJobs) { pendingCloseJobs.remove(name); }
            forgetReattach(name);
            restartReopen.forget(name);
            // An attach still in open() for this device will fail to
            // register and close what it opened; one still waiting for
            // its permission ends quietly (DeviceDetachedException).
            registry.release(name);
            if (permissions != null) permissions.forget(device);
            DeckSession session = registry.byDevice(name);
            if (session != null) {
                Log.i(TAG, "onDeckDetached: closing session for " + name + " (debounce expired)");
                closeSessions(Collections.singletonList(session), "usb_lost", 0);
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
     * reader or the writer when the USB pipe failed, whose wake lock update
     * through applyReattach is then a binder call on that thread.
     * Unregistering here, not only on detach, is what lets attach,
     * restartSessions and retryAttach open the same device again. A session
     * that closed itself gets a retry scheduled by ReattachPolicy.
     */
    private void onSessionClosed(DeckSession session, String reason) {
        String name = session.device().getDeviceName();
        synchronized (lastCloseReason) { lastCloseReason.put(name, reason); }
        if (registry.unregister(name, session, reason)) {
            Log.i(TAG, "session for " + name + " closed (" + reason + ") — unregistered");
        }
        // applyReattach updates the wake lock once the retry is pending,
        // so it is not dropped in the gap before the reopen.
        applyReattach(name, session.serial(), reattach.closed(name, reason));
        if (restartReopen.closed(name)) reopenAfterRestart(name);
    }

    /**
     * Opens again a deck whose restart stopped waiting for its close (see
     * RestartReopen), on a thread of its own: this runs inside the close,
     * which a second close() waits for, and an open makes EP0 transfers.
     * A deck unplugged or without permission meanwhile is left alone.
     */
    private void reopenAfterRestart(String name) {
        UsbDevice device = usb.getDeviceList().get(name);
        if (device == null || !usb.hasPermission(device)) return;
        Log.i(TAG, "restartSessions: " + name + " closed after the wait, reopening");
        runOffMain("deck-reopen", () -> attach(device, true));
    }

    /**
     * Act on a ReattachPolicy decision for {@code name}: schedule the
     * retry, or send reattachGaveUp once the attempts are spent; then
     * update the wake lock, held while a deck waits to be reopened.
     * {@code deckId} is the serial last seen, "" when none was read.
     */
    private void applyReattach(String name, String deckId, ReattachPolicy.Decision d) {
        scheduleOrReport(name, deckId, d);
        updateWakeLock();
    }

    private void scheduleOrReport(String name, String deckId, ReattachPolicy.Decision d) {
        if (d.kind == ReattachPolicy.Decision.Kind.RETRY) {
            Log.i(TAG, "re-attach " + d.attempt + "/" + ReattachPolicy.DELAYS_MS.length
                + " of " + name + " in " + d.delayMs + " ms (" + d.reason + ")");
            reattachTimers.schedule(name, d.token, d.delayMs, () -> runReattach(name, d.token));
        } else if (d.kind == ReattachPolicy.Decision.Kind.GIVE_UP) {
            Log.w(TAG, "re-attach of " + name + " given up after " + d.attempt
                + " attempts (" + d.reason + ")");
            JSObject ev = new JSObject();
            ev.put("deckId", deckId != null ? deckId : "");
            ev.put("deviceName", name);
            ev.put("attempts", d.attempt);
            ev.put("reason", d.reason);
            emitter.emit("reattachGaveUp", ev);
        }
    }

    /**
     * A retry's timer fired. Runs only if the policy still holds this
     * retry, then goes through attach — reserve, permission
     * already granted, open, register — so it can never open a second
     * session. A device without permission is not reopened, since that
     * would raise the system dialog, and no later retry would find the
     * permission granted: the policy gives up at once, and the journal
     * line of reattachGaveUp points at the request permission button.
     */
    private void runReattach(String name, long token) {
        reattachTimers.fired(name, token);
        if (!reattach.due(name, token)) return;
        UsbDevice device = usb.getDeviceList().get(name);
        if (device == null) {
            Log.i(TAG, "re-attach of " + name + " dropped: device no longer listed");
            reattach.forget(name);
            updateWakeLock();
            return;
        }
        if (registry.isBusy(name)) {
            // The attach holding the reservation reports its outcome to
            // the policy: registered, or attachFailed.
            Log.i(TAG, "re-attach of " + name + " skipped: already open or opening");
            return;
        }
        if (!usb.hasPermission(device)) {
            applyReattach(name, "",
                reattach.attachFailed(name, ReattachPolicy.PERMISSION_MISSING));
            return;
        }
        attach(device, true);
    }

    /** No retry for {@code name} any more: detached. */
    private void forgetReattach(String name) {
        reattach.forget(name);
        reattachTimers.cancel(name);
        updateWakeLock();
    }

    /** No retry for any deck any more: the plugin is being destroyed. */
    private void stopReattach() {
        reattach.stop();
        restartReopen.clear();
        reattachTimers.cancelAll();
        ScheduledExecutorService timer = reattachTimer;
        if (timer != null) timer.shutdownNow();
    }

    /** Take or drop the partial wake lock to match the keepAwake option,
     *  the open sessions and the decks waiting to be reopened: the retry
     *  timer does not advance while the CPU sleeps. Synchronized: sessions
     *  close on their own threads while the option changes on the plugin
     *  thread. */
    private synchronized void updateWakeLock() {
        if (wakeLock == null || power == null) return;
        boolean want = power.holdWakeLock(!registry.isEmpty() || reattach.reopening());
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
     * Close every open session, then open every idle deck again (see
     * ReattachPlan): the ones just closed, and any whose session closed
     * itself earlier while the deck stayed plugged in. Lets the user apply
     * setReaderMode without unplugging the deck. With {deviceNames}, only
     * those USB devices are closed, reopened and get their retries back;
     * the other decks are not touched. Resolves {restarted}, the number of
     * decks re-attached. Runs on its own thread, off the plugin thread
     * every plugin shares: the closes wait for the sessions' workers. A
     * close that outlasts CLOSE_WAIT_MS keeps its session registered, which
     * the reopen here would skip: that deck is reopened when its close
     * ends instead (see RestartReopen), and counts in {restarted}, once
     * even when its close ends in time for the reopen here as well.
     */
    @PluginMethod
    public void restartSessions(PluginCall call) {
        Set<String> only = deviceNamesOf(call);
        ParallelClose.run(Collections.singletonList(() -> {
            List<DeckSession> targets = new ArrayList<>();
            for (DeckSession s : registry.sessions()) {
                if (only == null || only.contains(s.device().getDeviceName())) targets.add(s);
            }
            Log.i(TAG, "restartSessions: " + (only == null ? "every deck" : only)
                + ", closing " + targets.size() + " session(s)");
            List<String> closing = new ArrayList<>();
            for (DeckSession s : targets) closing.add(s.device().getDeviceName());
            restartReopen.begin(closing);
            // Each close unregisters its session through onSessionClosed.
            closeSessions(targets, "restart_requested", DeckSession.CLOSE_WAIT_MS);
            if (only == null) forgetAllReattach();
            else for (String name : only) forgetReattach(name);
            Set<String> late = restartReopen.endWait(closing);
            if (!late.isEmpty()) {
                Log.w(TAG, "restartSessions: " + late + " still closing, reopened once closed");
            }
            JSObject r = new JSObject();
            r.put("restarted", RestartReopen.restarted(attachIdleDeckNames(only), late));
            call.resolve(r);
        }), "deck-restart", 0);
    }

    /** The deviceNames option of {@code call}; null when absent, which
     *  means every device. */
    private static Set<String> deviceNamesOf(PluginCall call) {
        JSArray arr = call.getArray("deviceNames");
        if (arr == null) return null;
        Set<String> out = new HashSet<>();
        for (int i = 0; i < arr.length(); i++) {
            String n = arr.optString(i, "");
            if (!n.isEmpty()) out.add(n);
        }
        return out;
    }

    /**
     * For each attached known Stream Deck, the signals SessionHealth reads
     * and its verdict: {decks: [{deviceName, deckId, hasPermission, open,
     * reopening, readerAlive, writerAlive, writeFailuresInARow,
     * controlFailuresInARow, controlPipeOk, msSinceReport, lastCloseReason,
     * sick, sickReason}]}. deckId is the session's serial, else the USB
     * serial once readable, else "". With {quietForMs} above 0, an open
     * session that heard no input report for that long is sick, QUIET (see
     * SessionHealth). Makes no USB transfer, so it costs a deck nothing.
     */
    @PluginMethod
    public void getSessionHealth(PluginCall call) {
        Double quiet = call.getDouble("quietForMs");
        long quietForMs = quiet != null && quiet > 0 ? quiet.longValue() : 0;
        JSArray arr = new JSArray();
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (!DeckRegistry.isElgato(d.getVendorId())
                || DeckRegistry.lookup(d.getProductId()) == null) continue;
            String name = d.getDeviceName();
            boolean permitted = usb.hasPermission(d);
            DeckSession s = registry.byDevice(name);
            boolean open = s != null && s.isOpen();
            SessionHealth.Signals sig = new SessionHealth.Signals(
                permitted, registry.isBusy(name), open, reattach.reopening(name),
                open && s.readerAlive(), open && s.writerAlive(),
                open ? s.writeFailuresInARow() : 0, open ? s.controlFailuresInARow() : 0,
                !open || s.controlPipeOk())
                .heardMsAgo(open ? s.msSinceReport() : 0);
            String sickness = SessionHealth.sickness(sig, quietForMs);
            String closeReason;
            synchronized (lastCloseReason) { closeReason = lastCloseReason.get(name); }
            JSObject o = new JSObject();
            o.put("deviceName", name);
            o.put("deckId", s != null ? s.serial() : permitted ? readableSerial(d) : "");
            o.put("hasPermission", permitted);
            o.put("open", open);
            o.put("reopening", sig.reopening);
            o.put("readerAlive", sig.readerAlive);
            o.put("writerAlive", sig.writerAlive);
            o.put("writeFailuresInARow", sig.writeFailuresInARow);
            o.put("controlFailuresInARow", sig.controlFailuresInARow);
            o.put("controlPipeOk", sig.controlPipeOk);
            o.put("msSinceReport", sig.msSinceReport);
            o.put("lastCloseReason", closeReason != null ? closeReason : "");
            o.put("sick", !sickness.isEmpty());
            o.put("sickReason", sickness);
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("decks", arr);
        call.resolve(r);
    }

    /**
     * Run attach for every known Stream Deck that already has
     * permission but is neither open nor opening. Useful when the
     * diagnostic UI subscribes after the boot-time attach already failed
     * silently, or after a session closed itself.
     */
    @PluginMethod
    public void retryAttach(PluginCall call) {
        forgetAllReattach();
        JSObject r = new JSObject();
        r.put("retried", attachIdleDecks());
        call.resolve(r);
    }

    /** The owner reopens every deck by hand — restartSessions without
     *  deviceNames, retryAttach: pending retries are dropped and every deck
     *  gets its three retries back, a deck given up for a missing
     *  permission included. */
    private void forgetAllReattach() {
        reattach.forgetAll();
        reattachTimers.cancelAll();
        updateWakeLock();
    }

    /** attach on each of ReattachPlan.idleDecks; returns how many. */
    private int attachIdleDecks() { return attachIdleDecks(null); }

    /** attachIdleDecks limited to the device names in {@code only}, null
     *  for every device. */
    private int attachIdleDecks(Set<String> only) {
        return attachIdleDeckNames(only).size();
    }

    /** attachIdleDecks(only), returning the device names it attached. */
    private List<String> attachIdleDeckNames(Set<String> only) {
        Map<String, UsbDevice> attached = usb.getDeviceList();
        return attachEach(attached,
            ReattachPlan.idleDecks(seenOf(attached), registry::isBusy, only));
    }

    /** attach on each of ReattachPlan.returnDecks, limited to the device
     *  names in {@code only}, null for every device; returns their names. */
    private List<String> attachReturnDeckNames(Set<String> only) {
        Map<String, UsbDevice> attached = usb.getDeviceList();
        return attachEach(attached, ReattachPlan.returnDecks(seenOf(attached),
            registry::isBusy, reattach::gaveUpReason, this::lastAttachErrorOf, only));
    }

    private List<PermissionRequestPlan.Device> seenOf(Map<String, UsbDevice> attached) {
        List<PermissionRequestPlan.Device> seen = new ArrayList<>();
        for (UsbDevice d : attached.values()) {
            seen.add(new PermissionRequestPlan.Device(d.getDeviceName(), d.getVendorId(),
                d.getProductId(), "", usb.hasPermission(d)));
        }
        return seen;
    }

    private List<String> attachEach(Map<String, UsbDevice> attached,
                                    List<PermissionRequestPlan.Device> picked) {
        List<String> names = new ArrayList<>();
        for (PermissionRequestPlan.Device t : picked) {
            attach(attached.get(t.deviceName), true);
            names.add(t.deviceName);
        }
        return names;
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

    /**
     * Ask the OS for USB permission on one deck ({deckId}) or, without it,
     * on every attached Stream Deck; PermissionRequestPlan picks the
     * targets. A device already permitted resolves already_granted without
     * a dialog; the others go through UsbPermissionRequester, which shows
     * the dialog once per device and shares its outcome with an attach
     * waiting on the same device, a hotplug one included. Resolves once every
     * target has its outcome, the 30 s timeout included, with
     * {granted, results[]}: granted is true only when every target is.
     * A granted device that is neither open nor opening goes through
     * attach, whose reservation refuses a second session.
     * Rejects "no_stream_deck" / "no_such_deck:<id>".
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        String deckId = call.getString("deckId");
        DeckSession open = deckId != null && !deckId.isEmpty() ? registry.bySerial(deckId) : null;
        Map<String, UsbDevice> attached = usb.getDeviceList();
        List<PermissionRequestPlan.Device> seen = new ArrayList<>();
        for (UsbDevice d : attached.values()) {
            seen.add(new PermissionRequestPlan.Device(d.getDeviceName(), d.getVendorId(),
                d.getProductId(), readableSerial(d), usb.hasPermission(d)));
        }
        PermissionRequestPlan.Selection sel = PermissionRequestPlan.select(
            seen, deckId, open != null ? open.device().getDeviceName() : null);
        if (sel.error != null) { call.reject(sel.error); return; }

        List<CompletableFuture<JSObject>> rows = new ArrayList<>();
        List<PermissionRequestPlan.Outcome> outcomes =
            Collections.synchronizedList(new ArrayList<>());
        for (PermissionRequestPlan.Device t : sel.targets) {
            UsbDevice dev = attached.get(t.deviceName);
            CompletableFuture<Boolean> asked = t.permitted
                ? CompletableFuture.completedFuture(true)
                : permissions.request(dev);
            rows.add(asked.handle((granted, err) -> {
                PermissionRequestPlan.Outcome o =
                    PermissionRequestPlan.outcomeOf(t.permitted, granted, err);
                outcomes.add(o);
                if (o.granted() && !registry.isBusy(t.deviceName)) {
                    try { attach(dev, true); }
                    catch (Throwable e) { Log.w(TAG, "attach after permission failed: " + e.getMessage()); }
                }
                return permissionResultOf(dev, o, err);
            }));
        }
        CompletableFuture.allOf(rows.toArray(new CompletableFuture[0])).whenComplete((v, e) -> {
            if (e != null) { call.reject("permission_result_failed:" + e.getMessage()); return; }
            JSArray arr = new JSArray();
            for (CompletableFuture<JSObject> row : rows) arr.put(row.join());
            JSObject r = new JSObject();
            r.put("granted", PermissionRequestPlan.allGranted(outcomes));
            r.put("results", arr);
            call.resolve(r);
        });
    }

    /** One entry of requestPermission's results. deckId is the open
     *  session's, else the USB serial once readable, else "". */
    private JSObject permissionResultOf(UsbDevice dev, PermissionRequestPlan.Outcome o, Throwable err) {
        DeckSession s = registry.byDevice(dev.getDeviceName());
        JSObject r = new JSObject();
        r.put("deviceName", dev.getDeviceName());
        r.put("deckId", s != null ? s.serial() : o.granted() ? readableSerial(dev) : "");
        r.put("outcome", o.wire);
        r.put("granted", o.granted());
        if (err != null) {
            Throwable cause = err instanceof CompletionException
                && err.getCause() != null ? err.getCause() : err;
            r.put("error", cause.getMessage());
        }
        return r;
    }

    /** USB descriptor serial, "" when absent or hidden for lack of permission. */
    private static String readableSerial(UsbDevice d) {
        try {
            String s = d.getSerialNumber();
            return s != null ? s : "";
        } catch (Exception e) {
            return "";
        }
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
                attach(dev, true);
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
     * Arm or disarm the wake-on-keypress path. When armed, a key press
     * while the host activity is paused re-launches MainActivity so the
     * user lands back where the deck press would normally take them. With
     * the screen off, it does so only with showOverLockScreen on, and then
     * acquires a screen-bright wake lock first; without that option the
     * screen stays off and the press reaches the app only as keyChanged.
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
     * keyPressHook from DeckSession, posted to the main thread. Fires on
     * every accepted key down (release events are filtered upstream),
     * after keyChanged has been emitted. Returns at once unless DeckPowerOptions
     * .bringAppForwardOnKeyPress holds: wakeOnKeyPress armed, the activity
     * paused, and the screen lit already or showOverLockScreen on. The
     * activity is never relaunched while the user is in it, and the screen
     * is turned on only under wakeScreenOnKeyPress, which needs
     * showOverLockScreen.
     */
    @SuppressWarnings("deprecation")
    private void onDeckKeyPressed() {
        DeckPowerOptions p = power;
        if (p == null) return;
        Context ctx = getContext();
        if (ctx == null) return;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            boolean interactive = pm != null && pm.isInteractive();
            if (!p.bringAppForwardOnKeyPress(wakeOnKeyPress, activityPaused, interactive)) return;
            // SCREEN_BRIGHT_WAKE_LOCK + ACQUIRE_CAUSES_WAKEUP +
            // ON_AFTER_RELEASE is the smallest API surface that
            // actually wakes the display from off — modern guidance
            // is FLAG_TURN_SCREEN_ON on the activity, but that only
            // works if the activity is *being launched* into the
            // foreground. We need the wake to happen even when the
            // OS is throttling activity launches, so the deprecated
            // wake lock combo is the right tool here.
            if (pm != null && p.wakeScreenOnKeyPress(wakeOnKeyPress, activityPaused)) {
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
            // showOverLockScreen option; without it, a launch over a lit
            // lock screen stays behind the keyguard.
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

        // Settled once, by the writer or by the queue as dropped. Not kept
        // alive: the Bridge would hold a kept-alive call and its bytes
        // until releaseCall, for every frame.
        s.queue().offerCoalesce(new ImageWriteJob(s, key, raw, call));
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
        o.put("controlPipeOk", s.controlPipeOk());
        JSArray caps = new JSArray();
        for (String c : spec.capabilities) caps.put(c);
        o.put("capabilities", caps);
        return o;
    }
}
