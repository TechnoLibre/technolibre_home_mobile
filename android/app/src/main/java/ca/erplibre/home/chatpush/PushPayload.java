package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The plaintext of an Odoo Web Push. A message push is {"title", "options":
 * {"icon", "body", "data": {"model", "res_id", "action"}}}. res_id is an
 * integer, or an empty string when Odoo has none, read as 0. action is
 * absent for a comment on a record and then "". The title and body are
 * Odoo's own text.
 *
 * Module erplibre_mobile_chat 1.5 adds data.erplibre {"v", "message_id",
 * "channel_type"} to a message push (channel_type null on a record), and
 * sends two control pushes with no title, whose root is {"erplibre": {"v",
 * "type", ...}}: "read" {"channel_id", "last_message_id"} and "inbox_done"
 * {"threads": [[model, res_id], ...]}, threads null for every inbox thread.
 * A stock push has no message id (0) and no channel type (""). Only version
 * 1 of the erplibre object is read: a control push of another version or of
 * an unknown type is IGNORED, a message push of another version reads as a
 * stock one.
 */
final class PushPayload {

    /** IGNORED: a control push this app does not read, dropped without being a failure. */
    enum Kind { MESSAGE, READ, INBOX_DONE, IGNORED }

    /** The version of the module's erplibre object this app reads. */
    static final int VERSION = 1;

    final Kind kind;
    final String title;
    final String body;
    final String model;
    final long resId;
    final String action;
    /** The Odoo message id of a MESSAGE push, 0 when absent. */
    final long messageId;
    /** chat, group or channel for a MESSAGE push from the module, "" when absent. */
    final String channelType;
    /** The conversation a READ push marks read, 0 otherwise. */
    final long channelId;
    /** The newest message read in channelId, 0 otherwise. */
    final long lastMessageId;
    /** The threads of an INBOX_DONE push, each {model, resId}; null names every inbox thread. Empty otherwise. */
    final List<String[]> threads;

    private PushPayload(Kind kind, String title, String body, String model, long resId, String action,
            long messageId, String channelType, long channelId, long lastMessageId, List<String[]> threads) {
        this.kind = kind;
        this.title = title;
        this.body = body;
        this.model = model;
        this.resId = resId;
        this.action = action;
        this.messageId = messageId;
        this.channelType = channelType;
        this.channelId = channelId;
        this.lastMessageId = lastMessageId;
        this.threads = threads;
    }

    /** A discuss channel push (chat, group or channel mention), as opposed to a record comment. */
    boolean isChat() {
        return kind == Kind.MESSAGE && "discuss.channel".equals(model);
    }

    /** Parses a plaintext; JSONException on text that is not JSON. */
    static PushPayload parse(byte[] json) throws JSONException {
        JSONObject root = new JSONObject(new String(json, StandardCharsets.UTF_8));
        JSONObject control = root.optJSONObject("erplibre");
        if (control != null) return control(control);
        JSONObject options = root.optJSONObject("options");
        if (options == null) options = new JSONObject();
        JSONObject data = options.optJSONObject("data");
        if (data == null) data = new JSONObject();
        JSONObject module = data.optJSONObject("erplibre");
        if (module == null || module.optInt("v", 0) != VERSION) module = new JSONObject();
        return new PushPayload(Kind.MESSAGE,
                text(root, "title"),
                text(options, "body"),
                text(data, "model"),
                data.optLong("res_id", 0),
                text(data, "action"),
                module.optLong("message_id", 0),
                text(module, "channel_type"),
                0, 0, Collections.<String[]>emptyList());
    }

    private static PushPayload control(JSONObject e) throws JSONException {
        String type = e.optInt("v", 0) == VERSION ? text(e, "type") : "";
        if ("read".equals(type)) {
            return new PushPayload(Kind.READ, "", "", "", 0, "", 0, "",
                    e.optLong("channel_id", 0), e.optLong("last_message_id", 0),
                    Collections.<String[]>emptyList());
        }
        if ("inbox_done".equals(type)) {
            List<String[]> threads;
            if (e.has("threads") && e.isNull("threads")) {
                threads = null;
            } else {
                threads = new ArrayList<>();
                JSONArray arr = e.optJSONArray("threads");
                for (int i = 0; arr != null && i < arr.length(); i++) {
                    JSONArray t = arr.getJSONArray(i);
                    threads.add(new String[] {t.getString(0), Long.toString(t.getLong(1))});
                }
            }
            return new PushPayload(Kind.INBOX_DONE, "", "", "", 0, "", 0, "", 0, 0, threads);
        }
        return new PushPayload(Kind.IGNORED, "", "", "", 0, "", 0, "", 0, 0, Collections.<String[]>emptyList());
    }

    private static String text(JSONObject o, String key) {
        return o.isNull(key) ? "" : o.optString(key, "");
    }
}
