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
 * A stock push has no message id (0) and no channel type ("").
 *
 * Module 1.6 sends a device marked for version 2 the message object {"v": 2,
 * "message_id", "channel_type", "mentioned", "browser_online"}: mentioned
 * when the recipient is among the message's partners, browser_online when a
 * browser of the recipient's user was active. A device marked for version 1
 * still gets lot 2's object. A message object of version 1 or 2 is read for
 * its message id and channel type, the two flags only from version 2 (flags
 * says whether they were read); a message object of another version reads as
 * a stock push. A control push is read only at version 1: another version or
 * an unknown type is IGNORED.
 */
final class PushPayload {

    /** IGNORED: a control push this app does not read, dropped without being a failure. */
    enum Kind { MESSAGE, READ, INBOX_DONE, IGNORED }

    /** The version of the module's control pushes, and of a message object without flags. */
    static final int VERSION = 1;
    /** The version of the module's message object that carries mentioned and browser_online. */
    static final int FLAGS_VERSION = 2;

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
    /** Whether the MESSAGE push carried a version 2 object, so that mentioned and browserOnline were read. */
    final boolean flags;
    /** The recipient is mentioned (@everyone included); false without flags. */
    final boolean mentioned;
    /** A browser of the recipient's Odoo user was active when the message was sent; false without flags. */
    final boolean browserOnline;

    private PushPayload(Kind kind, String title, String body, String model, long resId, String action,
            long messageId, String channelType, long channelId, long lastMessageId, List<String[]> threads,
            boolean flags, boolean mentioned, boolean browserOnline) {
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
        this.flags = flags;
        this.mentioned = mentioned;
        this.browserOnline = browserOnline;
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
        int v = module == null ? 0 : module.optInt("v", 0);
        if (v != VERSION && v != FLAGS_VERSION) module = new JSONObject();
        boolean flags = v == FLAGS_VERSION;
        return new PushPayload(Kind.MESSAGE,
                text(root, "title"),
                text(options, "body"),
                text(data, "model"),
                data.optLong("res_id", 0),
                text(data, "action"),
                module.optLong("message_id", 0),
                text(module, "channel_type"),
                0, 0, Collections.<String[]>emptyList(),
                flags, flags && module.optBoolean("mentioned", false),
                flags && module.optBoolean("browser_online", false));
    }

    private static PushPayload control(JSONObject e) throws JSONException {
        String type = e.optInt("v", 0) == VERSION ? text(e, "type") : "";
        if ("read".equals(type)) {
            return new PushPayload(Kind.READ, "", "", "", 0, "", 0, "",
                    e.optLong("channel_id", 0), e.optLong("last_message_id", 0),
                    Collections.<String[]>emptyList(), false, false, false);
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
            return new PushPayload(Kind.INBOX_DONE, "", "", "", 0, "", 0, "", 0, 0, threads, false, false, false);
        }
        return new PushPayload(Kind.IGNORED, "", "", "", 0, "", 0, "", 0, 0, Collections.<String[]>emptyList(),
                false, false, false);
    }

    private static String text(JSONObject o, String key) {
        return o.isNull(key) ? "" : o.optString(key, "");
    }
}
