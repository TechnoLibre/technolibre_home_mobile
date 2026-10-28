package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.LongSupplier;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The encrypted native copy of each account's Odoo session id (never the
 * password), the flag that a session is dead, and the endpoints still to
 * unregister. The session id and the endpoints rest sealed. A pending
 * unregister older than 7 days is dropped. Forgetting the session copy of
 * a removed account is the caller's (forget), since a renewed topic of a
 * live account also queues an endpoint.
 */
final class NativeSessions {

    static final long PENDING_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;

    private final KeyValue kv;
    private final SecretBox box;
    private final LongSupplier clock;

    NativeSessions(KeyValue kv, SecretBox box) {
        this(kv, box, System::currentTimeMillis);
    }

    NativeSessions(KeyValue kv, SecretBox box, LongSupplier clock) {
        this.kv = kv;
        this.box = box;
        this.clock = clock;
    }

    /** Stores the session and clears the account's expired flag. */
    void put(NativeSession s) {
        try {
            JSONObject o = new JSONObject();
            o.put("url", s.odooUrl);
            o.put("db", s.database);
            o.put("sid", seal(s.sessionId));
            o.put("at", s.savedAt);
            kv.put("sess:" + s.configId, o.toString());
            kv.remove("dead:" + s.configId);
        } catch (JSONException e) {
            throw new IllegalStateException("session unwritable");
        }
    }

    /** The session, or null when absent or its seal no longer opens. */
    NativeSession get(String configId) {
        String raw = kv.get("sess:" + configId);
        if (raw == null) return null;
        try {
            JSONObject o = new JSONObject(raw);
            return new NativeSession(configId, o.getString("url"), o.getString("db"),
                    new String(box.open(o.getString("sid")), StandardCharsets.UTF_8), o.getLong("at"));
        } catch (JSONException | GeneralSecurityException e) {
            return null;
        }
    }

    void forget(String configId) {
        kv.remove("sess:" + configId);
        kv.remove("dead:" + configId);
    }

    void markExpired(String configId) {
        kv.put("dead:" + configId, "1");
    }

    boolean expired(String configId) {
        return kv.get("dead:" + configId) != null;
    }

    void addPendingUnregister(String configId, String endpoint) {
        List<PendingUnregister> mine = new ArrayList<>();
        for (PendingUnregister p : read(configId)) {
            if (p.endpoint.equals(endpoint)) return;
            mine.add(p);
        }
        mine.add(new PendingUnregister(configId, endpoint, clock.getAsLong()));
        write(configId, mine);
    }

    /** Every endpoint still to unregister; entries older than 7 days are dropped on the way. */
    List<PendingUnregister> pending() {
        long now = clock.getAsLong();
        List<PendingUnregister> out = new ArrayList<>();
        for (String k : kv.keys()) {
            if (!k.startsWith("pend:")) continue;
            String configId = k.substring("pend:".length());
            List<PendingUnregister> fresh = new ArrayList<>();
            for (PendingUnregister p : read(configId)) {
                if (now - p.since <= PENDING_MAX_AGE_MS) fresh.add(p);
            }
            if (fresh.isEmpty()) {
                kv.remove(k);
            } else {
                write(configId, fresh);
                out.addAll(fresh);
            }
        }
        return out;
    }

    /** The account's queued endpoints are unregistered: forgets them, not the session copy. */
    void donePending(String configId) {
        kv.remove("pend:" + configId);
    }

    /**
     * Forgets the account's queued endpoints that are in sent; an endpoint
     * queued meanwhile stays, and so does the session copy.
     */
    void donePending(String configId, Set<String> sent) {
        List<PendingUnregister> left = new ArrayList<>();
        for (PendingUnregister p : read(configId)) {
            if (!sent.contains(p.endpoint)) left.add(p);
        }
        if (left.isEmpty()) kv.remove("pend:" + configId);
        else write(configId, left);
    }

    /** The accounts holding a session copy, readable or not. */
    Set<String> configIds() {
        Set<String> out = new HashSet<>();
        for (String k : kv.keys()) {
            if (k.startsWith("sess:")) out.add(k.substring("sess:".length()));
        }
        return out;
    }

    private List<PendingUnregister> read(String configId) {
        List<PendingUnregister> out = new ArrayList<>();
        String raw = kv.get("pend:" + configId);
        if (raw == null) return out;
        JSONArray arr;
        try {
            arr = new JSONArray(raw);
        } catch (JSONException e) {
            return out;
        }
        // An entry that no longer opens is skipped alone; the others stay
        for (int i = 0; i < arr.length(); i++) {
            try {
                JSONObject o = arr.getJSONObject(i);
                out.add(new PendingUnregister(configId,
                        new String(box.open(o.getString("ep")), StandardCharsets.UTF_8), o.getLong("since")));
            } catch (JSONException | GeneralSecurityException e) {
                // dropped
            }
        }
        return out;
    }

    private void write(String configId, List<PendingUnregister> list) {
        try {
            JSONArray arr = new JSONArray();
            for (PendingUnregister p : list) {
                JSONObject o = new JSONObject();
                o.put("ep", seal(p.endpoint));
                o.put("since", p.since);
                arr.put(o);
            }
            kv.put("pend:" + configId, arr.toString());
        } catch (JSONException e) {
            throw new IllegalStateException("pending unwritable");
        }
    }

    private String seal(String plain) {
        try {
            return box.seal(plain.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("seal failed");
        }
    }
}
