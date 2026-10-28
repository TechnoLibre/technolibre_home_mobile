package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * One line of an ntfy /json stream. body holds the message bytes: decoded
 * from base64 when the event says "encoding":"base64" (ntfy sets it for a
 * binary body, which every Web Push body is), the UTF-8 bytes of the text
 * otherwise. Events other than "message" have an empty body.
 */
final class NtfyMessage {

    final String id;
    final long time;
    final String event;
    final String topic;
    final byte[] body;

    private NtfyMessage(String id, long time, String event, String topic, byte[] body) {
        this.id = id;
        this.time = time;
        this.event = event;
        this.topic = topic;
        this.body = body;
    }

    /** Parses one JSON line; anything unreadable is a PROTOCOL error that never echoes the line. */
    static NtfyMessage parse(String jsonLine) throws NtfyException {
        try {
            JSONObject o = new JSONObject(jsonLine);
            String event = o.getString("event");
            String text = o.optString("message", "");
            byte[] body;
            if ("base64".equals(o.optString("encoding", ""))) body = B64.decode(text);
            else body = text.getBytes(StandardCharsets.UTF_8);
            return new NtfyMessage(
                    o.optString("id", ""), o.optLong("time", 0), event, o.optString("topic", ""), body);
        } catch (JSONException | IllegalArgumentException e) {
            throw new NtfyException(NtfyException.Kind.PROTOCOL, "bad event line", null);
        }
    }
}
