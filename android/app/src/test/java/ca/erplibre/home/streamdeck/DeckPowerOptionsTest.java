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

    @Test
    public void key_press_wakes_the_screen_only_with_wake_on_key_press_and_lock_screen_option() {
        // wakeOnKeyPress x showOverLockScreen, with the host activity paused.
        boolean[][] table = {
            // wakeOnKeyPress, showOverLockScreen, wakes
            { false, false, false },
            { false, true,  false },
            { true,  false, false },
            { true,  true,  true  },
        };
        for (boolean[] row : table) {
            DeckPowerOptions p = new DeckPowerOptions(new MapStore());
            p.setShowOverLockScreen(row[1]);
            assertEquals("wakeOnKeyPress=" + row[0] + " showOverLockScreen=" + row[1],
                row[2], p.wakeScreenOnKeyPress(row[0], true));
        }
    }

    @Test
    public void key_press_never_wakes_the_screen_while_the_app_is_in_front() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        p.setShowOverLockScreen(true);
        assertFalse(p.wakeScreenOnKeyPress(true, false));
    }

    @Test
    public void key_press_wake_ignores_keep_awake() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        p.setKeepAwake(true);
        assertFalse(p.wakeScreenOnKeyPress(true, true));
        p.setShowOverLockScreen(true);
        p.setKeepAwake(false);
        assertTrue(p.wakeScreenOnKeyPress(true, true));
    }

    @Test
    public void key_press_brings_the_app_forward_over_a_lit_screen_or_with_the_lock_option() {
        // wakeOnKeyPress x showOverLockScreen x screen interactive, app paused.
        boolean[][] table = {
            // wakeOnKeyPress, showOverLockScreen, interactive, brings forward
            { false, false, true,  false },
            { false, true,  false, false },
            { true,  false, false, false },
            { true,  false, true,  true  },
            { true,  true,  false, true  },
            { true,  true,  true,  true  },
        };
        for (boolean[] row : table) {
            DeckPowerOptions p = new DeckPowerOptions(new MapStore());
            p.setShowOverLockScreen(row[1]);
            assertEquals("wakeOnKeyPress=" + row[0] + " showOverLockScreen=" + row[1]
                    + " interactive=" + row[2],
                row[3], p.bringAppForwardOnKeyPress(row[0], true, row[2]));
        }
    }

    @Test
    public void key_press_never_relaunches_the_app_in_front() {
        DeckPowerOptions p = new DeckPowerOptions(new MapStore());
        p.setShowOverLockScreen(true);
        assertFalse(p.bringAppForwardOnKeyPress(true, false, true));
    }
}
