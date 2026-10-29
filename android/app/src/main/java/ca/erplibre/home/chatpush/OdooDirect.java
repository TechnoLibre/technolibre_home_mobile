package ca.erplibre.home.chatpush;

import okhttp3.OkHttpClient;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Minimal Odoo client of the native side, three routes only:
 * /web/session/get_session_info and /mail/data (both read-only: nothing is
 * marked read) and mail.push.device unregister_devices. The session id goes
 * in a Cookie header; there is no cookie jar and no redirect is followed.
 * An exception message never carries the session id, a URL or a body.
 */
final class OdooDirect {

    private final OdooJson json;

    OdooDirect(OkHttpClient base) {
        this.json = new OdooJson(base);
    }

    /** Reads the account-wide mute and the self partner, then the member channels' counters, and counts them. */
    UnreadSummary check(NativeSession s, boolean allowHttp, long nowMs) throws OdooDirectException {
        JSONObject info = asObject(json.call(s, "/web/session/get_session_info", new JSONObject(), allowHttp));
        String mute = null;
        JSONObject storeData = info.optJSONObject("storeData");
        JSONObject store = storeData == null ? null : storeData.optJSONObject("Store");
        JSONObject settings = store == null ? null : store.optJSONObject("settings");
        if (settings != null && !settings.isNull("mute_until_dt")) {
            mute = settings.optString("mute_until_dt", null);
        }
        JSONObject params = new JSONObject();
        try {
            params.put("init_messaging", new JSONObject());
            params.put("channels_as_member", true);
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        JSONObject mailData = asObject(json.call(s, "/mail/data", params, allowHttp));
        return UnreadSummary.of(mailData, selfPartnerOf(info, store), mute, nowMs);
    }

    /** The session's own partner: its Store's self, else partner_id; -1 when neither says. */
    static long selfPartnerOf(JSONObject info, JSONObject store) {
        JSONObject self = store == null ? null : store.optJSONObject("self");
        if (self != null && self.opt("id") instanceof Number && "partner".equals(self.optString("type", "partner"))) {
            return self.optLong("id");
        }
        return info.opt("partner_id") instanceof Number ? info.optLong("partner_id") : -1;
    }

    /** The session's own partner out of a get_session_info answer; -1 when it says none. */
    static long selfPartnerOf(JSONObject info) {
        JSONObject storeData = info.optJSONObject("storeData");
        return selfPartnerOf(info, storeData == null ? null : storeData.optJSONObject("Store"));
    }

    /** Asks Odoo to forget the push endpoint (no partner check on its side). */
    void unregister(NativeSession s, String endpoint, boolean allowHttp) throws OdooDirectException {
        JSONObject params = new JSONObject();
        try {
            params.put("model", "mail.push.device");
            params.put("method", "unregister_devices");
            params.put("args", new org.json.JSONArray());
            params.put("kwargs", new JSONObject().put("endpoint", endpoint));
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        try {
            json.call(s, "/web/dataset/call_kw/mail.push.device/unregister_devices", params, allowHttp);
        } catch (OdooDirectException e) {
            // Odoo answers null for an endpoint it does not know: only an HTTP 404 or 410 means the route is
            // gone. A JSON-RPC 404 is an unexpected answer, retried.
            if (e.kind() == OdooDirectException.Kind.NOT_FOUND && e.rpc()) {
                throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "rpc error");
            }
            throw e;
        }
    }

    private static JSONObject asObject(Object result) throws OdooDirectException {
        if (result instanceof JSONObject) return (JSONObject) result;
        throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "unexpected result");
    }
}
