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
 * One JSON-RPC call to an Odoo route of the native side, shared by OdooDirect and OdooActions. The session
 * id goes in a Cookie header; there is no cookie jar and no redirect is followed. An answer without an
 * error is a success whether its result is absent (Odoo omits a null result) or null; the result is
 * returned as is (null when absent). An exception message carries its kind and at most an HTTP status or a
 * short fixed word: never the session id, a URL or a body.
 */
final class OdooJson {

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    private final OkHttpClient client;

    OdooJson(OkHttpClient base) {
        this.client = base.newBuilder().followRedirects(false).followSslRedirects(false).build();
    }

    /** POSTs {jsonrpc, method: call, params} to `path` of the session's server and returns the result. */
    Object call(NativeSession s, String path, JSONObject params, boolean allowHttp) throws OdooDirectException {
        if (!HttpPolicy.allowed(s.odooUrl, allowHttp)) {
            throw new OdooDirectException(OdooDirectException.Kind.HTTP_REFUSED, null);
        }
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
            int code = r.code();
            if (code == 401) throw new OdooDirectException(OdooDirectException.Kind.SESSION_EXPIRED, "HTTP 401");
            if (code == 404 || code == 410) {
                throw new OdooDirectException(OdooDirectException.Kind.NOT_FOUND, "HTTP " + code);
            }
            if (code == 408 || code == 429 || code >= 500) {
                throw new OdooDirectException(OdooDirectException.Kind.TRANSIENT, "HTTP " + code);
            }
            if (code >= 400) throw new OdooDirectException(OdooDirectException.Kind.REFUSED, "HTTP " + code);
            if (code < 200 || code >= 300) {
                throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "HTTP " + code);
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
                int code = error.optInt("code", 0);
                if (code == 100) throw new OdooDirectException(OdooDirectException.Kind.SESSION_EXPIRED, "code 100");
                if (code == 404) throw new OdooDirectException(OdooDirectException.Kind.NOT_FOUND, "code 404");
                throw new OdooDirectException(OdooDirectException.Kind.REFUSED, "rpc error");
            }
            return json.opt("result");
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "not json");
        }
    }
}
