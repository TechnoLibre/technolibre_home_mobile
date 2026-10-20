package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

public class SessionRegistryTest {

    /** Stand-in for DeckSession: only its open flag matters to the registry. */
    static final class FakeSession {
        boolean open = true;
    }

    /** Records the lifecycle events the plugin would send to JS. */
    static final class FakeHooks implements SessionRegistry.Hooks<FakeSession> {
        final List<String> events = new ArrayList<>();
        SessionRegistry<FakeSession> registry;
        @Override public boolean isOpen(FakeSession s) { return s.open; }
        @Override public void connected(FakeSession s) {
            // JS answers deckConnected with calls by deckId: the session
            // must already be reachable when the event leaves.
            events.add("connected:" + (registry.sessions().contains(s) ? "registered" : "missing"));
        }
        @Override public void disconnected(FakeSession s, String reason) {
            events.add("disconnected:" + reason);
        }
    }

    private static SessionRegistry<FakeSession> newRegistry() {
        return newRegistry(new FakeHooks());
    }

    private static SessionRegistry<FakeSession> newRegistry(FakeHooks hooks) {
        SessionRegistry<FakeSession> r = new SessionRegistry<>(hooks);
        hooks.registry = r;
        return r;
    }

    /** The attach flow: reserve the device, open, then register. */
    private static boolean attach(SessionRegistry<FakeSession> r, String dev,
                                  String serial, FakeSession s) {
        return r.reserve(dev) && r.register(dev, serial, s);
    }

    @Test
    public void register_indexes_by_device_and_serial() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        assertTrue(attach(r, "/dev/bus/usb/001/002", "SN1", s));
        assertSame(s, r.byDevice("/dev/bus/usb/001/002"));
        assertSame(s, r.bySerial("SN1"));
        assertTrue(r.hasSession("/dev/bus/usb/001/002"));
    }

    @Test
    public void self_closed_session_unregisters_and_frees_the_device() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        attach(r, "/dev/bus/usb/001/002", "SN1", s);

        s.open = false;
        assertTrue(r.unregister("/dev/bus/usb/001/002", s, "usb_lost"));

        assertNull(r.byDevice("/dev/bus/usb/001/002"));
        assertNull(r.bySerial("SN1"));
        assertFalse(r.hasSession("/dev/bus/usb/001/002"));
        assertTrue(r.isEmpty());
        // A later attach of the same device opens a new session.
        assertTrue(attach(r, "/dev/bus/usb/001/002", "SN1", new FakeSession()));
    }

    @Test
    public void unregister_happens_once() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        attach(r, "/dev/bus/usb/001/002", "SN1", s);
        assertTrue(r.unregister("/dev/bus/usb/001/002", s, "usb_lost"));
        assertFalse(r.unregister("/dev/bus/usb/001/002", s, "usb_lost"));
    }

    @Test
    public void stale_session_does_not_unregister_its_successor() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession old = new FakeSession();
        FakeSession current = new FakeSession();
        attach(r, "/dev/bus/usb/001/002", "SN1", current);

        assertFalse(r.unregister("/dev/bus/usb/001/002", old, "usb_lost"));
        assertSame(current, r.byDevice("/dev/bus/usb/001/002"));
        assertSame(current, r.bySerial("SN1"));
    }

    @Test
    public void session_closed_before_registration_is_refused() {
        // The reader thread starts inside open(), so a session can close
        // itself before the plugin registers it: its unregister then found
        // nothing, and registering it now would leave a dead entry behind.
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        s.open = false;
        assertFalse(r.unregister("/dev/bus/usb/001/002", s, "usb_lost"));

        assertFalse(attach(r, "/dev/bus/usb/001/002", "SN1", s));
        assertFalse(r.hasSession("/dev/bus/usb/001/002"));
        assertNull(r.bySerial("SN1"));
    }

    @Test
    public void empty_serial_is_not_indexed() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        assertTrue(attach(r, "/dev/bus/usb/001/002", "", s));
        assertNull(r.bySerial(""));
        assertEquals(1, r.sessions().size());
    }

    @Test
    public void second_attach_of_a_device_being_opened_is_refused() {
        // A hotplug attach and a diagnostic permission request both reach
        // the open path for one device: only the first may open it.
        SessionRegistry<FakeSession> r = newRegistry();
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
        assertFalse(r.reserve("/dev/bus/usb/001/002"));
        assertTrue(r.isBusy("/dev/bus/usb/001/002"));
        assertFalse(r.hasSession("/dev/bus/usb/001/002"));
    }

    @Test
    public void attach_of_a_device_with_an_open_session_reuses_it() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        assertTrue(attach(r, "/dev/bus/usb/001/002", "SN1", s));
        assertFalse(r.reserve("/dev/bus/usb/001/002"));
        assertSame(s, r.byDevice("/dev/bus/usb/001/002"));
    }

    @Test
    public void other_devices_are_independent() {
        SessionRegistry<FakeSession> r = newRegistry();
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
        assertTrue(r.reserve("/dev/bus/usb/001/003"));
    }

    @Test
    public void released_reservation_lets_a_later_attach_through() {
        // Permission denied or open failed: nothing registered, slot free.
        SessionRegistry<FakeSession> r = newRegistry();
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
        r.release("/dev/bus/usb/001/002");
        assertFalse(r.isBusy("/dev/bus/usb/001/002"));
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
    }

    @Test
    public void register_without_reservation_is_refused() {
        // The detach that cancels a reservation makes the open in flight
        // fail to register; its caller then closes the orphan.
        SessionRegistry<FakeSession> r = newRegistry();
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
        r.release("/dev/bus/usb/001/002");
        assertFalse(r.register("/dev/bus/usb/001/002", "SN1", new FakeSession()));
        assertFalse(r.hasSession("/dev/bus/usb/001/002"));
    }

    @Test
    public void register_consumes_the_reservation() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        assertTrue(attach(r, "/dev/bus/usb/001/002", "SN1", s));
        r.unregister("/dev/bus/usb/001/002", s, "usb_lost");
        assertFalse(r.isBusy("/dev/bus/usb/001/002"));
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
    }

    @Test
    public void closed_session_releases_the_reservation_too() {
        SessionRegistry<FakeSession> r = newRegistry();
        FakeSession s = new FakeSession();
        s.open = false;
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
        assertFalse(r.register("/dev/bus/usb/001/002", "SN1", s));
        assertFalse(r.isBusy("/dev/bus/usb/001/002"));
    }

    @Test
    public void connected_is_announced_once_registered() {
        FakeHooks h = new FakeHooks();
        SessionRegistry<FakeSession> r = newRegistry(h);
        FakeSession s = new FakeSession();
        assertTrue(attach(r, "/dev/bus/usb/001/002", "SN1", s));
        assertEquals(List.of("connected:registered"), h.events);
    }

    @Test
    public void refused_registration_announces_nothing() {
        FakeHooks h = new FakeHooks();
        SessionRegistry<FakeSession> r = newRegistry(h);
        assertFalse(r.register("/dev/bus/usb/001/002", "SN1", new FakeSession()));
        FakeSession closed = new FakeSession();
        closed.open = false;
        assertFalse(attach(r, "/dev/bus/usb/001/003", "SN2", closed));
        assertTrue(h.events.isEmpty());
    }

    @Test
    public void disconnected_is_announced_once_with_the_close_reason() {
        FakeHooks h = new FakeHooks();
        SessionRegistry<FakeSession> r = newRegistry(h);
        FakeSession s = new FakeSession();
        attach(r, "/dev/bus/usb/001/002", "SN1", s);
        s.open = false;
        r.unregister("/dev/bus/usb/001/002", s, "polled_reset");
        r.unregister("/dev/bus/usb/001/002", s, "usb_lost");
        assertEquals(List.of("connected:registered", "disconnected:polled_reset"), h.events);
    }

    @Test
    public void session_never_registered_is_never_announced() {
        // Closed by its reader before registration: JS never heard of it,
        // so it gets no deckDisconnected either.
        FakeHooks h = new FakeHooks();
        SessionRegistry<FakeSession> r = newRegistry(h);
        FakeSession s = new FakeSession();
        assertTrue(r.reserve("/dev/bus/usb/001/002"));
        s.open = false;
        r.unregister("/dev/bus/usb/001/002", s, "usb_request_queue_failed");
        assertFalse(r.register("/dev/bus/usb/001/002", "SN1", s));
        assertTrue(h.events.isEmpty());
    }

    @Test
    public void stale_session_close_announces_nothing() {
        FakeHooks h = new FakeHooks();
        SessionRegistry<FakeSession> r = newRegistry(h);
        attach(r, "/dev/bus/usb/001/002", "SN1", new FakeSession());
        r.unregister("/dev/bus/usb/001/002", new FakeSession(), "usb_lost");
        assertEquals(List.of("connected:registered"), h.events);
    }
}
