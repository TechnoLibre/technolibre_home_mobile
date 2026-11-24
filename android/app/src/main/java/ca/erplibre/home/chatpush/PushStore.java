package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native record of the ntfy servers and of each account's subscription.
 * The ntfy token, the P-256 private key and the auth secret rest sealed by
 * SecretBox; nothing secret is held in clear in the key-value store.
 * Layout: "ntfy:&lt;url&gt;", "sub:&lt;configId&gt;", "cur:&lt;url&gt;" and
 * "seen:&lt;url&gt;", each a small JSON object (the last, a plain id list).
 */
final class PushStore {

    static final int SEEN_CAPACITY = 200;
    private static final String ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
    private static final int TOPIC_SUFFIX = 22;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final KeyValue kv;
    private final SecretBox box;

    PushStore(KeyValue kv, SecretBox box) {
        this.kv = kv;
        this.box = box;
    }

    void putNtfy(NtfyServer s) {
        try {
            JSONObject o = new JSONObject();
            o.put("url", s.url);
            o.put("token", seal(s.token.getBytes(StandardCharsets.UTF_8)));
            o.put("prefix", s.prefix);
            o.put("cache", s.cacheSeconds);
            kv.put("ntfy:" + s.url, o.toString());
        } catch (JSONException e) {
            throw new IllegalStateException("ntfy record unwritable");
        }
    }

    /** The server stored under this URL (any spelling), or null when absent or its token no longer opens. */
    NtfyServer ntfy(String url) {
        String raw = kv.get("ntfy:" + NtfyServer.normalize(url));
        if (raw == null) return null;
        try {
            JSONObject o = new JSONObject(raw);
            String token = new String(box.open(o.getString("token")), StandardCharsets.UTF_8);
            return new NtfyServer(o.getString("url"), token, o.getString("prefix"), o.getInt("cache"));
        } catch (JSONException | GeneralSecurityException e) {
            return null;
        }
    }

    List<NtfyServer> ntfys() {
        List<NtfyServer> out = new ArrayList<>();
        for (String k : kv.keys()) {
            if (!k.startsWith("ntfy:")) continue;
            NtfyServer s = ntfy(k.substring("ntfy:".length()));
            if (s != null) out.add(s);
        }
        return out;
    }

    /** Removes the server with its cursor and seen ids; its subscriptions are the caller's to unsubscribe. */
    void removeNtfy(String url) {
        String u = NtfyServer.normalize(url);
        kv.remove("ntfy:" + u);
        kv.remove("cur:" + u);
        kv.remove("seen:" + u);
    }

    /**
     * The account's subscription on this server. An existing one is returned
     * as is, unless renew is set, it sits on another server, or its topic was
     * drawn under another prefix (compared exactly); otherwise a new key
     * pair, a new auth secret and a new topic (prefix + 22 of [a-z0-9])
     * replace it.
     * IllegalArgumentException when the server is unknown.
     */
    Subscription subscribe(String configId, String ntfyUrl, boolean renew) {
        NtfyServer s = ntfy(ntfyUrl);
        if (s == null) throw new IllegalArgumentException("unknown ntfy server");
        Subscription known = subscription(configId);
        if (known != null && !renew && known.ntfyUrl.equals(s.url) && s.prefix.equals(known.prefix)) {
            return known;
        }
        KeyPair pair = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) pair.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        StringBuilder topic = new StringBuilder(s.prefix);
        for (int i = 0; i < TOPIC_SUFFIX; i++) topic.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
        try {
            JSONObject o = new JSONObject();
            o.put("ntfy", s.url);
            o.put("topic", topic.toString());
            o.put("prefix", s.prefix);
            o.put("pub", WebPushKeys.b64url(pub));
            o.put("auth", seal(auth));
            o.put("priv", seal(pair.getPrivate().getEncoded()));
            kv.put("sub:" + configId, o.toString());
        } catch (JSONException e) {
            throw new IllegalStateException("subscription unwritable");
        }
        return subscription(configId);
    }

    /** The account's subscription, or null when absent or unreadable. */
    Subscription subscription(String configId) {
        String raw = kv.get("sub:" + configId);
        if (raw == null) return null;
        try {
            JSONObject o = new JSONObject(raw);
            return new Subscription(configId, o.getString("ntfy"), o.getString("topic"), o.optString("prefix", ""),
                    WebPushKeys.unb64url(o.getString("pub")), box.open(o.getString("auth")),
                    o.getString("priv"), box);
        } catch (JSONException | GeneralSecurityException | IllegalArgumentException e) {
            return null;
        }
    }

    Subscription byTopic(String topic) {
        for (String k : kv.keys()) {
            if (!k.startsWith("sub:")) continue;
            Subscription s = subscription(k.substring("sub:".length()));
            if (s != null && s.topic.equals(topic)) return s;
        }
        return null;
    }

    List<Subscription> subscriptions(String ntfyUrl) {
        String u = NtfyServer.normalize(ntfyUrl);
        List<Subscription> out = new ArrayList<>();
        for (String k : kv.keys()) {
            if (!k.startsWith("sub:")) continue;
            Subscription s = subscription(k.substring("sub:".length()));
            if (s != null && s.ntfyUrl.equals(u)) out.add(s);
        }
        return out;
    }

    void unsubscribe(String configId) {
        kv.remove("sub:" + configId);
    }

    /** The last ntfy message id handled on this server, or null. */
    String cursor(String url) {
        JSONObject o = cursorRecord(url);
        return o == null || o.optString("last", "").isEmpty() ? null : o.optString("last");
    }

    void setCursor(String url, String lastId, long contactAt) {
        try {
            JSONObject o = new JSONObject();
            o.put("last", lastId == null ? "" : lastId);
            o.put("at", contactAt);
            kv.put("cur:" + NtfyServer.normalize(url), o.toString());
        } catch (JSONException e) {
            throw new IllegalStateException("cursor unwritable");
        }
    }

    /** Epoch ms of the last successful contact with the server, 0 when none. */
    long lastContactAt(String url) {
        JSONObject o = cursorRecord(url);
        return o == null ? 0L : o.optLong("at", 0L);
    }

    SeenIds seen(String url) {
        return new SeenIds(kv.get("seen:" + NtfyServer.normalize(url)), SEEN_CAPACITY);
    }

    void saveSeen(String url, SeenIds s) {
        kv.put("seen:" + NtfyServer.normalize(url), s.serialize());
    }

    private JSONObject cursorRecord(String url) {
        String raw = kv.get("cur:" + NtfyServer.normalize(url));
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    private String seal(byte[] plain) {
        try {
            return box.seal(plain);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("seal failed");
        }
    }
}
