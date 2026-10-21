package ca.erplibre.home.streamdeck.usb;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

public class PermissionWaitsTest {

    private static final String DEV = "/dev/bus/usb/001/002";
    private static final String KEY = "4057:128:" + DEV;
    private static final long TIMEOUT = 30_000L;

    /** Devices are their names; a device is permitted once listed. */
    private final Set<String> permitted = new HashSet<>();
    private long now = 1_000L;
    private final PermissionWaits<String> waits =
        new PermissionWaits<>(permitted::contains, () -> now, TIMEOUT);

    private static Throwable failureOf(CompletableFuture<Boolean> f) {
        try {
            f.get();
            fail("expected a failed future");
            return null;
        } catch (ExecutionException e) {
            return e.getCause();
        } catch (InterruptedException e) {
            throw new AssertionError(e);
        }
    }

    // ── ask: the explicit request ───────────────────────────────────────

    @Test
    public void ask_on_a_permitted_device_shows_no_dialog() {
        permitted.add(DEV);
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        assertFalse(t.showDialog);
        assertTrue(t.future.join());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void ask_shows_the_dialog_once_and_joins_the_second_caller() {
        PermissionWaits.Ticket first = waits.ask(KEY, DEV);
        PermissionWaits.Ticket second = waits.ask(KEY, DEV);
        assertTrue(first.showDialog);
        assertFalse(second.showDialog);
        assertSame(first.future, second.future);
    }

    @Test
    public void the_dialog_broadcast_completes_an_asked_entry() {
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        assertTrue(waits.answered(KEY, true));
        assertTrue(t.future.join());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void a_refusal_completes_an_asked_entry_false() {
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        waits.answered(KEY, false);
        assertFalse(t.future.join());
    }

    @Test
    public void a_refusal_is_overruled_when_the_device_has_permission() {
        // The broadcast of a dialog left behind another one that granted.
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        permitted.add(DEV);
        waits.answered(KEY, false);
        assertTrue(t.future.join());
    }

    @Test
    public void a_broadcast_for_no_entry_is_ignored() {
        assertFalse(waits.answered(KEY, false));
    }

    @Test
    public void a_dialog_that_could_not_be_shown_completes_false() {
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        waits.failed(KEY);
        assertFalse(t.future.join());
        assertTrue(waits.isEmpty());
    }

    // ── a grant from any path ───────────────────────────────────────────

    @Test
    public void recheck_completes_an_asked_entry_granted_by_another_path() {
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        assertEquals(0, waits.recheck());
        assertFalse(t.future.isDone());
        permitted.add(DEV);  // the system's confirmation, accepted
        assertEquals(1, waits.recheck());
        assertTrue(t.future.join());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void recheck_completes_only_the_permitted_devices() {
        String other = "/dev/bus/usb/001/003";
        PermissionWaits.Ticket a = waits.ask(KEY, DEV);
        PermissionWaits.Ticket b = waits.ask("4057:128:" + other, other);
        permitted.add(other);
        assertEquals(1, waits.recheck());
        assertFalse(a.future.isDone());
        assertTrue(b.future.join());
    }

    // ── await: no dialog, a grant from the system path ──────────────────

    @Test
    public void await_on_a_permitted_device_completes_at_once() {
        permitted.add(DEV);
        assertTrue(waits.await(KEY, DEV).join());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void await_completes_once_the_system_grants() {
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        assertFalse(f.isDone());
        permitted.add(DEV);
        waits.recheck();
        assertTrue(f.join());
    }

    @Test
    public void a_refusal_broadcast_leaves_an_awaited_entry_waiting() {
        // A dialog shown for an older request reports on the same device.
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        waits.answered(KEY, false);
        assertFalse(f.isDone());
    }

    @Test
    public void ask_after_await_shows_the_dialog_on_the_same_future() {
        CompletableFuture<Boolean> awaited = waits.await(KEY, DEV);
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        assertTrue(t.showDialog);
        assertSame(awaited, t.future);
        waits.answered(KEY, true);
        assertTrue(awaited.join());
    }

    @Test
    public void await_after_ask_joins_without_a_dialog() {
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        assertSame(t.future, waits.await(KEY, DEV));
    }

    // ── deadlines ───────────────────────────────────────────────────────

    @Test
    public void an_asked_entry_times_out_as_permission_timeout() {
        PermissionWaits.Ticket t = waits.ask(KEY, DEV);
        now += TIMEOUT - 1;
        assertEquals(0, waits.expire());
        now += 1;
        assertEquals(1, waits.expire());
        Throwable cause = failureOf(t.future);
        assertTrue(cause instanceof PermissionTimeoutException);
        assertEquals(PermissionTimeoutException.TIMEOUT, cause.getMessage());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void an_awaited_entry_expires_as_permission_missing() {
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        now += TIMEOUT;
        waits.expire();
        Throwable cause = failureOf(f);
        assertTrue(cause instanceof PermissionTimeoutException);
        assertEquals(PermissionTimeoutException.MISSING, cause.getMessage());
    }

    @Test
    public void asking_restarts_the_deadline_of_an_awaited_entry() {
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        now += TIMEOUT - 1_000L;
        waits.ask(KEY, DEV);
        now += 1_000L;
        assertEquals(0, waits.expire());
        assertFalse(f.isDone());
        now += TIMEOUT;
        waits.expire();
        assertEquals(PermissionTimeoutException.TIMEOUT, failureOf(f).getMessage());
    }

    @Test
    public void a_new_request_after_a_timeout_shows_the_dialog_again() {
        waits.ask(KEY, DEV);
        now += TIMEOUT;
        waits.expire();
        assertTrue(waits.ask(KEY, DEV).showDialog);
    }

    // ── the device leaves ───────────────────────────────────────────────

    @Test
    public void forgetting_a_device_ends_its_wait_as_detached() {
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        assertTrue(waits.forget(KEY));
        Throwable cause = failureOf(f);
        assertTrue(cause instanceof DeviceDetachedException);
        assertEquals(DeviceDetachedException.REASON, cause.getMessage());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void a_forgotten_wait_never_expires_as_permission_missing() {
        // Unplugged during the wait: the deadline must not report later on
        // a deck that is gone.
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        waits.forget(KEY);
        now += TIMEOUT;
        assertEquals(0, waits.expire());
        assertTrue(failureOf(f) instanceof DeviceDetachedException);
    }

    @Test
    public void a_device_back_under_the_same_name_gets_a_future_of_its_own() {
        // Two attaches sharing one future would both open the device on
        // the grant, and one would steal the interface from the other.
        CompletableFuture<Boolean> before = waits.await(KEY, DEV);
        waits.forget(KEY);
        CompletableFuture<Boolean> after = waits.await(KEY, DEV);
        assertNotSame(before, after);
        assertFalse(after.isDone());
    }

    @Test
    public void forgetting_a_device_with_no_wait_does_nothing() {
        assertFalse(waits.forget(KEY));
    }

    // ── shutdown ────────────────────────────────────────────────────────

    @Test
    public void cancel_all_completes_every_entry_false() {
        CompletableFuture<Boolean> a = waits.await(KEY, DEV);
        PermissionWaits.Ticket b = waits.ask("4057:128:/dev/bus/usb/001/003",
            "/dev/bus/usb/001/003");
        waits.cancelAll();
        assertFalse(a.join());
        assertFalse(b.future.join());
        assertTrue(waits.isEmpty());
    }

    @Test
    public void a_completion_runs_its_dependents_outside_the_monitor() throws Exception {
        // A dependent that asks again from another thread must not block on
        // the monitor of the call that completed it.
        CompletableFuture<Boolean> f = waits.await(KEY, DEV);
        CompletableFuture<Boolean> reentered = new CompletableFuture<>();
        f.thenRun(() -> {
            Thread t = new Thread(() -> reentered.complete(waits.isEmpty()));
            t.start();
            try { t.join(2_000L); } catch (InterruptedException ignored) { }
        });
        permitted.add(DEV);
        waits.recheck();
        assertTrue(reentered.isDone());
        assertTrue(reentered.get());
    }
}
