package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class DeckOpenThreadTest {

    /** The thread {@code executor} runs a task on. */
    private static Thread threadOf(Executor executor) throws InterruptedException {
        AtomicReference<Thread> ran = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        executor.execute(() -> {
            ran.set(Thread.currentThread());
            done.countDown();
        });
        assertTrue(done.await(2, TimeUnit.SECONDS));
        return ran.get();
    }

    @Test
    public void a_permission_held_already_opens_on_a_caller_off_the_main_thread() throws Exception {
        // retryAttach and restartSessions run off the main thread and
        // resolve once the decks they attach are registered.
        assertSame(Thread.currentThread(), threadOf(DeckOpenThread.choose(true, false)));
    }

    @Test
    public void a_permission_held_already_never_opens_on_the_main_thread() throws Exception {
        // The hotplug receiver runs on the main thread; with "always open"
        // ticked the permission is held before it gets the broadcast.
        Thread t = threadOf(DeckOpenThread.choose(true, true));
        assertNotSame(Thread.currentThread(), t);
        assertEquals(DeckOpenThread.NAME, t.getName());
        assertTrue(t.isDaemon());
    }

    @Test
    public void a_permission_granted_later_opens_on_a_thread_of_its_own() throws Exception {
        assertNotSame(Thread.currentThread(), threadOf(DeckOpenThread.choose(false, false)));
        assertNotSame(Thread.currentThread(), threadOf(DeckOpenThread.choose(false, true)));
    }

    @Test
    public void the_thread_that_completes_the_permission_does_not_run_the_open() throws Exception {
        // The permission poll completes a waiting request; the open must not
        // hold the poll, which serves every other deck's request.
        CompletableFuture<Boolean> permitted = new CompletableFuture<>();
        AtomicReference<Thread> opened = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        permitted.whenCompleteAsync((granted, err) -> {
            opened.set(Thread.currentThread());
            done.countDown();
        }, DeckOpenThread.choose(permitted.isDone(), false));
        Thread poll = new Thread(() -> permitted.complete(true), "poll");
        poll.start();
        poll.join();
        assertTrue(done.await(2, TimeUnit.SECONDS));
        assertNotSame(poll, opened.get());
        assertEquals(DeckOpenThread.NAME, opened.get().getName());
    }
}
