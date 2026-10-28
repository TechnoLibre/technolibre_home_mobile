package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The plaintext of an Odoo Web Push: {"title", "options": {"icon", "body",
 * "data": {"model", "res_id", "action"}}}. res_id is an integer, or an empty
 * string when Odoo has none, read as 0. action is absent for a comment on a
 * record and then "". The title and body are Odoo's own text; the payload
 * carries no message id and no channel type.
 */
final class PushPayload {

    final String title;
    final String body;
    final String model;
    final long resId;
    final String action;

    private PushPayload(String title, String body, String model, long resId, String action) {
        this.title = title;
        this.body = body;
        this.model = model;
        this.resId = resId;
        this.action = action;
    }

    /** A discuss channel push (chat, group or channel mention), as opposed to a record comment. */
    boolean isChat() {
        return "discuss.channel".equals(model);
    }

    static PushPayload parse(byte[] json) throws JSONException {
        JSONObject root = new JSONObject(new String(json, StandardCharsets.UTF_8));
        JSONObject options = root.optJSONObject("options");
        if (options == null) options = new JSONObject();
        JSONObject data = options.optJSONObject("data");
        if (data == null) data = new JSONObject();
        return new PushPayload(
                text(root, "title"),
                text(options, "body"),
                text(data, "model"),
                data.optLong("res_id", 0),
                text(data, "action"));
    }

    private static String text(JSONObject o, String key) {
        return o.isNull(key) ? "" : o.optString(key, "");
    }
}
