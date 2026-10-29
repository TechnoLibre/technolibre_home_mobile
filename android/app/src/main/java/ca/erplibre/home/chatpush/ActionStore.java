package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The durable record of every native action, one key "act:&lt;id&gt;" each, the whole record sealed by
 * SecretBox (the reply text inside). A write is durable when the method returns (KeyValue commits), so
 * an action exists before any network call. PENDING and RUNNING records belong to native code; DONE and
 * HANDOFF ones wait for the app's drain, which acks them. A claim stamps the claiming process: recover()
 * turns back to PENDING only the RUNNING records of a process that is gone, keeping their sentAt, so a
 * run still in flight is never started twice. A record whose seal no longer opens is skipped, and
 * prune() deletes it. Every transition runs under one lock shared by every store of the process.
 */
final class ActionStore {

    /** The wait after a send that may have reached Odoo before its marker is searched (the outbox's). */
    static final long QUIET_MS = 180_000;
    /** An action failing transiently for this long goes to the app. */
    static final long STALE_MS = 86_400_000;
    /** A DONE record the app never drained is forgotten after this long. */
    static final long PRUNE_MS = 7L * 24 * 60 * 60 * 1000;
    static final long FIRST_RETRY_MS = 30_000;
    static final long MAX_RETRY_MS = 3_600_000;

    private static final String PREFIX = "act:";
    private static final Object LOCK = new Object();
    private static final SecureRandom RANDOM = new SecureRandom();
    /** This process's identity, drawn once when the class loads. */
    private static final String PROCESS = drawProcess();

    private final KeyValue kv;
    private final SecretBox box;
    private final LongSupplier clock;
    private final Supplier<String> process;

    ActionStore(KeyValue kv, SecretBox box, LongSupplier clock) {
        this(kv, box, clock, () -> PROCESS);
    }

    /** `process` gives the identity a claim is stamped with. */
    ActionStore(KeyValue kv, SecretBox box, LongSupplier clock, Supplier<String> process) {
        this.kv = kv;
        this.box = box;
        this.clock = clock;
        this.process = process;
    }

    private static String drawProcess() {
        byte[] b = new byte[12];
        RANDOM.nextBytes(b);
        return B64.encode(b, true);
    }

    /**
     * Records a new PENDING action, due now, with a fresh client uuid (v4). A 👍 needs its message id.
     * IllegalStateException when the record cannot be sealed: nothing was stored.
     */
    ChatAction add(String configId, ActionKind k, long channelId, long messageId, long atMostS, String text) {
        if (k == ActionKind.REACT && messageId <= 0) throw new IllegalArgumentException("reaction without message");
        long now = clock.getAsLong();
        ChatAction a = new ChatAction(UUID.randomUUID().toString(), configId, UUID.randomUUID().toString(), k,
                channelId, messageId, atMostS, now, k == ActionKind.REPLY ? text : "",
                k == ActionKind.REACT ? "👍" : "");
        a.nextAt = now;
        synchronized (LOCK) {
            write(a);
        }
        return a;
    }

    /** The record, or null when absent or unreadable. */
    ChatAction get(String id) {
        synchronized (LOCK) {
            return read(PREFIX + id);
        }
    }

    /** PENDING → RUNNING, owned by this process; false when the record is absent or not PENDING. */
    boolean claim(String id) {
        synchronized (LOCK) {
            ChatAction a = read(PREFIX + id);
            if (a == null || a.state != ChatAction.State.PENDING) return false;
            a.state = ChatAction.State.RUNNING;
            a.owner = process.get();
            write(a);
            return true;
        }
    }

    /**
     * Stamps the send about to start: from now on Odoo may hold the message. `plain` is a send without the
     * module's uuid; once one went, plainSent stays true.
     */
    void markSent(String id, boolean plain) {
        update(id, a -> {
            a.sentAt = clock.getAsLong();
            if (plain) a.plainSent = true;
        });
    }

    /** DONE with Odoo's Store answer (null when none is kept). */
    void done(String id, String answer) {
        update(id, a -> {
            a.state = ChatAction.State.DONE;
            a.answer = answer;
            a.doneAt = clock.getAsLong();
            a.owner = null;
        });
    }

    /** Back to PENDING after a transient failure: due in 30 s × 2ⁿ (n failures before), at most an hour. */
    void retryLater(String id) {
        update(id, a -> {
            int n = Math.min(a.attempts, 7);
            a.nextAt = clock.getAsLong() + Math.min(FIRST_RETRY_MS << n, MAX_RETRY_MS);
            a.attempts++;
            a.state = ChatAction.State.PENDING;
            a.owner = null;
        });
    }

    /** Back to PENDING, due at `at`, without counting a failure. */
    void retryAt(String id, long at) {
        update(id, a -> {
            a.nextAt = at;
            a.state = ChatAction.State.PENDING;
            a.owner = null;
        });
    }

    /** HANDOFF to the app: session_expired, refused, ambiguous or stale. */
    void handoff(String id, String reason) {
        update(id, a -> {
            a.state = ChatAction.State.HANDOFF;
            a.reason = reason;
            a.doneAt = clock.getAsLong();
            a.owner = null;
        });
    }

    /** The PENDING records whose nextAt has come, oldest first. */
    List<ChatAction> due() {
        long now = clock.getAsLong();
        List<ChatAction> out = new ArrayList<>();
        for (ChatAction a : all()) {
            if (a.state == ChatAction.State.PENDING && a.nextAt <= now) out.add(a);
        }
        return out;
    }

    /** The DONE and HANDOFF records, oldest first; never a PENDING or RUNNING one. */
    List<ChatAction> forDrain() {
        List<ChatAction> out = new ArrayList<>();
        for (ChatAction a : all()) {
            if (a.state == ChatAction.State.DONE || a.state == ChatAction.State.HANDOFF) out.add(a);
        }
        return out;
    }

    /** Forgets the DONE and HANDOFF records among `ids`; a PENDING or RUNNING one stays native code's. */
    void ack(Collection<String> ids) {
        synchronized (LOCK) {
            for (String id : ids) {
                ChatAction a = read(PREFIX + id);
                if (a != null && (a.state == ChatAction.State.DONE || a.state == ChatAction.State.HANDOFF)) {
                    kv.remove(PREFIX + id);
                }
            }
        }
    }

    /** RUNNING records of a process that is gone → PENDING, due now, sentAt kept. Returns their count. */
    int recover() {
        synchronized (LOCK) {
            String me = process.get();
            long now = clock.getAsLong();
            int n = 0;
            for (ChatAction a : all()) {
                if (a.state != ChatAction.State.RUNNING || me.equals(a.owner)) continue;
                a.state = ChatAction.State.PENDING;
                a.owner = null;
                a.nextAt = Math.min(a.nextAt, now);
                write(a);
                n++;
            }
            return n;
        }
    }

    /** The account's actions waiting for the app. */
    int handoffCount(String configId) {
        int n = 0;
        for (ChatAction a : all()) {
            if (a.state == ChatAction.State.HANDOFF && a.configId.equals(configId)) n++;
        }
        return n;
    }

    /**
     * Forgets the DONE records older than 7 days, and the records whose seal does not open or whose
     * content does not parse; a HANDOFF one stays until the app takes it. Returns how many went.
     */
    int prune() {
        synchronized (LOCK) {
            long now = clock.getAsLong();
            int n = 0;
            for (String k : kv.keys()) {
                if (!k.startsWith(PREFIX) || kv.get(k) == null) continue;
                ChatAction a = read(k);
                if (a == null || a.state == ChatAction.State.DONE && now - a.doneAt > PRUNE_MS) {
                    kv.remove(k);
                    n++;
                }
            }
            return n;
        }
    }

    private interface Change {
        void apply(ChatAction a);
    }

    private void update(String id, Change change) {
        synchronized (LOCK) {
            ChatAction a = read(PREFIX + id);
            if (a == null) return;
            change.apply(a);
            write(a);
        }
    }

    private List<ChatAction> all() {
        List<ChatAction> out = new ArrayList<>();
        synchronized (LOCK) {
            for (String k : kv.keys()) {
                if (!k.startsWith(PREFIX)) continue;
                ChatAction a = read(k);
                if (a != null) out.add(a);
            }
        }
        out.sort(Comparator.comparingLong((ChatAction a) -> a.createdAt).thenComparing(a -> a.id));
        return out;
    }

    private ChatAction read(String key) {
        String raw = kv.get(key);
        if (raw == null) return null;
        try {
            return ChatAction.fromRecord(new JSONObject(new String(box.open(raw), StandardCharsets.UTF_8)));
        } catch (JSONException | GeneralSecurityException e) {
            return null;
        }
    }

    private void write(ChatAction a) {
        try {
            kv.put(PREFIX + a.id, box.seal(a.record().toString().getBytes(StandardCharsets.UTF_8)));
        } catch (JSONException | GeneralSecurityException e) {
            throw new IllegalStateException("action unwritable");
        }
    }
}
