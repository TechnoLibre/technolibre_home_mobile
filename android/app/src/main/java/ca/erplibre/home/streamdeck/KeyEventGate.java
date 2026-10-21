package ca.erplibre.home.streamdeck;

import java.util.ArrayDeque;

/**
 * Holds key events while no JS key handler is subscribed, and delivers
 * them once one is. Closed, {@link #submit} keeps at most {@code maxHeld}
 * events, dropping the oldest. {@link #open} delivers the held events in
 * arrival order, except those older than {@code maxAgeMs}, then lets every
 * later event straight through; {@link #close} starts holding again. A
 * deck pressed for minutes while nothing listens thus replays only its
 * last few seconds, and since trimming takes from the front only, a
 * delivered press is always followed by its release.
 *
 * Every method holds the instance monitor, the sink calls included: an
 * event submitted while {@link #open} replays waits for the replay, so the
 * sink sees events in arrival order. The sink must not block. Free of
 * Android types.
 */
final class KeyEventGate<T> {

    /** Events held at most while closed. */
    static final int MAX_HELD = 16;
    /** Age past which a held event is dropped at open. */
    static final long MAX_AGE_MS = 10_000L;

    /** Receives each delivered event. */
    interface Sink<T> { void deliver(T event); }

    /** What one {@link #open} did with the held events. */
    static final class Release {
        final int delivered;
        /** Dropped past the bound since the last open, or too old. */
        final int dropped;
        Release(int delivered, int dropped) {
            this.delivered = delivered;
            this.dropped = dropped;
        }
    }

    private static final class Held<T> {
        final T event;
        final long atMs;
        Held(T event, long atMs) { this.event = event; this.atMs = atMs; }
    }

    private final Sink<T> sink;
    private final int maxHeld;
    private final long maxAgeMs;
    private final ArrayDeque<Held<T>> held = new ArrayDeque<>();
    private boolean open = false;
    private int droppedPastBound = 0;

    KeyEventGate(Sink<T> sink, int maxHeld, long maxAgeMs) {
        this.sink = sink;
        this.maxHeld = maxHeld;
        this.maxAgeMs = maxAgeMs;
    }

    /** Deliver {@code event} now when open; hold it, stamped
     *  {@code nowMs}, when closed. */
    synchronized void submit(T event, long nowMs) {
        if (open) {
            sink.deliver(event);
            return;
        }
        if (held.size() >= maxHeld) {
            held.pollFirst();
            droppedPastBound++;
        }
        held.addLast(new Held<>(event, nowMs));
    }

    /** Deliver the held events no older than maxAgeMs at {@code nowMs},
     *  oldest first, and let later events through. Delivers nothing more
     *  when already open. */
    synchronized Release open(long nowMs) {
        int delivered = 0;
        int dropped = droppedPastBound;
        droppedPastBound = 0;
        Held<T> h;
        while ((h = held.pollFirst()) != null) {
            if (nowMs - h.atMs > maxAgeMs) {
                dropped++;
                continue;
            }
            sink.deliver(h.event);
            delivered++;
        }
        open = true;
        return new Release(delivered, dropped);
    }

    /** Hold events again until the next {@link #open}. */
    synchronized void close() { open = false; }

    synchronized boolean isOpen() { return open; }
}
