package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

public class WriterStepTest {

    /** Records the close requests the writer would make on its session. */
    static final class FakeOwner implements WriterStep.Owner {
        final List<String> closes = new ArrayList<>();
        @Override public void closeAfterWriteFailure(String reason) { closes.add(reason); }
    }

    /** A job whose transfer fails the way writePages reports it. */
    static final class FailingTransferJob extends WriteJob {
        @Override public String slotKey() { return "key:0"; }
        @Override public void resolveDropped() {}
        @Override public void runTransport() throws DeckSession.DeckIoException {
            throw new DeckSession.DeckIoException("bulk_write_short:-1/1024");
        }
    }

    /** A job that settled its Promise itself: rejected input or success. */
    static final class SettledJob extends WriteJob {
        boolean ran = false;
        @Override public String slotKey() { return "key:1"; }
        @Override public void resolveDropped() {}
        @Override public void runTransport() { ran = true; }
    }

    @Test
    public void one_failed_transfer_keeps_the_session_open() {
        // bulkTransfer answers -1 to a timeout as to a gone pipe: a single
        // stall of the firmware must not tear the session down.
        FakeOwner owner = new FakeOwner();
        WriterStep step = new WriterStep(owner);
        assertTrue(step.run(new FailingTransferJob()));
        assertTrue(owner.closes.isEmpty());
    }

    @Test
    public void consecutive_failed_transfers_close_the_session_as_usb_lost() {
        FakeOwner owner = new FakeOwner();
        WriterStep step = new WriterStep(owner);
        for (int i = 1; i < WriterStep.FAILURES_TO_CLOSE; i++) {
            assertTrue(step.run(new FailingTransferJob()));
        }
        assertFalse(step.run(new FailingTransferJob()));
        assertEquals(1, owner.closes.size());
        // The spec's reason, with the transfer detail the journal shows.
        assertEquals("usb_lost:bulk_write_short:-1/1024", owner.closes.get(0));
    }

    @Test
    public void a_transfer_that_goes_through_resets_the_count() {
        FakeOwner owner = new FakeOwner();
        WriterStep step = new WriterStep(owner);
        for (int round = 0; round < 3; round++) {
            for (int i = 1; i < WriterStep.FAILURES_TO_CLOSE; i++) {
                assertTrue(step.run(new FailingTransferJob()));
            }
            assertTrue(step.run(new SettledJob()));
        }
        assertTrue(owner.closes.isEmpty());
    }

    @Test
    public void settled_job_keeps_the_session_open() {
        FakeOwner owner = new FakeOwner();
        SettledJob job = new SettledJob();
        assertTrue(new WriterStep(owner).run(job));
        assertTrue(job.ran);
        assertTrue(owner.closes.isEmpty());
    }
}
