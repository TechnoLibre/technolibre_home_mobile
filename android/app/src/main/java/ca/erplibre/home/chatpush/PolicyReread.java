package ca.erplibre.home.chatpush;

import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

/**
 * Ties each re-read of the level by the permanent service to the start id
 * current when the re-read was asked, not when it ends. A re-read can block
 * on the network; a start delivered meanwhile has a newer id, and
 * Service.stopSelfResult refuses an older one, so that start is never lost.
 */
public final class PolicyReread {

    private volatile int lastStartId;

    /** Records the id of the start onStartCommand just received. */
    public void started(int startId) {
        lastStartId = startId;
    }

    /**
     * A re-read bound to the latest start id now: when run, it calls stop
     * with that id if stillWanted says the level no longer wants the service.
     */
    public Runnable reread(BooleanSupplier stillWanted, IntConsumer stop) {
        final int id = lastStartId;
        return () -> {
            if (!stillWanted.getAsBoolean()) stop.accept(id);
        };
    }
}
