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
}
