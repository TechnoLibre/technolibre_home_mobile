package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

public class DeckPowerOptionsTest {

    private static final String USB_ATTACHED =
        "android.hardware.usb.action.USB_DEVICE_ATTACHED";
    private static final String MAIN = "android.intent.action.MAIN";

    /** SharedPreferences stand-in: a key never written reads as false. */
    private static final class MapStore implements DeckPowerOptions.Store {
        final Map<String, Boolean> values = new HashMap<>();
        @Override public boolean get(String key) { return Boolean.TRUE.equals(values.get(key)); }
        @Override public void put(String key, boolean value) { values.put(key, value); }
    }

    @Test
    public void both_options_are_off_by_default() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        assertFalse(p.showOverLockScreen());
        assertFalse(p.keepAwake());
    }

    @Test
    public void options_are_read_back_from_the_store() {
        MapStore store = new MapStore();
        new DeckPowerOptions(store).setShowOverLockScreen(true);
        new DeckPowerOptions(store).setKeepAwake(true);
        DeckPowerOptions again = new DeckPowerOptions(store);
        assertTrue(again.showOverLockScreen());
        assertTrue(again.keepAwake());
    }

    @Test
    public void options_are_independent() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        p.setKeepAwake(true);
        assertFalse(p.showOverLockScreen());
        p.setKeepAwake(false);
        p.setShowOverLockScreen(true);
        assertFalse(p.keepAwake());
    }

    @Test
    public void option_off_never_shows_over_the_lock_screen() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        assertFalse(p.showOverLockScreenFor(USB_ATTACHED, false));
        assertFalse(p.showOverLockScreenFor(MAIN, true));
        assertFalse(p.showOverLockScreenFor(null, true));
    }

    @Test
    public void option_on_shows_over_the_lock_screen_for_a_deck_launch() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        p.setShowOverLockScreen(true);
        assertTrue(p.showOverLockScreenFor(USB_ATTACHED, false));
        // Wake-on-key-press relaunches through the launcher intent.
        assertTrue(p.showOverLockScreenFor(MAIN, true));
    }

    @Test
    public void option_on_leaves_an_ordinary_launch_under_the_lock_screen() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        p.setShowOverLockScreen(true);
        assertFalse(p.showOverLockScreenFor(MAIN, false));
        assertFalse(p.showOverLockScreenFor(null, false));
    }

    @Test
    public void wake_lock_needs_the_option_and_an_open_deck() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        assertFalse(p.holdWakeLock(true));
        assertFalse(p.holdWakeLock(false));
        p.setKeepAwake(true);
        assertTrue(p.holdWakeLock(true));
        assertFalse(p.holdWakeLock(false));
    }

    @Test
    public void heartbeat_follows_keep_awake() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        assertFalse(p.heartbeat());
        p.setKeepAwake(true);
        assertTrue(p.heartbeat());
    }
}
