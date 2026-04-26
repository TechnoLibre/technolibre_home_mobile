package ca.erplibre.home.streamdeck;

/**
 * Abstract unit of work for the writer thread. Concrete subclasses know how to
 * resolve their TS Promise (success / dropped / failed) and how to perform the
 * actual USB transport write.
 */
public abstract class WriteJob {
    /** Coalescing key. Same slot → newer job replaces older one in the queue. */
    public abstract String slotKey();

    /** Called when the queue drops this job in favor of a newer one. */
    public abstract void resolveDropped();

    /** Called by the writer thread to execute the USB write and resolve the Promise. */
    public abstract void runTransport();
}
