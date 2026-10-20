package ca.erplibre.home.streamdeck;

import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Which decks a restartSessions reopens once their close ends, free of
 * Android types so JUnit covers it.
 *
 * restartSessions marks the devices it closes with begin(), waits for the
 * closes up to a bound, then calls endWait(). The restart reopens itself
 * every deck whose close ended within the wait (see ReattachPlan). A close
 * still running at endWait() keeps its session registered, so the restart
 * cannot reopen that deck, and a close by the owner schedules no retry
 * (see ReattachPolicy): such a device is late, and closed() answers true
 * for it once, when its close ends, for the CloseListener to reopen it.
 * forget() and clear() drop the marks of a device unplugged, once its
 * detach debounce expires without an attach, and of a plugin being
 * destroyed. Every method holds the instance monitor:
 * sessions close on their own threads.
 */
final class RestartReopen {

    private enum State { WAITING, CLOSED, LATE }

    private final Map<String, State> states = new HashMap<>();

    /** A restart is about to close the sessions of {@code names}. */
    synchronized void begin(Collection<String> names) {
        for (String n : names) states.put(n, State.WAITING);
    }

    /**
     * The session of {@code name} closed. True when the caller reopens the
     * deck now: a restart marked it and stopped waiting for its close.
     */
    synchronized boolean closed(String name) {
        State s = states.get(name);
        if (s == null) return false;
        if (s == State.LATE) {
            states.remove(name);
            return true;
        }
        states.put(name, State.CLOSED);
        return false;
    }

    /**
     * The restart stopped waiting for {@code names}. Returns those whose
     * close has not ended, which closed() reopens from then on; the others
     * are forgotten.
     */
    synchronized Set<String> endWait(Collection<String> names) {
        Set<String> late = new HashSet<>();
        for (String n : names) {
            State s = states.get(n);
            if (s == State.WAITING) {
                states.put(n, State.LATE);
                late.add(n);
            } else if (s == State.CLOSED) {
                states.remove(n);
            }
        }
        return late;
    }

    /** No reopen for {@code name}: unplugged. */
    synchronized void forget(String name) {
        states.remove(name);
    }

    /** No reopen for any device: the plugin is being destroyed. */
    synchronized void clear() {
        states.clear();
    }
}
