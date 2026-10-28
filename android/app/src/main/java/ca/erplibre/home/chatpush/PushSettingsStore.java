package ca.erplibre.home.chatpush;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the app mirrors for the native side: the notification level, the
 * cleartext permission, the translated strings and each account's view,
 * plus the engine's own flags (app in foreground, last heartbeat) and the
 * per-install key that authenticates a notification tap. Nothing here is
 * secret except openKey().
 */
final class PushSettingsStore {

    static final int DEFAULT_LEVEL = 3;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final KeyValue kv;

    PushSettingsStore(KeyValue kv) {
        this.kv = kv;
    }

    /** Replaces the whole mirror in one pass. */
    void put(int level, boolean allowHttp, Map<String, String> strings, List<AccountView> accounts) {
        kv.put("level", Integer.toString(level));
        kv.put("allowHttp", Boolean.toString(allowHttp));
        try {
            JSONObject s = new JSONObject();
            if (strings != null) {
                for (Map.Entry<String, String> e : strings.entrySet()) s.put(e.getKey(), e.getValue());
            }
            kv.put("strings", s.toString());
            JSONArray arr = new JSONArray();
            if (accounts != null) {
                for (AccountView a : accounts) arr.put(accountJson(a));
            }
            kv.put("accounts", arr.toString());
        } catch (JSONException e) {
            throw new IllegalStateException("settings unwritable");
        }
    }

    /** The mirrored level; 3 (every 15 minutes) before the app ever mirrored one. */
    int level() {
        String v = kv.get("level");
        if (v == null) return DEFAULT_LEVEL;
        try {
            return Integer.parseInt(v);
        } catch (NumberFormatException e) {
            return DEFAULT_LEVEL;
        }
    }

    boolean allowHttp() {
        return Boolean.parseBoolean(kv.get("allowHttp"));
    }

    PushStrings strings() {
        Map<String, String> m = new HashMap<>();
        String raw = kv.get("strings");
        if (raw != null) {
            try {
                JSONObject o = new JSONObject(raw);
                for (Iterator<String> it = o.keys(); it.hasNext();) {
                    String k = it.next();
                    m.put(k, o.optString(k, ""));
                }
            } catch (JSONException e) {
                m.clear();
            }
        }
        return new PushStrings(m);
    }

    AccountView account(String configId) {
        for (AccountView a : accounts()) {
            if (a.configId.equals(configId)) return a;
        }
        return null;
    }

    List<AccountView> accounts() {
        List<AccountView> out = new ArrayList<>();
        String raw = kv.get("accounts");
        if (raw == null) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) out.add(accountOf(arr.getJSONObject(i)));
        } catch (JSONException e) {
            out.clear();
        }
        return out;
    }

    boolean foreground() {
        return Boolean.parseBoolean(kv.get("foreground"));
    }

    void setForeground(boolean f) {
        kv.put("foreground", Boolean.toString(f));
    }

    void beat(long at) {
        kv.put("beat", Long.toString(at));
    }

    long lastBeat() {
        String v = kv.get("beat");
        if (v == null) return 0L;
        try {
            return Long.parseLong(v);
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    /** A random per-install secret (drawn once, then kept) that a notification tap must carry. */
    String openKey() {
        String k = kv.get("openKey");
        if (k == null || k.isEmpty()) {
            byte[] b = new byte[24];
            RANDOM.nextBytes(b);
            k = B64.encode(b, true);
            kv.put("openKey", k);
        }
        return k;
    }

    private static JSONObject accountJson(AccountView a) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("configId", a.configId);
        o.put("label", a.label);
        o.put("lockScreen", a.lockScreen.key);
        JSONObject ch = new JSONObject();
        for (Map.Entry<Long, ChannelInfo> e : a.channels.entrySet()) {
            JSONObject c = new JSONObject();
            c.put("name", e.getValue().name);
            c.put("type", e.getValue().type);
            ch.put(Long.toString(e.getKey()), c);
        }
        o.put("channels", ch);
        return o;
    }

    private static AccountView accountOf(JSONObject o) throws JSONException {
        Map<Long, ChannelInfo> channels = new HashMap<>();
        JSONObject ch = o.optJSONObject("channels");
        if (ch != null) {
            for (Iterator<String> it = ch.keys(); it.hasNext();) {
                String k = it.next();
                JSONObject c = ch.getJSONObject(k);
                try {
                    channels.put(Long.parseLong(k), new ChannelInfo(c.optString("name"), c.optString("type")));
                } catch (NumberFormatException e) {
                    // a non-numeric id is not a conversation
                }
            }
        }
        return new AccountView(o.getString("configId"), o.optString("label"),
                LockScreenMode.fromKey(o.optString("lockScreen")), channels);
    }
}
