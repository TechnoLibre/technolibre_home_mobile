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

    @Test
    public void a_deck_granted_after_its_attach_timed_out_is_opened_on_resume() {
        // The attach released its reservation when the permission wait
        // expired; the grant comes later, and the resume picks the deck up
        // once the system reports it permitted, not before.
        SessionRegistry<Object> registry = new SessionRegistry<>(new SessionRegistry.Hooks<Object>() {
            @Override public boolean isOpen(Object s) { return true; }
            @Override public void connected(Object s) { }
            @Override public void disconnected(Object s, String reason) { }
        });
        String name = "/dev/bus/usb/001/002";
        assertTrue(registry.reserve(name));
        assertTrue(ReattachPlan.idleDecks(Arrays.asList(deck(name, true)), registry::isBusy).isEmpty());
        registry.release(name);  // permission_missing
        assertTrue(ReattachPlan.idleDecks(Arrays.asList(deck(name, false)), registry::isBusy).isEmpty());
        assertEquals(1, ReattachPlan.idleDecks(Arrays.asList(deck(name, true)), registry::isBusy).size());
    }

    // ── returnDecks: what a resume or the attach intent opens ────────────

    private static List<Device> onReturn(List<Device> attached, String gaveUpName,
                                         String gaveUpReason) {
        return ReattachPlan.returnDecks(attached, n -> false,
            n -> n.equals(gaveUpName) ? gaveUpReason : null, n -> null, null);
    }

    @Test
    public void a_permitted_idle_deck_is_opened_on_return() {
        Device d = deck("/dev/bus/usb/001/002", true);
        assertEquals(Collections.singletonList(d), onReturn(Arrays.asList(d), null, null));
    }

    @Test
    public void a_deck_given_up_after_its_failures_stays_closed_on_return() {
        // Its reader died after each of three reopens. Opening it on every
        // resume would give it three more retries each time, since a
        // registration restores the budget: a retry loop driven by resume.
        Device d = deck("/dev/bus/usb/001/002", true);
        assertTrue(onReturn(Arrays.asList(d), d.deviceName, "polled_reset").isEmpty());
    }

    @Test
    public void a_deck_given_up_for_its_permission_is_opened_once_granted() {
        Device d = deck("/dev/bus/usb/001/002", true);
        assertEquals(Collections.singletonList(d),
            onReturn(Arrays.asList(d), d.deviceName, ReattachPolicy.PERMISSION_MISSING));
    }

    @Test
    public void return_skips_what_idle_decks_skips() {
        Device busy = deck("/dev/bus/usb/001/002", true);
        Device denied = deck("/dev/bus/usb/001/003", false);
        Device keyboard = new Device("/dev/bus/usb/001/004", 0x1234, 0x0001, "", true);
        assertTrue(ReattachPlan.returnDecks(Arrays.asList(busy, denied, keyboard),
            busy.deviceName::equals, n -> null, n -> null, null).isEmpty());
    }

    @Test
    public void the_attach_intent_opens_only_the_deck_it_names() {
        Device named = deck("/dev/bus/usb/001/002", true);
        Device other = deck("/dev/bus/usb/001/003", true);
        assertEquals(Collections.singletonList(named),
            ReattachPlan.returnDecks(Arrays.asList(named, other), n -> false, n -> null,
                n -> null, Collections.singleton(named.deviceName)));
    }

    private static List<Device> afterAttachFailed(Device d, String lastAttachError) {
        return ReattachPlan.returnDecks(Arrays.asList(d), n -> false, n -> null,
            n -> n.equals(d.deviceName) ? lastAttachError : null, null);
    }

    @Test
    public void a_deck_whose_open_just_failed_is_not_opened_again_on_return() {
        // The grant that completes a waiting attach also brings the attach
        // intent and a resume: the attach's open failed and released the
        // device, and opening it again from either would repeat the failure
        // at once.
        Device d = deck("/dev/bus/usb/001/002", true);
        assertTrue(afterAttachFailed(d, "interface_busy").isEmpty());
        assertTrue(afterAttachFailed(d, "open_unexpected:IllegalStateException:x").isEmpty());
    }

    @Test
    public void a_deck_whose_attach_lacked_the_permission_is_opened_once_granted() {
        Device d = deck("/dev/bus/usb/001/002", true);
        assertEquals(1, afterAttachFailed(d, "permission_missing").size());
        assertEquals(1, afterAttachFailed(d, "permission_timeout").size());
        assertEquals(1, afterAttachFailed(d, "permission_denied").size());
    }

    // ── askDecks: the dialog a resume shows ─────────────────────────────

    @Test
    public void a_deck_whose_confirmation_was_dismissed_is_asked_on_return() {
        // Its hotplug attach waited for the system's confirmation, which
        // the user dismissed: the deck may still hold that attach.
        Device d = deck("/dev/bus/usb/001/002", false);
        assertEquals(Collections.singletonList(d),
            ReattachPlan.askDecks(Arrays.asList(d), n -> true));
    }

    @Test
    public void a_deck_that_owes_no_dialog_is_not_asked() {
        // Its dialog was shown already, refused or left unanswered.
        Device d = deck("/dev/bus/usb/001/002", false);
        assertTrue(ReattachPlan.askDecks(Arrays.asList(d), n -> false).isEmpty());
    }

    @Test
    public void a_permitted_deck_or_another_device_is_never_asked() {
        Device permitted = deck("/dev/bus/usb/001/002", true);
        Device keyboard = new Device("/dev/bus/usb/001/004", 0x1234, 0x0001, "", false);
        assertTrue(ReattachPlan.askDecks(Arrays.asList(permitted, keyboard), n -> true).isEmpty());
    }
}
