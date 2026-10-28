package ca.erplibre.home.chatpush;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The engine's state at one instant, as the app's status panel and the
 * permanent notification read it. Built by PushEngine; holds no token, no
 * key and no session id, only URLs, account ids, states and reason kinds.
 */
final class HealthSnapshot {

    /** One ntfy server: state is connected, connecting, polling, error or off. */
    static final class Ntfy {
        final String url;
        final String state;
        /** The NtfyException kind in lower case, or null. */
        final String reason;
        final long lastContactAt;
        final List<String> configIds;

        Ntfy(String url, String state, String reason, long lastContactAt, List<String> configIds) {
            this.url = url;
            this.state = state;
            this.reason = reason;
            this.lastContactAt = lastContactAt;
            this.configIds = configIds;
        }
    }

    /**
     * One mirrored account: via is ntfy or odoo; state is ok, waiting, error,
     * session_expired or no_session.
     */
    static final class Account {
        final String configId;
        final String via;
        final String state;
        final String reason;
        final long lastCheckAt;

        Account(String configId, String via, String state, String reason, long lastCheckAt) {
            this.configId = configId;
            this.via = via;
            this.state = state;
            this.reason = reason;
            this.lastCheckAt = lastCheckAt;
        }
    }

    final long at;
    final int level;
    final int effectiveLevel;
    /** realtime, poll_15, poll_60 or off. */
    final String mode;
    final boolean realtimeBuild;
    final boolean serviceAlive;
    final List<Ntfy> ntfys;
    final List<Account> accounts;
    /** Messages dropped because their body did not decrypt or did not parse. */
    final int undecryptable;
    /**
     * Messages dropped on a fault of this side: the platform cipher, a sealed
     * key that no longer opens, an unexpected error while building or drawing
     * the notification.
     */
    final int faults;

    HealthSnapshot(long at, int level, int effectiveLevel, String mode, boolean realtimeBuild,
            boolean serviceAlive, List<Ntfy> ntfys, List<Account> accounts, int undecryptable,
            int faults) {
        this.at = at;
        this.level = level;
        this.effectiveLevel = effectiveLevel;
        this.mode = mode;
        this.realtimeBuild = realtimeBuild;
        this.serviceAlive = serviceAlive;
        this.ntfys = new ArrayList<>(ntfys);
        this.accounts = new ArrayList<>(accounts);
        this.undecryptable = undecryptable;
        this.faults = faults;
    }

    JSONObject toJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("at", at);
            o.put("level", level);
            o.put("effectiveLevel", effectiveLevel);
            o.put("mode", mode);
            o.put("realtimeBuild", realtimeBuild);
            o.put("serviceAlive", serviceAlive);
            JSONArray ns = new JSONArray();
            for (Ntfy n : ntfys) {
                JSONObject j = new JSONObject();
                j.put("url", n.url);
                j.put("state", n.state);
                j.put("reason", n.reason == null ? JSONObject.NULL : n.reason);
                j.put("lastContactAt", n.lastContactAt);
                j.put("configIds", new JSONArray(n.configIds));
                ns.put(j);
            }
            o.put("ntfys", ns);
            JSONArray as = new JSONArray();
            for (Account a : accounts) {
                JSONObject j = new JSONObject();
                j.put("configId", a.configId);
                j.put("via", a.via);
                j.put("state", a.state);
                j.put("reason", a.reason == null ? JSONObject.NULL : a.reason);
                j.put("lastCheckAt", a.lastCheckAt);
                as.put(j);
            }
            o.put("accounts", as);
            o.put("undecryptable", undecryptable);
            o.put("faults", faults);
            return o;
        } catch (JSONException e) {
            throw new IllegalStateException("health unwritable");
        }
    }
}
