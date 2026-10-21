package ca.erplibre.home.streamdeck;

/**
 * How long the app has held the screen: resumed, its window focused, and
 * alone on the screen, all at once. Free of Android types, every method
 * holds the instance monitor, and times are the caller's monotonic
 * milliseconds.
 *
 * Android's USB confirmation is an activity of its own: while it is up
 * and the app fills the screen, the app is paused or its window has lost
 * focus, on a locked phone as after an unlock. A span that lasted
 * {@link #SETTLE_MS} therefore means that confirmation is gone, answered
 * or dismissed, for every wait started before the span began. The delay
 * covers the instants between an unlock, or a plug, and the confirmation
 * taking the focus. In multi-window mode the confirmation can sit in
 * another window, still answerable, while the app is resumed and focused:
 * a shared screen holds no span.
 */
final class FocusSpan {

    /** How long the span lasts before it says the confirmation is gone. */
    static final long SETTLE_MS = 1_000L;

    private boolean resumed;
    private boolean focused;
    private boolean shared;
    /** When resumed and focused both became true; -1 while either is not. */
    private long since = -1;

    /** The activity resumed (true) or paused (false) at {@code now}; true
     *  when this starts a span, which the caller checks SETTLE_MS later. */
    synchronized boolean resumed(boolean value, long now) {
        resumed = value;
        return update(now);
    }

    /** The window gained (true) or lost (false) the focus at {@code now};
     *  true when this starts a span. */
    synchronized boolean focused(boolean value, long now) {
        focused = value;
        return update(now);
    }

    /** The app's window shares the screen with others (true, multi-window
     *  mode) or fills it (false) at {@code now}; true when this starts a
     *  span. */
    synchronized boolean shared(boolean value, long now) {
        shared = value;
        return update(now);
    }

    /** The instant the current span began once it lasted SETTLE_MS by
     *  {@code now}; -1 with no span or a younger one. */
    synchronized long settledSince(long now) {
        return since >= 0 && now - since >= SETTLE_MS ? since : -1;
    }

    private boolean update(long now) {
        if (!(resumed && focused) || shared) {
            since = -1;
            return false;
        }
        if (since >= 0) return false;
        since = now;
        return true;
    }
}
