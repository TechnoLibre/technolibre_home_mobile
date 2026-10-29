package ca.erplibre.home.chatpush;

import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One action a notification button asked of Odoo, as the ActionStore keeps it. PENDING waits for its
 * `nextAt`, RUNNING is owned by a runner, DONE and HANDOFF wait for the app's drain. `sentAt` is the
 * last send that may have reached Odoo (0 when none may have); `owner` is the process that claimed a
 * RUNNING record. toString() never shows the reply text.
 */
final class ChatAction {

    enum State { PENDING, RUNNING, DONE, HANDOFF }

    final String id;
    final String configId;
    final String clientUuid;
    final ActionKind kind;
    final long channelId;
    /** The target message, 0 when unknown. */
    final long messageId;
    /** The newest stacked push's ntfy time (UTC seconds): mark read's search bound without a message id. */
    final long atMostS;
    final long createdAt;
    /** The reply's text, "" for the other kinds. */
    final String text;
    /** The reaction, "" for the other kinds. */
    final String content;

    State state;
    long sentAt;
    long nextAt;
    int attempts;
    String reason;
    String answer;
    long doneAt;
    String owner;

    ChatAction(String id, String configId, String clientUuid, ActionKind kind, long channelId, long messageId,
            long atMostS, long createdAt, String text, String content) {
        this.id = id;
        this.configId = configId;
        this.clientUuid = clientUuid;
        this.kind = kind;
        this.channelId = channelId;
        this.messageId = messageId;
        this.atMostS = atMostS;
        this.createdAt = createdAt;
        this.text = text == null ? "" : text;
        this.content = content == null ? "" : content;
        this.state = State.PENDING;
    }

    /** The drain's shape (NativeAction in chatPushPlugin.ts): lower-case kind and state, nulls for 0. */
    JSONObject toJson() {
        try {
            return new JSONObject()
                    .put("id", id)
                    .put("configId", configId)
                    .put("kind", kind.name().toLowerCase(Locale.ROOT))
                    .put("state", state.name().toLowerCase(Locale.ROOT))
                    .put("reason", reason == null ? JSONObject.NULL : reason)
                    .put("channelId", channelId)
                    .put("messageId", messageId == 0 ? JSONObject.NULL : messageId)
                    .put("clientUuid", clientUuid)
                    .put("text", text)
                    .put("content", content)
                    .put("createdAt", createdAt)
                    .put("sentAt", sentAt == 0 ? JSONObject.NULL : sentAt)
                    .put("answer", answer == null ? JSONObject.NULL : answer);
        } catch (JSONException e) {
            throw new IllegalStateException("action unwritable");
        }
    }

    /** Every field, for the sealed record. */
    JSONObject record() throws JSONException {
        return new JSONObject()
                .put("id", id).put("configId", configId).put("clientUuid", clientUuid).put("kind", kind.name())
                .put("channelId", channelId).put("messageId", messageId).put("atMostS", atMostS)
                .put("createdAt", createdAt).put("text", text).put("content", content)
                .put("state", state.name()).put("sentAt", sentAt).put("nextAt", nextAt)
                .put("attempts", attempts).put("reason", reason == null ? JSONObject.NULL : reason)
                .put("answer", answer == null ? JSONObject.NULL : answer).put("doneAt", doneAt)
                .put("owner", owner == null ? JSONObject.NULL : owner);
    }

    static ChatAction fromRecord(JSONObject o) throws JSONException {
        ChatAction a;
        try {
            a = new ChatAction(o.getString("id"), o.getString("configId"), o.getString("clientUuid"),
                    ActionKind.valueOf(o.getString("kind")), o.getLong("channelId"), o.getLong("messageId"),
                    o.getLong("atMostS"), o.getLong("createdAt"), o.getString("text"), o.getString("content"));
            a.state = State.valueOf(o.getString("state"));
        } catch (IllegalArgumentException e) {
            throw new JSONException("unknown kind or state");
        }
        a.sentAt = o.getLong("sentAt");
        a.nextAt = o.getLong("nextAt");
        a.attempts = o.getInt("attempts");
        a.reason = o.isNull("reason") ? null : o.getString("reason");
        a.answer = o.isNull("answer") ? null : o.getString("answer");
        a.doneAt = o.getLong("doneAt");
        a.owner = o.isNull("owner") ? null : o.getString("owner");
        return a;
    }

    @Override
    public String toString() {
        return "ChatAction{" + id + " " + kind + " " + state + "}";
    }
}
