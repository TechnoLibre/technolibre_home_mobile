package ca.erplibre.home.chatpush;

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
        /**
         * Hidden when locked: the text never on a locked screen, publicTitle
         * at most (see visibility). False is VISIBILITY_PUBLIC.
         */
        boolean privateVisibility;
        /** An update of a notification already drawn: no sound, no vibration, no heads-up. */
        boolean silent;
        /** Epoch ms the message was sent, 0 when unknown (the notifier then dates it when drawn). */
        long at;
    }

    /** Whether Android draws a notification's private content on the locked screen. */
    enum Redaction { ALLOWED, HIDDEN, UNKNOWN }

    /** Android's lock-screen visibility of a notification. */
    enum Visibility { PUBLIC, PRIVATE, SECRET }

    /**
     * The redaction the user's lock-screen settings give: notifications off
     * on the lock screen (lock_screen_show_notifications 0) or sensitive
     * content hidden (lock_screen_allow_private_notifications 0) is HIDDEN,
     * both on is ALLOWED. null is a setting that could not be read; one
     * that hides decides alone, else the answer is UNKNOWN.
     */
    static Redaction redactionOf(Integer showNotifications, Integer allowPrivate) {
        if ((showNotifications != null && showNotifications == 0) || (allowPrivate != null && allowPrivate == 0)) {
            return Redaction.HIDDEN;
        }
        if (showNotifications == null || allowPrivate == null) return Redaction.UNKNOWN;
        return Redaction.ALLOWED;
    }

    /**
     * How n is posted for the redaction read at that moment. A « masqué si
     * verrouillé » notification is PRIVATE (its public version, publicTitle,
     * on the locked screen) only where Android hides private content; where
     * Android would draw the private content, or the setting is unknown, it
     * is SECRET: nothing on the locked screen, all of it once unlocked. The
     * others are PUBLIC.
     */
    static Visibility visibility(Shown n, Redaction r) {
        if (!n.privateVisibility) return Visibility.PUBLIC;
        return r == Redaction.HIDDEN ? Visibility.PRIVATE : Visibility.SECRET;
    }

    /** The channel shared by every server's status notifications. */
    static final String STATUS_CHANNEL = "status";

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

    /**
     * The state of a server's notifications (not listening, session expired):
     * public, outside the server's group, one per server under tag
     * "status:&lt;configId&gt;", opening the conversation list.
     */
    static Shown status(AccountView a, String text) {
        Shown out = new Shown();
        out.channelId = STATUS_CHANNEL;
        out.tag = "status:" + a.configId;
        out.conversationTitle = a.label;
        out.text = text;
        out.publicTitle = text;
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

    private static final String HEX = "0123456789ABCDEF";

    /**
     * v as encodeURIComponent writes it, as the app builds its own chat
     * routes: A-Z a-z 0-9 - _ . ! ~ * ' ( ) kept, every other UTF-8 byte
     * escaped as %XX in upper case.
     */
    static String encode(String v) {
        StringBuilder sb = new StringBuilder();
        for (byte b : v.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || "-_.!~*'()".indexOf(c) >= 0) {
                sb.append((char) c);
            } else {
                sb.append('%').append(HEX.charAt(c >> 4)).append(HEX.charAt(c & 0xf));
            }
        }
        return sb.toString();
    }
}
