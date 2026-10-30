package ca.erplibre.home.chatpush;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongSupplier;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The chat messages held back while a browser of the same Odoo user is
 * active, kept durably so that a process death inside the hold never loses
 * one. Each entry is the raw ntfy message (id, time, topic, the Web Push
 * ciphertext as ntfy sent it) with the conversation and message ids the
 * engine read from it and the time it is due: nothing decrypted is ever
 * written, so the store needs no sealing.
 *
 * Layout: one key per message, "held:&lt;ntfy id&gt;", holding a small JSON
 * object; every write is durable when it returns (KeyValue). Lists are
 * sorted by due time, then by ntfy id.
 *
 * Beyond MAX entries the oldest ones are made due at once, so the next
 * release draws them first rather than the store growing without bound. An
 * entry whose stored value no longer parses is removed when read and
 * counted until takeUnreadable collects it.
 *
 * Capacitor-free and Android-free.
 */
final class HeldStore {

    /** Entries kept before the oldest are made due at once. */
    static final int MAX = 200;

    private static final String PREFIX = "held:";
    private static final Comparator<Held> BY_DUE = new Comparator<Held>() {
        @Override
        public int compare(Held a, Held b) {
            int c = Long.compare(a.dueAt, b.dueAt);
            return c != 0 ? c : a.message.id.compareTo(b.message.id);
        }
    };

    /** One held message. */
    static final class Held {
        /** The URL of the ntfy server the message came from. */
        final String linkUrl;
        final NtfyMessage message;
        final String configId;
        /** The discuss channel the message belongs to. */
        final long channelId;
        /** The Odoo message id a read push compares with. */
        final long messageId;
        /** When the message is due, epoch ms on this device's clock. */
        final long dueAt;

        Held(String linkUrl, NtfyMessage message, String configId, long channelId, long messageId, long dueAt) {
            this.linkUrl = linkUrl;
            this.message = message;
            this.configId = configId;
            this.channelId = channelId;
            this.messageId = messageId;
            this.dueAt = dueAt;
        }
    }

    private final KeyValue kv;
    private final LongSupplier clock;
    /** Unparsable entries removed since the last takeUnreadable. */
    private final AtomicInteger unreadable = new AtomicInteger();

    HeldStore(KeyValue kv, LongSupplier clock) {
        this.kv = kv;
        this.clock = clock;
    }

    /**
     * Holds the message until dueAt. A message already held keeps its entry
     * and its first due time: a replay never lengthens a hold.
     */
    void add(String linkUrl, NtfyMessage m, String configId, long channelId, long messageId, long dueAt) {
        if (kv.get(PREFIX + m.id) != null) return;
        put(new Held(linkUrl, m, configId, channelId, messageId, dueAt));
        List<Held> all = all();
        long now = clock.getAsLong();
        for (int i = 0; i < all.size() - MAX; i++) {
            Held h = all.get(i);
            if (h.dueAt > now) put(new Held(h.linkUrl, h.message, h.configId, h.channelId, h.messageId, now));
        }
    }

    /**
     * Removes the account's entries of the conversation whose message id is
     * at or below lastMessageId: a read push of that point. Returns how many.
     */
    int dropRead(String configId, long channelId, long lastMessageId) {
        int n = 0;
        for (Held h : all()) {
            if (h.configId.equals(configId) && h.channelId == channelId && h.messageId <= lastMessageId) {
                remove(h.message.id);
                n++;
            }
        }
        return n;
    }

    /** The entries due at now, of every ntfy server. */
    List<Held> due(long now) {
        List<Held> out = new ArrayList<>();
        for (Held h : all()) {
            if (h.dueAt <= now) out.add(h);
        }
        return out;
    }

    /** The entries of one ntfy server, due or not. */
    List<Held> of(String linkUrl) {
        List<Held> out = new ArrayList<>();
        for (Held h : all()) {
            if (h.linkUrl.equals(linkUrl)) out.add(h);
        }
        return out;
    }

    /** The latest due time of the entries, 0 when there are none. */
    long latestDue() {
        long latest = 0L;
        for (Held h : all()) latest = Math.max(latest, h.dueAt);
        return latest;
    }

    boolean isEmpty() {
        for (String k : kv.keys()) {
            if (k.startsWith(PREFIX)) return false;
        }
        return true;
    }

    void remove(String ntfyId) {
        kv.remove(PREFIX + ntfyId);
    }

    /** How many unparsable entries were removed since the last call; the count restarts at 0. */
    int takeUnreadable() {
        return unreadable.getAndSet(0);
    }

    /** The URLs of the ntfy servers that have entries held. */
    Set<String> linkUrls() {
        Set<String> out = new HashSet<>();
        for (Held h : all()) out.add(h.linkUrl);
        return out;
    }

    /** Every readable entry, sorted; an unreadable one is removed and counted. */
    private List<Held> all() {
        List<Held> out = new ArrayList<>();
        for (String k : kv.keys()) {
            if (!k.startsWith(PREFIX)) continue;
            String raw = kv.get(k);
            Held h = raw == null ? null : parse(raw);
            if (h == null) {
                kv.remove(k);
                unreadable.incrementAndGet();
                continue;
            }
            out.add(h);
        }
        Collections.sort(out, BY_DUE);
        return out;
    }

    private void put(Held h) {
        try {
            JSONObject o = new JSONObject();
            o.put("link", h.linkUrl);
            o.put("id", h.message.id);
            o.put("time", h.message.time);
            o.put("topic", h.message.topic);
            o.put("body", B64.encode(h.message.body, false));
            o.put("config", h.configId);
            o.put("channel", h.channelId);
            o.put("message", h.messageId);
            o.put("due", h.dueAt);
            kv.put(PREFIX + h.message.id, o.toString());
        } catch (JSONException e) {
            throw new IllegalStateException("held entry unwritable");
        }
    }

    private static Held parse(String raw) {
        try {
            JSONObject o = new JSONObject(raw);
            NtfyMessage m = new NtfyMessage(o.getString("id"), o.getLong("time"), "message", o.getString("topic"),
                    B64.decode(o.getString("body")));
            return new Held(o.getString("link"), m, o.getString("config"), o.getLong("channel"),
                    o.getLong("message"), o.getLong("due"));
        } catch (JSONException | IllegalArgumentException e) {
            return null;
        }
    }
}
