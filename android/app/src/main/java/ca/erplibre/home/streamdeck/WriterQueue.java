package ca.erplibre.home.streamdeck;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;

/**
 * Bounded-by-coalescing queue of WriteJob. Offering a job whose slotKey matches
 * an already-queued job replaces the older one (which is resolved as dropped).
 *
 * Thread-safe: any number of producers, exactly one consumer (the writer thread).
 */
public final class WriterQueue {

    private final Deque<WriteJob> queue = new ArrayDeque<>();
    private final Map<String, WriteJob> latest = new HashMap<>();
    private boolean closed = false;

    public synchronized void offerCoalesce(WriteJob job) {
        if (closed) {
            job.resolveDropped();
            return;
        }
        WriteJob prev = latest.get(job.slotKey());
        if (prev != null) {
            queue.remove(prev);
            prev.resolveDropped();
        }
        queue.addLast(job);
        latest.put(job.slotKey(), job);
        notifyAll();
    }

    public synchronized WriteJob take() throws InterruptedException {
        while (queue.isEmpty() && !closed) wait();
        if (closed) throw new InterruptedException("queue closed");
        WriteJob job = queue.removeFirst();
        if (latest.get(job.slotKey()) == job) latest.remove(job.slotKey());
        return job;
    }

    public synchronized void closeAndDrainAsDropped() {
        closed = true;
        for (WriteJob j : queue) j.resolveDropped();
        queue.clear();
        latest.clear();
        notifyAll();
    }

    /** Drop every queued job without closing the queue. Used when the
     *  camera streamer ends and we don't want the writer thread to
     *  spend the next few hundred ms draining stale frames — that
     *  bulk-OUT pressure makes the deck firmware miss button presses
     *  long after the user expects the deck back to "Note". */
    public synchronized int dropPending() {
        int n = queue.size();
        for (WriteJob j : queue) j.resolveDropped();
        queue.clear();
        latest.clear();
        return n;
    }
}
