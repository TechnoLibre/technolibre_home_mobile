package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import ca.erplibre.home.streamdeck.PermissionRequestPlan.Device;

public class ReattachPlanTest {

    private static final int ELGATO = DeckRegistry.ELGATO_VENDOR_ID;
    private static final int MK2 = 0x0080;

    private static Device deck(String name, boolean permitted) {
        return new Device(name, ELGATO, MK2, "", permitted);
    }

    private static List<Device> pick(List<Device> attached, String... busy) {
        Set<String> b = new HashSet<>(Arrays.asList(busy));
        return ReattachPlan.idleDecks(attached, b::contains);
    }

    @Test
    public void deck_whose_session_closed_itself_is_opened_again() {
        // A reader or write failure unregisters the session while the deck
        // stays plugged in: nothing holds the device, so a restart must
        // reopen it even though it had no session to close.
        Device selfClosed = deck("/dev/bus/usb/001/002", true);
        assertEquals(Collections.singletonList(selfClosed), pick(Arrays.asList(selfClosed)));
    }

    @Test
    public void device_with_a_session_or_an_attach_in_flight_is_left_alone() {
        Device open = deck("/dev/bus/usb/001/002", true);
        Device idle = deck("/dev/bus/usb/001/003", true);
        assertEquals(Collections.singletonList(idle),
            pick(Arrays.asList(open, idle), "/dev/bus/usb/001/002"));
    }

    @Test
    public void deck_without_permission_is_skipped() {
        // Attaching it would raise the system dialog: a restart never asks.
        assertTrue(pick(Arrays.asList(deck("/dev/bus/usb/001/002", false))).isEmpty());
    }

    @Test
    public void other_usb_devices_are_skipped() {
        Device keyboard = new Device("/dev/bus/usb/001/004", 0x1234, 0x0001, "", true);
        Device unknownElgato = new Device("/dev/bus/usb/001/005", ELGATO, 0x7fff, "", true);
        assertTrue(pick(Arrays.asList(keyboard, unknownElgato)).isEmpty());
    }

    @Test
    public void a_restart_limited_to_some_devices_opens_only_those() {
        Device sick = deck("/dev/bus/usb/001/002", true);
        Device healthyIdle = deck("/dev/bus/usb/001/003", true);
        Set<String> only = new HashSet<>(Collections.singletonList(sick.deviceName));
        assertEquals(Collections.singletonList(sick),
            ReattachPlan.idleDecks(Arrays.asList(sick, healthyIdle), n -> false, only));
    }

    @Test
    public void no_limit_opens_every_idle_deck() {
        Device a = deck("/dev/bus/usb/001/002", true);
        Device b = deck("/dev/bus/usb/001/003", true);
        assertEquals(Arrays.asList(a, b),
            ReattachPlan.idleDecks(Arrays.asList(a, b), n -> false, null));
    }

    @Test
    public void a_limited_restart_still_skips_busy_and_unpermitted_decks() {
        Device busy = deck("/dev/bus/usb/001/002", true);
        Device denied = deck("/dev/bus/usb/001/003", false);
        Set<String> only = new HashSet<>(Arrays.asList(busy.deviceName, denied.deviceName));
        assertTrue(ReattachPlan.idleDecks(Arrays.asList(busy, denied),
            busy.deviceName::equals, only).isEmpty());
    }
}
