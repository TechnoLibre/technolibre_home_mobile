package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The actions a notification takes on Odoo, on the session's native copy: one JSON-RPC call each, mirroring
 * the app's outbox. /mail/message/post, /discuss/channel/mark_as_read and /mail/message/reaction are
 * auth="public": on a dead session they run as the public user (or answer 404) instead of failing, so a
 * caller asks alive() before each action. A JSON-RPC 404 on an action route is NOT_FOUND. A live answer
 * with no result key is a success. An exception message never carries the session id, a URL, a body or a
 * reply text.
 */
final class OdooActions {

    /** The Store answer of a post is kept up to this many bytes. */
    static final int MAX_ANSWER_BYTES = 32 * 1024;

    private static final String CHANNEL = "discuss.channel";
    private static final String CALL_KW = "/web/dataset/call_kw/";

    private final OdooJson json;

    OdooActions(OkHttpClient base) {
        this.json = new OdooJson(base.newBuilder()
                .callTimeout(8, TimeUnit.SECONDS).connectTimeout(4, TimeUnit.SECONDS).build());
    }

    /** The session's own partner id; SESSION_EXPIRED when get_session_info (auth="user") says the session is dead. */
    long alive(NativeSession s, boolean allowHttp) throws OdooDirectException {
        Object info = json.call(s, "/web/session/get_session_info", new JSONObject(), allowHttp);
        if (!(info instanceof JSONObject)) throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "unexpected result");
        long partner = OdooDirect.selfPartnerOf((JSONObject) info);
        if (partner < 0) throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "no partner");
        return partner;
    }

    /**
     * Posts `bodyHtml` to the channel as a comment. `clientUuid` is always the temporary id; with the module
     * (`useModule`) it is also erplibre_client_uuid, which makes a resend return the first message. TRANSIENT
     * when the answer holds no message id: Odoo may have posted.
     */
    Posted post(NativeSession s, long channelId, String bodyHtml, String clientUuid, boolean useModule,
            boolean allowHttp) throws OdooDirectException {
        JSONObject params = new JSONObject();
        try {
            JSONObject data = new JSONObject().put("body", bodyHtml).put("message_type", "comment")
                    .put("subtype_xmlid", "mail.mt_comment");
            if (useModule) data.put("erplibre_client_uuid", clientUuid);
            params.put("thread_model", CHANNEL).put("thread_id", channelId).put("post_data", data)
                    .put("context", new JSONObject().put("temporary_id", clientUuid));
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        Object result = json.call(s, "/mail/message/post", params, allowHttp);
        long id = -1;
        if (result instanceof JSONObject) {
            JSONArray messages = ((JSONObject) result).optJSONArray("mail.message");
            JSONObject first = messages == null ? null : messages.optJSONObject(0);
            if (first != null && first.opt("id") instanceof Number) id = first.optLong("id", -1);
        }
        if (id < 0) throw new OdooDirectException(OdooDirectException.Kind.TRANSIENT, "no message id");
        String answer = result.toString();
        return new Posted(id, answer.getBytes(StandardCharsets.UTF_8).length > MAX_ANSWER_BYTES ? null : answer);
    }

    /**
     * The id of the user's own message in the channel whose body holds the whole marker comment of
     * `clientUuid`; null when none. A message that only quotes the uuid is not taken. AMBIGUOUS on two.
     */
    Long findSent(NativeSession s, long channelId, String clientUuid, long selfPartnerId, boolean allowHttp)
            throws OdooDirectException {
        String marker = "<!-- erplibre-mobile:" + clientUuid + " -->";
        JSONObject params;
        try {
            JSONArray domain = new JSONArray()
                    .put(term("model", "=", CHANNEL)).put(term("res_id", "=", channelId))
                    .put(term("author_id", "=", selfPartnerId))
                    .put(term("body", "ilike", "erplibre-mobile:" + clientUuid));
            params = callKw("mail.message", "search_read", new JSONArray().put(domain),
                    new JSONObject().put("fields", new JSONArray().put("id").put("body").put("parent_id"))
                            .put("limit", 2));
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        JSONArray rows = asArray(json.call(s, CALL_KW + "mail.message/search_read", params, allowHttp));
        Long found = null;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !(row.opt("id") instanceof Number)) continue;
            if (!row.optString("body", "").contains(marker)) continue;
            if (found != null) throw new OdooDirectException(OdooDirectException.Kind.AMBIGUOUS, "two hits");
            found = row.optLong("id");
        }
        return found;
    }

    /**
     * The newest message id of the channel dated at most `atMostEpochS` (UTC seconds); null when none. An
     * ORM search, never a fetch route: those mark messages read as a side effect.
     */
    Long latestMessageId(NativeSession s, long channelId, long atMostEpochS, boolean allowHttp)
            throws OdooDirectException {
        SimpleDateFormat utc = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        utc.setTimeZone(TimeZone.getTimeZone("UTC"));
        JSONObject params;
        try {
            JSONArray domain = new JSONArray()
                    .put(term("model", "=", CHANNEL)).put(term("res_id", "=", channelId))
                    .put(term("date", "<=", utc.format(new Date(atMostEpochS * 1000L))));
            params = callKw("mail.message", "search", new JSONArray().put(domain),
                    new JSONObject().put("order", "id desc").put("limit", 1));
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        JSONArray ids = asArray(json.call(s, CALL_KW + "mail.message/search", params, allowHttp));
        return ids.length() > 0 && ids.opt(0) instanceof Number ? Long.valueOf(ids.optLong(0)) : null;
    }

    /**
     * Marks the channel read up to `lastMessageId`, then the user's notifications of that conversation up to
     * the same message (mark_all_as_read bounded to the channel and the id): nothing else leaves the Inbox.
     */
    void markRead(NativeSession s, long channelId, long lastMessageId, boolean allowHttp)
            throws OdooDirectException {
        JSONObject params;
        JSONObject bounded;
        try {
            params = new JSONObject().put("channel_id", channelId).put("last_message_id", lastMessageId);
            JSONArray domain = new JSONArray()
                    .put(term("model", "=", CHANNEL)).put(term("res_id", "=", channelId))
                    .put(term("id", "<=", lastMessageId));
            bounded = callKw("mail.message", "mark_all_as_read", new JSONArray().put(domain), new JSONObject());
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        json.call(s, "/discuss/channel/mark_as_read", params, allowHttp);
        json.call(s, CALL_KW + "mail.message/mark_all_as_read", bounded, allowHttp);
    }

    /** Mutes the channel for `minutes` (0 lifts the mute). */
    void mute(NativeSession s, long channelId, int minutes, boolean allowHttp) throws OdooDirectException {
        JSONObject params = new JSONObject();
        try {
            params.put("minutes", minutes).put("channel_id", channelId);
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        json.call(s, "/discuss/settings/mute", params, allowHttp);
    }

    /** Adds the reaction `content` to the message and returns the Store answer as JSON text. */
    String react(NativeSession s, long messageId, String content, boolean allowHttp) throws OdooDirectException {
        JSONObject params = new JSONObject();
        try {
            params.put("message_id", messageId).put("content", content).put("action", "add");
        } catch (JSONException e) {
            throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, null);
        }
        Object result = json.call(s, "/mail/message/reaction", params, allowHttp);
        if (!(result instanceof JSONObject)) throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "unexpected result");
        return result.toString();
    }

    private static JSONArray term(String field, String op, Object value) throws JSONException {
        return new JSONArray().put(field).put(op).put(value);
    }

    private static JSONObject callKw(String model, String method, JSONArray args, JSONObject kwargs)
            throws JSONException {
        return new JSONObject().put("model", model).put("method", method).put("args", args).put("kwargs", kwargs);
    }

    private static JSONArray asArray(Object result) throws OdooDirectException {
        if (result instanceof JSONArray) return (JSONArray) result;
        throw new OdooDirectException(OdooDirectException.Kind.PROTOCOL, "unexpected result");
    }
}
