package ca.erplibre.home.streamdeck;

import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.usb.UsbManager;

/**
 * The two power options of the Stream Deck integration, both off until the
 * user turns them on, and what follows from each.
 *
 *   showOverLockScreen — a launch caused by the deck (USB attach, or the
 *       wake-on-key-press relaunch) may show the app over the keyguard and
 *       turn the screen on. Any other launch never does, and a key press
 *       never lights the screen without it; over a screen already lit, a
 *       key press still brings the app forward.
 *   keepAwake — while a deck is open, a partial wake lock holds the CPU and
 *       each session sends its heartbeat. Off, the phone may suspend the USB
 *       bus with the screen off: the deck LCD may pulse or go dark and key
 *       presses may not arrive until the screen is back on.
 *
 * Kept in SharedPreferences rather than the WebView's storage: MainActivity
 * reads them before the WebView exists, and the plugin opens the decks
 * already plugged in before any JS runs. Store keeps the decisions free of
 * Android so JUnit runs them.
 */
public final class DeckPowerOptions {

    /** Boolean key-value storage; a key never written reads as false. */
    public interface Store {
        boolean get(String key);
        void put(String key, boolean value);
    }

    static final String PREFS = "streamdeck_power";
    static final String SHOW_OVER_LOCK_SCREEN = "showOverLockScreen";
    static final String KEEP_AWAKE = "keepAwake";

    /** Boolean extra the wake-on-key-press relaunch puts on its intent. */
    public static final String EXTRA_DECK_WAKE = "ca.erplibre.home.streamdeck.DECK_WAKE";

    private final Store store;

    public DeckPowerOptions(Store store) { this.store = store; }

    public static DeckPowerOptions of(Context ctx) {
        final SharedPreferences sp =
            ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new DeckPowerOptions(new Store() {
            @Override public boolean get(String key) { return sp.getBoolean(key, false); }
            @Override public void put(String key, boolean value) {
                sp.edit().putBoolean(key, value).apply();
            }
        });
    }

    public boolean showOverLockScreen() { return store.get(SHOW_OVER_LOCK_SCREEN); }
    public boolean keepAwake()          { return store.get(KEEP_AWAKE); }

    public void setShowOverLockScreen(boolean on) { store.put(SHOW_OVER_LOCK_SCREEN, on); }
    public void setKeepAwake(boolean on)          { store.put(KEEP_AWAKE, on); }

    /**
     * Whether a launch with this intent action, carrying EXTRA_DECK_WAKE or
     * not, shows over the keyguard and turns the screen on. The launcher
     * intent alone never does, so an ordinary launch stays behind the lock.
     */
    public boolean showOverLockScreenFor(String action, boolean deckWake) {
        if (!showOverLockScreen()) return false;
        return deckWake || UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action);
    }

    /**
     * Whether a deck key press turns the screen on: wake-on-key-press
     * armed, the host activity paused, and showOverLockScreen on. Otherwise
     * the screen stays as it is; the press still reaches a running app as
     * a keyChanged event. keepAwake plays no part here: it decides whether
     * the press arrives at all.
     */
    public boolean wakeScreenOnKeyPress(boolean wakeOnKeyPress, boolean activityPaused) {
        return wakeOnKeyPress && activityPaused && showOverLockScreen();
    }

    /**
     * Whether a deck key press brings the paused app to the front: with
     * wake-on-key-press armed, when the screen is already interactive, or
     * when {@link #wakeScreenOnKeyPress} turns it on. A screen left off
     * gets no relaunch, which nobody would see.
     */
    public boolean bringAppForwardOnKeyPress(
            boolean wakeOnKeyPress, boolean activityPaused, boolean screenInteractive) {
        if (!wakeOnKeyPress || !activityPaused) return false;
        return screenInteractive || showOverLockScreen();
    }

    /** The partial wake lock is held only with keepAwake and a deck open,
     *  or one waiting to be reopened (ReattachPolicy.reopening). */
    public boolean holdWakeLock(boolean anyDeckOpen) { return keepAwake() && anyDeckOpen; }

    /** Each open session sends its heartbeat only with keepAwake. */
    public boolean heartbeat() { return keepAwake(); }
}
