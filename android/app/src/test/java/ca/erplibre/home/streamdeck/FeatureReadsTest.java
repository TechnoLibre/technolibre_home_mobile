package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class FeatureReadsTest {

    /** Answers each report ID from a script: a byte[] is copied into the
     *  caller's buffer, an Integer is returned as is (a failure). The last
     *  entry of a script repeats. Records every call. */
    private static final class FakeEp0 implements FeatureReads.Ep0 {
        final Map<Integer, Deque<Object>> scripts = new HashMap<>();
        Object descriptor = -1;
        final List<String> calls = new ArrayList<>();

        FakeEp0 on(int reportId, Object... answers) {
            Deque<Object> d = new ArrayDeque<>();
            for (Object a : answers) d.add(a);
            scripts.put(reportId, d);
            return this;
        }

        @Override public int getFeature(int reportId, byte[] buf, int timeoutMs) {
            calls.add("feature " + reportId + " " + timeoutMs);
            Deque<Object> d = scripts.get(reportId);
            if (d == null) return -1;
            Object a = d.size() > 1 ? d.poll() : d.peek();
            return answer(a, buf);
        }

        @Override public int getDeviceDescriptor(byte[] buf, int timeoutMs) {
            calls.add("descriptor " + timeoutMs);
            return answer(descriptor, buf);
        }

        private static int answer(Object a, byte[] buf) {
            if (a instanceof RuntimeException) throw (RuntimeException) a;
            if (a instanceof Integer) return (Integer) a;
            byte[] bytes = (byte[]) a;
            System.arraycopy(bytes, 0, buf, 0, bytes.length);
            return bytes.length;
        }
    }

    private final List<Long> pauses = new ArrayList<>();
    private final FeatureReads.Pause pause = pauses::add;

    /** A V2 feature report: the header bytes, then the text, then zeros. */
    private static byte[] report(int headerLen, String text) {
        byte[] out = new byte[32];
        byte[] t = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(t, 0, out, headerLen, t.length);
        out[0] = 0x06;
        return out;
    }

    @Test
    public void a_deck_that_answers_gives_firmware_then_serial() {
        FakeEp0 ep0 = new FakeEp0()
            .on(0x05, report(6, "1.01.000"))
            .on(0x06, report(2, "SERIAL0001"));
        FeatureReads.Result r = FeatureReads.read(true, ep0, pause);
        assertTrue(r.controlPipeOk);
        assertEquals("1.01.000", r.firmware);
        assertEquals("SERIAL0001", r.serial);
        // The firmware read is the probe, short; the serial read has the
        // ordinary timeout. No pause, no descriptor probe.
        assertEquals(List.of(
            "feature 5 " + FeatureReads.PROBE_TIMEOUT_MS,
            "feature 6 " + FeatureReads.READ_TIMEOUT_MS), ep0.calls);
        assertTrue(pauses.isEmpty());
    }

    @Test
    public void v1_reads_its_own_report_ids_and_headers() {
        FakeEp0 ep0 = new FakeEp0()
            .on(0x04, report(5, "2.00"))
            .on(0x03, report(5, "OLDSERIAL"));
        FeatureReads.Result r = FeatureReads.read(false, ep0, pause);
        assertEquals("2.00", r.firmware);
        assertEquals("OLDSERIAL", r.serial);
    }

    @Test
    public void one_failed_probe_is_retried_after_a_pause() {
        FakeEp0 ep0 = new FakeEp0()
            .on(0x05, -1, report(6, "1.01.000"))
            .on(0x06, report(2, "SERIAL0001"));
        FeatureReads.Result r = FeatureReads.read(true, ep0, pause);
        assertTrue(r.controlPipeOk);
        assertEquals("1.01.000", r.firmware);
        assertEquals("SERIAL0001", r.serial);
        assertEquals(List.of(FeatureReads.RETRY_PAUSE_MS), pauses);
    }

    @Test
    public void a_pipe_that_fails_both_probes_is_down_and_skips_the_serial() {
        FakeEp0 ep0 = new FakeEp0().on(0x05, -1).on(0x06, report(2, "never"));
        ep0.descriptor = new byte[18];
        FeatureReads.Result r = FeatureReads.read(true, ep0, pause);
        assertFalse(r.controlPipeOk);
        assertNull(r.firmware);
        assertNull(r.serial);
        assertTrue(r.standardRequestsAnswer);
        assertEquals(List.of(
            "feature 5 " + FeatureReads.PROBE_TIMEOUT_MS,
            "feature 5 " + FeatureReads.PROBE_TIMEOUT_MS,
            "descriptor " + FeatureReads.DESCRIPTOR_TIMEOUT_MS), ep0.calls);
    }

    @Test
    public void a_down_pipe_costs_well_under_the_two_ordinary_timeouts() {
        // Worst case of a down pipe: two probes, the pause, the descriptor.
        long worst = 2L * FeatureReads.PROBE_TIMEOUT_MS + FeatureReads.RETRY_PAUSE_MS
            + FeatureReads.DESCRIPTOR_TIMEOUT_MS;
        assertTrue(worst < 2L * FeatureReads.READ_TIMEOUT_MS);
    }

    @Test
    public void a_dead_default_pipe_fails_the_descriptor_too() {
        FakeEp0 ep0 = new FakeEp0().on(0x05, -1);
        FeatureReads.Result r = FeatureReads.read(true, ep0, pause);
        assertFalse(r.controlPipeOk);
        assertFalse(r.standardRequestsAnswer);
    }

    @Test
    public void a_failed_serial_keeps_the_firmware() {
        FakeEp0 ep0 = new FakeEp0().on(0x05, report(6, "1.01.000")).on(0x06, -1);
        FeatureReads.Result r = FeatureReads.read(true, ep0, pause);
        assertTrue(r.controlPipeOk);
        assertEquals("1.01.000", r.firmware);
        assertNull(r.serial);
    }

    @Test
    public void an_empty_serial_counts_as_unread() {
        FakeEp0 ep0 = new FakeEp0().on(0x05, report(6, "1.01.000")).on(0x06, report(2, ""));
        assertNull(FeatureReads.read(true, ep0, pause).serial);
    }

    @Test
    public void a_transfer_that_throws_is_a_failure() {
        FakeEp0 ep0 = new FakeEp0()
            .on(0x05, new IllegalStateException("closed"))
            .on(0x06, report(2, "never"));
        FeatureReads.Result r = FeatureReads.read(true, ep0, pause);
        assertFalse(r.controlPipeOk);
    }

    @Test
    public void an_interrupted_pause_gives_up_and_keeps_the_interrupt() {
        FakeEp0 ep0 = new FakeEp0().on(0x05, -1, report(6, "1.01.000"));
        FeatureReads.Result r = FeatureReads.read(true, ep0, ms -> {
            throw new InterruptedException();
        });
        try {
            assertFalse(r.controlPipeOk);
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    public void ascii_stops_at_nul_and_skips_unprintable_bytes() {
        byte[] buf = {0x05, 0, 0, 0, 0, 0, '1', 0x01, '.', '0', 0, 'x'};
        assertEquals("1.0", FeatureReads.ascii(buf, 6, buf.length));
        // Never past what the transfer returned.
        assertEquals("1", FeatureReads.ascii(buf, 6, 7));
    }
}
