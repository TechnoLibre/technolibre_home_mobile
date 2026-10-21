package ca.erplibre.home.streamdeck.usb;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The USB permission requests in flight, one per device key, free of
 * Android types and driven by an injected clock so JUnit covers them.
 *
 * Two kinds of entry share one future per device. {@link #ask} is the
 * explicit request: its ticket tells the caller to show the system
 * permission dialog, once per entry. {@link #await} shows nothing: it waits
 * for a grant from another path, such as the system's own confirmation
 * raised by the manifest's USB_DEVICE_ATTACHED filter, which grants the
 * permission when accepted. Asking for a device that is only awaited turns
 * the entry into an asked one and shows the dialog, so an explicit request
 * always gets its dialog.
 *
 * Whatever path grants the permission, {@link #recheck} completes the entry
 * true once {@link Facts#hasPermission} says so; the caller runs it on a
 * short poll, on the attach intent and on activity resume, so no request
 * waits for its deadline after a grant. {@link #answered} takes the
 * dialog's broadcast: a grant completes the entry, a refusal completes an
 * asked entry false unless the device holds the permission anyway, and
 * leaves an awaited one waiting. {@link #expire} fails an entry past its
 * deadline with a PermissionTimeoutException, TIMEOUT for an asked entry,
 * MISSING for an awaited one. {@link #forget} ends the entry of a device
 * unplugged meanwhile.
 *
 * An await relies on the system's confirmation, which the user can cancel
 * or dismiss; nothing then grants the permission. {@link #confirmGone}
 * ends such an entry as MISSING before its deadline once the owner knows
 * the confirmation is off the screen, and shows no dialog in its place:
 * the next one comes from a new plug or an explicit {@link #ask}.
 *
 * Every method holds the instance monitor; futures complete after it is
 * released, since a completion runs its synchronous dependents on the
 * calling thread.
 */
public final class PermissionWaits<D> {

    /** What the system says of one device right now. */
    public interface Facts<D> { boolean hasPermission(D device); }

    /** Monotonic milliseconds. */
    public interface Clock { long nowMs(); }

    /** The future of a request, and whether the caller shows the dialog. */
    public static final class Ticket {
        public final CompletableFuture<Boolean> future;
        public final boolean showDialog;

        Ticket(CompletableFuture<Boolean> future, boolean showDialog) {
            this.future = future;
            this.showDialog = showDialog;
        }
    }

    private static final class Entry<D> {
        final D device;
        final CompletableFuture<Boolean> future = new CompletableFuture<>();
        /** When the entry was created, by the injected clock. */
        final long started;
        boolean asked;
        long deadline;

        Entry(D device, boolean asked, long started, long deadline) {
            this.device = device;
            this.asked = asked;
            this.started = started;
            this.deadline = deadline;
        }
    }

    private final Facts<D> facts;
    private final Clock clock;
    private final long timeoutMs;
    private final Map<String, Entry<D>> pending = new HashMap<>();

    public PermissionWaits(Facts<D> facts, Clock clock, long timeoutMs) {
        this.facts = facts;
        this.clock = clock;
        this.timeoutMs = timeoutMs;
    }

    /**
     * The explicit request for {@code device}. Completed true without a
     * dialog when the device holds the permission; else the entry's future,
     * with showDialog true for the first ask of the entry only. Asking
     * gives the entry a full timeout from now.
     */
    public Ticket ask(String key, D device) {
        if (facts.hasPermission(device)) {
            return new Ticket(CompletableFuture.completedFuture(true), false);
        }
        synchronized (this) {
            long now = clock.nowMs();
            long deadline = now + timeoutMs;
            Entry<D> e = pending.get(key);
            if (e == null) {
                e = new Entry<>(device, true, now, deadline);
                pending.put(key, e);
                return new Ticket(e.future, true);
            }
            if (e.asked) return new Ticket(e.future, false);
            e.asked = true;
            e.deadline = deadline;
            return new Ticket(e.future, true);
        }
    }

    /**
     * A wait for the permission of {@code device} without a dialog:
     * completed true at once when it is held, else the entry's future,
     * shared with any ask on the same key.
     */
    public CompletableFuture<Boolean> await(String key, D device) {
        if (facts.hasPermission(device)) return CompletableFuture.completedFuture(true);
        synchronized (this) {
            Entry<D> e = pending.get(key);
            if (e == null) {
                long now = clock.nowMs();
                e = new Entry<>(device, false, now, now + timeoutMs);
                pending.put(key, e);
            }
            return e.future;
        }
    }

    /**
     * The dialog's broadcast for {@code key}. False when no entry waits on
     * it, as for a dialog whose request already ended.
     */
    public boolean answered(String key, boolean granted) {
        Entry<D> done;
        boolean result;
        synchronized (this) {
            Entry<D> e = pending.get(key);
            if (e == null) return false;
            result = granted || facts.hasPermission(e.device);
            if (!result && !e.asked) return true;
            pending.remove(key);
            done = e;
        }
        done.future.complete(result);
        return true;
    }

    /** The dialog for {@code key} could not be shown: completes it false. */
    public void failed(String key) {
        Entry<D> e;
        synchronized (this) { e = pending.remove(key); }
        if (e != null) e.future.complete(false);
    }

    /**
     * The device of {@code key} was unplugged: its entry ends with a
     * DeviceDetachedException, so it neither expires later nor shares its
     * future with a device that comes back under the same name. False when
     * no entry waits on it.
     */
    public boolean forget(String key) {
        Entry<D> e;
        synchronized (this) { e = pending.remove(key); }
        if (e == null) return false;
        e.future.completeExceptionally(new DeviceDetachedException());
        return true;
    }

    /** Completes true every entry whose device now holds the permission;
     *  returns how many. */
    public int recheck() {
        List<Entry<D>> done = new ArrayList<>();
        synchronized (this) {
            Iterator<Entry<D>> it = pending.values().iterator();
            while (it.hasNext()) {
                Entry<D> e = it.next();
                if (facts.hasPermission(e.device)) {
                    it.remove();
                    done.add(e);
                }
            }
        }
        for (Entry<D> e : done) e.future.complete(true);
        return done.size();
    }

    /**
     * The system's confirmation is off the screen for every await started
     * before {@code since}: answered or dismissed. Each such entry with no
     * dialog shown completes true when its device holds the permission,
     * else fails MISSING at once. An entry asked meanwhile waits for its
     * dialog's broadcast. Returns how many failed.
     */
    public int confirmGone(long since) {
        List<Entry<D>> granted = new ArrayList<>();
        List<Entry<D>> missing = new ArrayList<>();
        synchronized (this) {
            Iterator<Entry<D>> it = pending.values().iterator();
            while (it.hasNext()) {
                Entry<D> e = it.next();
                if (e.asked || e.started >= since) continue;
                it.remove();
                (facts.hasPermission(e.device) ? granted : missing).add(e);
            }
        }
        for (Entry<D> e : granted) e.future.complete(true);
        for (Entry<D> e : missing) {
            e.future.completeExceptionally(
                new PermissionTimeoutException(PermissionTimeoutException.MISSING));
        }
        return missing.size();
    }

    /** Fails every entry past its deadline; returns how many. */
    public int expire() {
        List<Entry<D>> done = new ArrayList<>();
        synchronized (this) {
            long now = clock.nowMs();
            Iterator<Entry<D>> it = pending.values().iterator();
            while (it.hasNext()) {
                Entry<D> e = it.next();
                if (now >= e.deadline) {
                    it.remove();
                    done.add(e);
                }
            }
        }
        for (Entry<D> e : done) {
            e.future.completeExceptionally(new PermissionTimeoutException(
                e.asked ? PermissionTimeoutException.TIMEOUT : PermissionTimeoutException.MISSING));
        }
        return done.size();
    }

    public synchronized boolean isEmpty() { return pending.isEmpty(); }

    /** Completes every entry false: the owner is going away. */
    public void cancelAll() {
        List<Entry<D>> done;
        synchronized (this) {
            done = new ArrayList<>(pending.values());
            pending.clear();
        }
        for (Entry<D> e : done) e.future.complete(false);
    }
}
