package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import ca.erplibre.home.streamdeck.ReattachPolicy.Decision;

public class ReattachPolicyTest {

    private static final String DEV = "/dev/bus/usb/001/002";
    private static final String READER = "polled_reset";
    private static final String WRITE = WriterStep.CLOSE_REASON + ":bulk_write_short:-1/1024";

    /** Clock the test moves by hand. */
    private static final class FakeClock implements ReattachPolicy.Clock {
        long now = 1_000_000L;
        @Override public long nowMs() { return now; }
        void advance(long ms) { now += ms; }
    }

    private final FakeClock clock = new FakeClock();
    private final ReattachPolicy policy = new ReattachPolicy(clock);

    private static void assertRetry(Decision d, long delayMs, int attempt) {
        assertEquals(Decision.Kind.RETRY, d.kind);
        assertEquals(delayMs, d.delayMs);
        assertEquals(attempt, d.attempt);
    }

    /** One retry that fires, reopens the deck, and closes again at once. */
    private Decision failAgain(Decision pending, String reason) {
        clock.advance(pending.delayMs);
        assertTrue(policy.due(DEV, pending.token));
        policy.registered(DEV);
        return policy.closed(DEV, reason);
    }

    @Test
    public void self_closed_session_is_retried_after_2_then_4_then_8_seconds() {
        Decision d = policy.closed(DEV, READER);
        assertRetry(d, 2_000L, 1);
        d = failAgain(d, READER);
        assertRetry(d, 4_000L, 2);
        d = failAgain(d, WRITE);
        assertRetry(d, 8_000L, 3);
    }

    @Test
    public void fourth_failure_gives_up_once_and_then_stays_silent() {
        Decision d = policy.closed(DEV, READER);
        d = failAgain(d, READER);
        d = failAgain(d, READER);
        d = failAgain(d, "usb_request_wait_threw:IOException");
        assertEquals(Decision.Kind.GIVE_UP, d.kind);
        assertEquals(3, d.attempt);
        assertEquals("usb_request_wait_threw:IOException", d.reason);
        // A later close of a deck opened by hand adds no second line.
        policy.registered(DEV);
        assertEquals(Decision.Kind.NONE, policy.closed(DEV, READER).kind);
    }

    @Test
    public void sixty_seconds_of_healthy_session_resets_the_count() {
        Decision d = policy.closed(DEV, READER);
        d = failAgain(d, READER);
        clock.advance(d.delayMs);
        assertTrue(policy.due(DEV, d.token));
        policy.registered(DEV);
        clock.advance(ReattachPolicy.HEALTHY_MS);
        assertRetry(policy.closed(DEV, READER), 2_000L, 1);
    }

    @Test
    public void a_session_closing_just_short_of_sixty_seconds_keeps_the_count() {
        Decision d = policy.closed(DEV, READER);
        clock.advance(d.delayMs);
        assertTrue(policy.due(DEV, d.token));
        policy.registered(DEV);
        clock.advance(ReattachPolicy.HEALTHY_MS - 1);
        assertRetry(policy.closed(DEV, READER), 4_000L, 2);
    }

    @Test
    public void healthy_session_after_giving_up_earns_a_fresh_budget() {
        Decision d = policy.closed(DEV, READER);
        d = failAgain(d, READER);
        d = failAgain(d, READER);
        d = failAgain(d, READER);
        assertEquals(Decision.Kind.GIVE_UP, d.kind);
        policy.registered(DEV);
        clock.advance(ReattachPolicy.HEALTHY_MS);
        assertRetry(policy.closed(DEV, READER), 2_000L, 1);
    }

    @Test
    public void close_by_the_owner_is_never_retried_and_cancels_the_pending_retry() {
        for (String owner : new String[] {"usb_lost", "restart_requested", "app_destroyed"}) {
            ReattachPolicy p = new ReattachPolicy(clock);
            Decision pending = p.closed(DEV, READER);
            assertEquals(owner, Decision.Kind.NONE, p.closed(DEV, owner).kind);
            assertFalse(owner, p.due(DEV, pending.token));
            // The count starts over on the next self-close.
            assertRetry(p.closed(DEV, READER), 2_000L, 1);
        }
    }

    @Test
    public void detach_cancels_the_pending_retry_and_forgets_the_count() {
        Decision d = policy.closed(DEV, READER);
        d = failAgain(d, READER);
        policy.forget(DEV);
        assertFalse(policy.due(DEV, d.token));
        assertRetry(policy.closed(DEV, READER), 2_000L, 1);
    }

    @Test
    public void nothing_is_retried_once_stopped() {
        Decision pending = policy.closed(DEV, READER);
        policy.stop();
        assertFalse(policy.due(DEV, pending.token));
        assertEquals(Decision.Kind.NONE, policy.closed(DEV, READER).kind);
        assertEquals(Decision.Kind.NONE, policy.attachFailed(DEV, "interface_busy").kind);
    }

    @Test
    public void a_retry_is_due_once_and_only_while_it_is_the_latest() {
        Decision first = policy.closed(DEV, READER);
        clock.advance(first.delayMs);
        assertTrue(policy.due(DEV, first.token));
        assertFalse(policy.due(DEV, first.token));

        Decision second = policy.closed(DEV, READER);
        Decision third = policy.closed(DEV, READER);
        assertFalse(policy.due(DEV, second.token));
        assertTrue(policy.due(DEV, third.token));
    }

    @Test
    public void a_deck_registered_by_another_attach_drops_the_pending_retry() {
        Decision pending = policy.closed(DEV, READER);
        policy.registered(DEV);
        assertFalse(policy.due(DEV, pending.token));
    }

    @Test
    public void a_failed_reopen_counts_as_an_attempt() {
        Decision d = policy.closed(DEV, READER);
        assertTrue(policy.due(DEV, d.token));
        d = policy.attachFailed(DEV, "interface_busy");
        assertRetry(d, 4_000L, 2);
        assertTrue(policy.due(DEV, d.token));
        d = policy.attachFailed(DEV, "interface_busy");
        assertRetry(d, 8_000L, 3);
        assertTrue(policy.due(DEV, d.token));
        d = policy.attachFailed(DEV, "interface_busy");
        assertEquals(Decision.Kind.GIVE_UP, d.kind);
        assertEquals("interface_busy", d.reason);
    }

    @Test
    public void attach_failure_outside_a_retry_is_not_retried() {
        // Hotplug or a manual attach that fails is reported as it was.
        assertEquals(Decision.Kind.NONE, policy.attachFailed(DEV, "permission_denied").kind);
    }

    @Test
    public void an_unknown_close_reason_neither_retries_nor_forgets() {
        Decision pending = policy.closed(DEV, READER);
        assertEquals(Decision.Kind.NONE, policy.closed(DEV, "open_failed").kind);
        assertTrue(policy.due(DEV, pending.token));
    }

    @Test
    public void forget_all_restores_the_budget_of_every_deck() {
        Decision d = policy.closed(DEV, READER);
        d = failAgain(d, READER);
        d = failAgain(d, READER);
        d = failAgain(d, READER);
        assertEquals(Decision.Kind.GIVE_UP, d.kind);
        policy.forgetAll();
        assertRetry(policy.closed(DEV, READER), 2_000L, 1);
    }

    @Test
    public void reader_and_write_failures_are_self_closes_the_owner_reasons_are_not() {
        assertTrue(ReattachPolicy.isSelfClose("polled_reset"));
        assertTrue(ReattachPolicy.isSelfClose("polled_threw:IOException"));
        assertTrue(ReattachPolicy.isSelfClose("usb_request_init_failed"));
        assertTrue(ReattachPolicy.isSelfClose("usb_request_queue_failed"));
        assertTrue(ReattachPolicy.isSelfClose("usb_request_wait_threw:IOException"));
        assertTrue(ReattachPolicy.isSelfClose("bulk_read_threw:IOException"));
        assertTrue(ReattachPolicy.isSelfClose(WRITE));
        assertFalse(ReattachPolicy.isSelfClose("usb_lost"));
        assertFalse(ReattachPolicy.isSelfClose("restart_requested"));
        assertFalse(ReattachPolicy.isSelfClose("app_destroyed"));
        assertFalse(ReattachPolicy.isSelfClose("open_failed"));
        assertFalse(ReattachPolicy.isSelfClose(null));
    }

    @Test
    public void decks_are_counted_apart() {
        String other = "/dev/bus/usb/001/003";
        Decision d = policy.closed(DEV, READER);
        failAgain(d, READER);
        assertRetry(policy.closed(other, READER), 2_000L, 1);
    }
}
