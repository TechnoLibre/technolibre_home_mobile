package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;

public class RequestReaderTest {

    /** Script entry: nothing completed within the wait. */
    static final Object TIMEOUT = new Object();
    /** Script entry: the session closes during this wait, which times out. */
    static final Object STOP = new Object();

    static final class FakeOwner implements RequestReader.Owner {
        boolean open = true;
        final List<byte[]> reports = new ArrayList<>();
        final List<Long> idleNotes = new ArrayList<>();
        @Override public boolean isOpen() { return open; }
        @Override public void onReport(byte[] data) { reports.add(data); }
        @Override public void onIdle(long msSinceData) { idleNotes.add(msSinceData); }
    }

    /**
     * One usbfs request as the kernel sees it: queued or not. It fails the
     * test on a second submit while queued and on a close while queued, the
     * two calls that hand the kernel a buffer nobody owns any more.
     */
    static class FakePipe implements RequestReader.Pipe {
        final FakeOwner owner;
        final Deque<Object> script = new ArrayDeque<>();
        final List<String> calls = new ArrayList<>();
        boolean queued = false;
        boolean cancelled = false;
        boolean submitAccepted = true;
        boolean reapsCancelled = true;
        long now = 0;
        long msPerWait = 250;

        FakePipe(FakeOwner owner, Object... steps) {
            this.owner = owner;
            Collections.addAll(script, steps);
        }

        @Override public boolean submit() {
            if (queued) throw new AssertionError("submit while a request is queued");
            calls.add("submit");
            if (!submitAccepted) return false;
            queued = true;
            cancelled = false;
            return true;
        }

        @Override public byte[] await(long ms) throws RequestReader.WaitFailed {
            calls.add("await");
            if (!queued) throw new AssertionError("await with nothing queued");
            now += msPerWait;
            if (cancelled) {
                if (!reapsCancelled) return null;
                queued = false;
                return new byte[0];
            }
            Object step = script.isEmpty() ? STOP : script.poll();
            if (step == STOP) { owner.open = false; return null; }
            if (step == TIMEOUT) return null;
            if (step instanceof RequestReader.WaitFailed) throw (RequestReader.WaitFailed) step;
            queued = false;
            return (byte[]) step;
        }

        @Override public void cancel() {
            calls.add("cancel");
            cancelled = true;
        }

        @Override public void close() {
            if (queued) throw new AssertionError("close while a request is queued");
            calls.add("close");
        }

        int count(String call) {
            int n = 0;
            for (String c : calls) if (c.equals(call)) n++;
            return n;
        }
    }

    static RequestReader reader(FakePipe pipe) {
        return new RequestReader(pipe, pipe.owner, () -> pipe.now);
    }

    static byte[] report(int... bytes) {
        byte[] b = new byte[bytes.length];
        for (int i = 0; i < bytes.length; i++) b[i] = (byte) bytes[i];
        return b;
    }

    @Test
    public void timeouts_keep_waiting_on_the_same_request() {
        // An idle deck sends nothing: a timed-out wait leaves the request
        // queued, so the next wait is on it, with no cancel and no submit.
        FakeOwner owner = new FakeOwner();
        FakePipe pipe = new FakePipe(owner, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, STOP);
        assertNull(reader(pipe).run());
        assertEquals(1, pipe.count("submit"));
        assertEquals(1, pipe.count("cancel"));
        // The only cancel is the one of the exit path, after the five waits.
        assertEquals(5, pipe.calls.indexOf("cancel") - 1);
    }

    @Test
    public void each_report_is_delivered_then_the_request_queued_again() {
        FakeOwner owner = new FakeOwner();
        byte[] down = report(0x01, 0x00, 0x0f, 0x00, 0, 0, 0, 0, 0, 1);
        byte[] up = report(0x01, 0x00, 0x0f, 0x00, 0, 0, 0, 0, 0, 0);
        FakePipe pipe = new FakePipe(owner, TIMEOUT, down, TIMEOUT, up, STOP);
        assertNull(reader(pipe).run());
        assertEquals(2, owner.reports.size());
        assertArrayEquals(down, owner.reports.get(0));
        assertArrayEquals(up, owner.reports.get(1));
        assertEquals(3, pipe.count("submit"));
    }

    @Test
    public void an_empty_completion_is_queued_again_without_a_report() {
        FakeOwner owner = new FakeOwner();
        FakePipe pipe = new FakePipe(owner, new byte[0], STOP);
        assertNull(reader(pipe).run());
        assertTrue(owner.reports.isEmpty());
        assertEquals(2, pipe.count("submit"));
    }

    @Test
    public void exit_cancels_and_reaps_the_queued_request_before_closing_it() {
        FakeOwner owner = new FakeOwner();
        FakePipe pipe = new FakePipe(owner, STOP);
        RequestReader r = reader(pipe);
        assertNull(r.run());
        int n = pipe.calls.size();
        assertEquals(List.of("cancel", "await", "close"), pipe.calls.subList(n - 3, n));
        assertFalse(r.leftQueued());
    }

    @Test
    public void exit_after_a_completion_closes_without_cancelling() {
        FakeOwner owner = new FakeOwner();
        // The completion comes back while the session is closing.
        FakePipe closing = new FakePipe(owner) {
            @Override public byte[] await(long ms) throws RequestReader.WaitFailed {
                byte[] got = super.await(ms);
                owner.open = false;
                return got;
            }
        };
        closing.script.add(report(0x01, 0x00));
        RequestReader r = reader(closing);
        assertNull(r.run());
        assertEquals(0, closing.count("cancel"));
        assertEquals(1, closing.count("close"));
        // A report reaped after close started is not delivered.
        assertTrue(owner.reports.isEmpty());
    }

    @Test
    public void a_cancelled_request_never_reaped_is_left_unclosed() {
        FakeOwner owner = new FakeOwner();
        FakePipe pipe = new FakePipe(owner, STOP);
        pipe.reapsCancelled = false;
        RequestReader r = reader(pipe);
        assertNull(r.run());
        assertEquals(0, pipe.count("close"));
        assertTrue(r.leftQueued());
        // Bounded: the stop wait plus DRAIN_WAITS.
        assertEquals(1 + RequestReader.DRAIN_WAITS, pipe.count("await"));
    }

    @Test
    public void a_refused_submit_ends_the_reader_with_its_reason() {
        FakeOwner owner = new FakeOwner();
        FakePipe pipe = new FakePipe(owner);
        pipe.submitAccepted = false;
        RequestReader r = reader(pipe);
        assertEquals(RequestReader.QUEUE_FAILED, r.run());
        assertEquals(1, pipe.count("close"));
        assertEquals(0, pipe.count("cancel"));
        assertFalse(r.leftQueued());
    }

    @Test
    public void failed_waits_in_a_row_end_the_reader() {
        FakeOwner owner = new FakeOwner();
        Object[] steps = new Object[RequestReader.WAIT_FAILURES_TO_CLOSE];
        for (int i = 0; i < steps.length; i++) steps[i] = new RequestReader.WaitFailed("x");
        FakePipe pipe = new FakePipe(owner, steps);
        assertEquals(RequestReader.WAIT_FAILED + ":x", reader(pipe).run());
        assertEquals(1, pipe.count("submit"));
    }

    @Test
    public void a_completed_wait_resets_the_failure_count() {
        FakeOwner owner = new FakeOwner();
        List<Object> steps = new ArrayList<>();
        for (int round = 0; round < 3; round++) {
            for (int i = 1; i < RequestReader.WAIT_FAILURES_TO_CLOSE; i++) {
                steps.add(new RequestReader.WaitFailed("x"));
            }
            steps.add(TIMEOUT);
        }
        steps.add(STOP);
        FakePipe pipe = new FakePipe(owner, steps.toArray());
        assertNull(reader(pipe).run());
    }

    @Test
    public void the_idle_note_comes_once_per_period() {
        FakeOwner owner = new FakeOwner();
        int waits = (int) (2 * RequestReader.IDLE_NOTE_MS / 250) + 1;
        Object[] steps = new Object[waits];
        java.util.Arrays.fill(steps, TIMEOUT);
        FakePipe pipe = new FakePipe(owner, steps);
        reader(pipe).run();
        assertEquals(2, owner.idleNotes.size());
        assertEquals(RequestReader.IDLE_NOTE_MS, (long) owner.idleNotes.get(0));
        assertEquals(2 * RequestReader.IDLE_NOTE_MS, (long) owner.idleNotes.get(1));
    }
}
