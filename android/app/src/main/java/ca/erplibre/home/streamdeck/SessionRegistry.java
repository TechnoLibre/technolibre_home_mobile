package ca.erplibre.home.streamdeck;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The plugin's table of open sessions, keyed by USB device name (stable
 * while plugged in) and by serial number (the deckId JS sees).
 *
 * Generic in the session type and free of Android types so JUnit covers it
 * without a device. Every method holds the registry monitor, so the reader
 * thread of a session that closes itself and the main thread attaching a
 * device see one consistent table. No method calls back into a session
 * other than through {@link Hooks}, which keeps the lock order one-way.
 */
final class SessionRegistry<S> {

    /** What the registry needs to know about a session. */
    interface Hooks<S> {
        /** False once the session has started closing. */
        boolean isOpen(S session);
    }

    private static final class Entry<S> {
        final S session;
        final String serial;
        Entry(S session, String serial) { this.session = session; this.serial = serial; }
    }

    private final Hooks<S> hooks;
    private final Map<String, Entry<S>> byDevice = new HashMap<>();
    private final Map<String, S> bySerial = new HashMap<>();

    SessionRegistry(Hooks<S> hooks) { this.hooks = hooks; }

    /**
     * Index an opened session. Refused, and nothing is kept, when the
     * session already closed itself: its unregister ran before this call
     * and found nothing, so the entry would never be removed. A session
     * that closes after this call finds its entry and removes it.
     */
    synchronized boolean register(String deviceName, String serial, S session) {
        if (!hooks.isOpen(session)) return false;
        byDevice.put(deviceName, new Entry<>(session, serial));
        if (serial != null && !serial.isEmpty()) bySerial.put(serial, session);
        return true;
    }

    /**
     * Drop the entry of {@code session}. Only that exact instance is
     * removed: a stale session closing late leaves its successor on the
     * same device in place. True only for the call that removed it.
     */
    synchronized boolean unregister(String deviceName, S session) {
        Entry<S> e = byDevice.get(deviceName);
        if (e == null || e.session != session) return false;
        byDevice.remove(deviceName);
        if (e.serial != null && bySerial.get(e.serial) == session) bySerial.remove(e.serial);
        return true;
    }

    synchronized S byDevice(String deviceName) {
        Entry<S> e = byDevice.get(deviceName);
        return e != null ? e.session : null;
    }

    synchronized S bySerial(String serial) { return bySerial.get(serial); }

    synchronized boolean hasSession(String deviceName) { return byDevice.containsKey(deviceName); }

    synchronized boolean isEmpty() { return byDevice.isEmpty(); }

    /** Snapshot, safe to iterate while sessions close and unregister. */
    synchronized List<S> sessions() {
        List<S> out = new ArrayList<>(byDevice.size());
        for (Entry<S> e : byDevice.values()) out.add(e.session);
        return out;
    }
}
