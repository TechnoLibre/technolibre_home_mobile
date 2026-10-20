package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.CompletionException;

import ca.erplibre.home.streamdeck.PermissionRequestPlan.Device;
import ca.erplibre.home.streamdeck.PermissionRequestPlan.Outcome;
import ca.erplibre.home.streamdeck.PermissionRequestPlan.Selection;
import ca.erplibre.home.streamdeck.usb.PermissionTimeoutException;

public class PermissionRequestPlanTest {

    private static final int ELGATO = DeckRegistry.ELGATO_VENDOR_ID;
    private static final int MK2 = 0x0080;

    private static Device deck(String name, String serial, boolean permitted) {
        return new Device(name, ELGATO, MK2, serial, permitted);
    }

    private static final Device OPEN = deck("/dev/bus/usb/001/002", "SERIAL-A", true);
    private static final Device ASKING = deck("/dev/bus/usb/001/003", "", false);
    private static final Device KEYBOARD =
        new Device("/dev/bus/usb/001/004", 0x1234, 0x0001, "", false);
    private static final Device OTHER_ELGATO =
        new Device("/dev/bus/usb/001/005", ELGATO, 0x7fff, "", false);

    @Test
    public void without_a_deck_id_every_attached_stream_deck_is_targeted() {
        Selection s = PermissionRequestPlan.select(
            Arrays.asList(OPEN, KEYBOARD, ASKING, OTHER_ELGATO), null, null);
        assertNull(s.error);
        assertEquals(Arrays.asList(OPEN, ASKING), s.targets);
    }

    @Test
    public void an_empty_deck_id_reads_as_no_deck_id() {
        Selection s = PermissionRequestPlan.select(Arrays.asList(OPEN, ASKING), "", null);
        assertEquals(Arrays.asList(OPEN, ASKING), s.targets);
    }

    @Test
    public void without_any_stream_deck_the_call_is_refused() {
        Selection s = PermissionRequestPlan.select(
            Arrays.asList(KEYBOARD, OTHER_ELGATO), null, null);
        assertEquals("no_stream_deck", s.error);
        assertTrue(s.targets.isEmpty());
    }

    @Test
    public void a_deck_id_targets_the_device_of_its_open_session() {
        // The session's serial comes from a HID report and may differ
        // from the USB descriptor: the session's device wins.
        Selection s = PermissionRequestPlan.select(
            Arrays.asList(OPEN, ASKING), "FROM-HID", OPEN.deviceName);
        assertNull(s.error);
        assertEquals(Collections.singletonList(OPEN), s.targets);
    }

    @Test
    public void a_deck_id_without_a_session_matches_the_usb_serial() {
        Device permittedClosed = deck("/dev/bus/usb/001/006", "SERIAL-B", true);
        Selection s = PermissionRequestPlan.select(
            Arrays.asList(OPEN, permittedClosed), "SERIAL-B", null);
        assertEquals(Collections.singletonList(permittedClosed), s.targets);
    }

    @Test
    public void an_unknown_deck_id_is_refused() {
        Selection s = PermissionRequestPlan.select(Arrays.asList(OPEN, ASKING), "NOPE", null);
        assertEquals("no_such_deck:NOPE", s.error);
    }

    @Test
    public void a_deck_id_never_matches_an_unreadable_serial() {
        // Android 10+ hides the serial until permission is granted.
        Selection s = PermissionRequestPlan.select(Collections.singletonList(ASKING), "X", null);
        assertEquals("no_such_deck:X", s.error);
    }

    @Test
    public void a_device_permitted_beforehand_is_already_granted() {
        assertEquals(Outcome.ALREADY_GRANTED, PermissionRequestPlan.outcomeOf(true, true, null));
    }

    @Test
    public void the_answer_of_the_dialog_is_granted_or_denied() {
        assertEquals(Outcome.GRANTED, PermissionRequestPlan.outcomeOf(false, true, null));
        assertEquals(Outcome.DENIED, PermissionRequestPlan.outcomeOf(false, false, null));
        assertEquals(Outcome.DENIED, PermissionRequestPlan.outcomeOf(false, null, null));
    }

    @Test
    public void a_dialog_left_unanswered_is_a_timeout() {
        assertEquals(Outcome.TIMEOUT, PermissionRequestPlan.outcomeOf(
            false, null, new PermissionTimeoutException()));
        assertEquals(Outcome.TIMEOUT, PermissionRequestPlan.outcomeOf(
            false, null, new CompletionException(new PermissionTimeoutException())));
    }

    @Test
    public void any_other_failure_is_an_error() {
        assertEquals(Outcome.ERROR, PermissionRequestPlan.outcomeOf(
            false, null, new IllegalStateException("boom")));
    }

    @Test
    public void outcomes_name_themselves_on_the_wire() {
        assertEquals("already_granted", Outcome.ALREADY_GRANTED.wire);
        assertEquals("granted", Outcome.GRANTED.wire);
        assertEquals("denied", Outcome.DENIED.wire);
        assertEquals("timeout", Outcome.TIMEOUT.wire);
        assertEquals("error", Outcome.ERROR.wire);
        assertTrue(Outcome.ALREADY_GRANTED.granted());
        assertTrue(Outcome.GRANTED.granted());
        assertFalse(Outcome.DENIED.granted());
        assertFalse(Outcome.TIMEOUT.granted());
        assertFalse(Outcome.ERROR.granted());
    }

    @Test
    public void the_call_is_granted_only_when_every_deck_is() {
        assertTrue(PermissionRequestPlan.allGranted(
            Arrays.asList(Outcome.ALREADY_GRANTED, Outcome.GRANTED)));
        assertFalse(PermissionRequestPlan.allGranted(
            Arrays.asList(Outcome.GRANTED, Outcome.DENIED)));
        assertFalse(PermissionRequestPlan.allGranted(Collections.<Outcome>emptyList()));
    }

    @Test
    public void the_timeout_names_itself() {
        assertEquals("permission_timeout", new PermissionTimeoutException().getMessage());
    }
}
