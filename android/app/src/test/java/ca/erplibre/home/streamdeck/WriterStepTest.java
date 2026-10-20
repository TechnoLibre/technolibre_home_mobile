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
    public void failed_transfer_closes_the_session_as_usb_lost() {
        FakeOwner owner = new FakeOwner();
        assertFalse(WriterStep.run(new FailingTransferJob(), owner));
        assertEquals(1, owner.closes.size());
        // The spec's reason, with the transfer detail the journal shows.
        assertEquals("usb_lost:bulk_write_short:-1/1024", owner.closes.get(0));
    }

    @Test
    public void settled_job_keeps_the_session_open() {
        FakeOwner owner = new FakeOwner();
        SettledJob job = new SettledJob();
        assertTrue(WriterStep.run(job, owner));
        assertTrue(job.ran);
        assertTrue(owner.closes.isEmpty());
    }
}
