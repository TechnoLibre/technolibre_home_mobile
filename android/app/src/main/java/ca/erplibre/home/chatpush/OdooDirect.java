package ca.erplibre.home.chatpush;

import java.io.IOException;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
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

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    private final OkHttpClient client;

    OdooDirect(OkHttpClient base) {
        this.client = base.newBuilder().followRedirects(false).followSslRedirects(false).build();
    }

    /** Reads the account-wide mute, then the member channels' counters, and counts them. */
    UnreadSummary check(NativeSession s, boolean allowHttp, long nowMs) throws OdooDirectException {
        requireAllowed(s, allowHttp);
        JSONObject info = asObject(call(s, "/web/session/get_session_info", new JSONObject()));
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
        JSONObject mailData = asObject(call(s, "/mail/data", params));
        return UnreadSummary.of(mailData, mute, nowMs);
    }

    /** Asks Odoo to forget the push endpoint (no partner check on its side). */
    void unregister(NativeSession s, String endpoint, boolean allowHttp) throws OdooDirectException {
        requireAllowed(s, allowHttp);
        JSONObject params = new JSONObject();
        try {
            params.put("model", "mail.push.device");
            params.put("method", "unregister_devices");
            params.put("args", new org.json.JSONArray());
            params.put("kwargs", new JSONObject().put("endpoint", endpoint));
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        call(s, "/web/dataset/call_kw/mail.push.device/unregister_devices", params);
    }

    private static void requireAllowed(NativeSession s, boolean allowHttp) throws OdooDirectException {
        if (!HttpPolicy.allowed(s.odooUrl, allowHttp)) {
            throw new OdooDirectException(OdooDirectException.Kind.HTTP_REFUSED, null);
        }
    }

    private Object call(NativeSession s, String path, JSONObject params) throws OdooDirectException {
        String base = s.odooUrl.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        String body;
        try {
            body = new JSONObject().put("jsonrpc", "2.0").put("method", "call").put("id", 1)
                    .put("params", params).toString();
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        Request request;
        try {
            request = new Request.Builder().url(base + path)
                    .header("Cookie", "session_id=" + s.sessionId)
                    .post(RequestBody.create(JSON, body)).build();
        } catch (IllegalArgumentException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        String text;
        try (Response r = client.newCall(request).execute()) {
            if (r.code() == 401) throw new OdooDirectException(OdooDirectException.Kind.SESSION_EXPIRED, "HTTP 401");
            if (r.code() == 404 || r.code() == 410) {
                throw new OdooDirectException(OdooDirectException.Kind.NOT_FOUND, "HTTP " + r.code());
            }
            if (r.code() < 200 || r.code() >= 300) {
                throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "HTTP " + r.code());
            }
            ResponseBody rb = r.body();
            text = rb == null ? "" : rb.string();
        } catch (IOException e) {
            if (e instanceof java.net.UnknownServiceException) {
                throw new OdooDirectException(OdooDirectException.Kind.CLEARTEXT_BLOCKED, null);
            }
            throw new OdooDirectException(OdooDirectException.Kind.UNREACHABLE, e.getClass().getSimpleName());
        }
        try {
            JSONObject json = new JSONObject(text);
            JSONObject error = json.optJSONObject("error");
            if (error != null) {
                if (error.optInt("code", 0) == 100) {
                    throw new OdooDirectException(OdooDirectException.Kind.SESSION_EXPIRED, "code 100");
                }
                throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "rpc error");
            }
            return json.opt("result");
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "not json");
        }
    }

    private static JSONObject asObject(Object result) throws OdooDirectException {
        if (result instanceof JSONObject) return (JSONObject) result;
        throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "unexpected result");
    }
}
