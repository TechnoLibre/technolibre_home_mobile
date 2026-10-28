package ca.erplibre.home.chatpush;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;

/**
 * What a push becomes on screen, decided without Android: the channel and
 * group it belongs to (per server), its tag (one notification per
 * conversation or record), the texts, and the lock-screen visibility. The
 * Android notifier only draws a Shown.
 */
final class NotificationModel {

    private NotificationModel() {}

    /** One notification to draw. publicTitle is the lock-screen version; the summary has no text. */
    static final class Shown {
        String channelId;
        String groupId;
        String tag;
        String conversationTitle = "";
        String author = "";
        String text = "";
        String publicTitle = "";
        String openUrl = "";
        /** Drawn as a conversation (author, text) rather than a plain title and text. */
        boolean messaging;
        /** Android VISIBILITY_PRIVATE: publicTitle on the locked screen. False is VISIBILITY_PUBLIC. */
        boolean privateVisibility;
    }

    /** First 12 hex digits of SHA-256(configId): a stable per-server suffix that does not spell the id. */
    static String hashOf(String configId) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(configId.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) {
                sb.append(String.format("%02x", d[i] & 0xff));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String chatChannelId(String configId) {
        return "chat." + hashOf(configId);
    }

    static String inboxChannelId(String configId) {
        return "inbox." + hashOf(configId);
    }

    static String groupId(String configId) {
        return "server." + hashOf(configId);
    }

    /**
     * A discuss channel push. The conversation is the mirrored channel name
     * (else the payload title); the author is the payload title minus the
     * prefix Odoo builds for that conversation type ("#name - " for a
     * channel, "name - " for a group, nothing for a chat), else the whole title.
     */
    static Shown chat(AccountView a, PushPayload p, PushStrings s) {
        Shown out = base(a, chatChannelId(a.configId), "chat:" + a.configId + ":" + p.resId);
        ChannelInfo info = a.channels.get(p.resId);
        boolean known = info != null && !info.name.isEmpty();
        out.conversationTitle = known ? info.name : p.title;
        out.author = known ? authorOf(p.title, info) : p.title;
        out.text = p.body.isEmpty() ? s.get("new_message") : p.body;
        out.openUrl = "/chat/" + encode(a.configId) + "/" + p.resId;
        out.messaging = true;
        applyLockScreen(out, a, s);
        return out;
    }

    /** A comment on a record, shown in the "inbox" channel and opened in the inbox thread. */
    static Shown inbox(AccountView a, PushPayload p, PushStrings s) {
        Shown out = base(a, inboxChannelId(a.configId), "inbox:" + a.configId + ":" + p.model + ":" + p.resId);
        out.conversationTitle = p.title;
        out.text = p.body.isEmpty() ? s.get("new_message") : p.body;
        out.openUrl = "/chat/inbox?s=" + encode(a.configId) + "&thread=" + p.model + "," + p.resId;
        out.messaging = false;
        applyLockScreen(out, a, s);
        return out;
    }

    /**
     * The group summary of a server's notifications. It names the server and
     * the count and carries no message text, so it is public whatever the
     * lock-screen choice.
     */
    static Shown summary(AccountView a, int count, PushStrings s) {
        Shown out = base(a, chatChannelId(a.configId), "summary:" + a.configId);
        out.publicTitle = count == 1
                ? s.format("summary_one", Collections.singletonMap("server", a.label))
                : s.format("summary", twoVars("n", String.valueOf(count), "server", a.label));
        out.conversationTitle = out.publicTitle;
        out.openUrl = "/chat";
        out.messaging = false;
        out.privateVisibility = false;
        return out;
    }

    private static Shown base(AccountView a, String channelId, String tag) {
        Shown out = new Shown();
        out.channelId = channelId;
        out.groupId = groupId(a.configId);
        out.tag = tag;
        return out;
    }

    private static String authorOf(String title, ChannelInfo info) {
        String prefix = null;
        if ("channel".equals(info.type)) prefix = "#" + info.name + " - ";
        else if ("group".equals(info.type)) prefix = info.name + " - ";
        if (prefix != null && title.startsWith(prefix) && title.length() > prefix.length()) {
            return title.substring(prefix.length());
        }
        return title;
    }

    private static void applyLockScreen(Shown out, AccountView a, PushStrings s) {
        switch (a.lockScreen) {
            case NEVER:
                String generic = s.get("new_message");
                out.conversationTitle = generic;
                out.author = "";
                out.text = generic;
                out.publicTitle = generic;
                out.messaging = false;
                out.privateVisibility = false;
                break;
            case ALWAYS:
                out.publicTitle = out.conversationTitle;
                out.privateVisibility = false;
                break;
            default:
                out.publicTitle = s.format("new_message_server", Collections.singletonMap("server", a.label));
                out.privateVisibility = true;
                break;
        }
    }

    private static java.util.Map<String, String> twoVars(String k1, String v1, String k2, String v2) {
        java.util.Map<String, String> m = new java.util.HashMap<>();
        m.put(k1, v1);
        m.put(k2, v2);
        return m;
    }

    private static String encode(String v) {
        try {
            return URLEncoder.encode(v, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
