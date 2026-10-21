package ca.erplibre.home.streamdeck;

import java.util.concurrent.Executor;

/**
 * The thread an attach opens its deck on, once its permission is held.
 * Opening makes EP0 transfers of up to a second each, so it never runs on
 * the main thread, nor on the thread that completes a permission request:
 * the permission poll serves every deck's request and must not wait for
 * one deck's open, and the dialog's broadcast arrives on the main thread.
 *
 * A permission already held when the attach starts opens on the caller,
 * unless the caller is the main thread: retryAttach and restartSessions
 * then resolve with their decks registered. Any other case opens on a new
 * daemon thread named {@link #NAME}.
 */
final class DeckOpenThread {

    static final String NAME = "deck-open";

    private DeckOpenThread() { }

    /** The executor for an attach whose permission future was
     *  {@code permissionDone} when it started, on the main thread or not. */
    static Executor choose(boolean permissionDone, boolean onMainThread) {
        if (permissionDone && !onMainThread) return Runnable::run;
        return task -> start(NAME, task);
    }

    /** {@code task} on a new daemon thread named {@code name}. */
    static void start(String name, Runnable task) {
        Thread t = new Thread(task, name);
        t.setDaemon(true);
        t.start();
    }
}
