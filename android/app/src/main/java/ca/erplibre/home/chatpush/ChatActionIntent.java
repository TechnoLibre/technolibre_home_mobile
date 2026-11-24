package ca.erplibre.home.chatpush;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The broadcast a notification button sends to ChatActionReceiver: explicit, carrying the target of the
 * action (account, conversation, newest message id, the ntfy time bound of mark read, kind, notification
 * tag) as extras. Its data is "erplibre-action:" + the SHA-256 of those extras, which keeps two targets'
 * PendingIntents apart whatever their request codes and pins the extras: the reply's PendingIntent is
 * mutable (RemoteInput fills it in), a fill-in may merge extras but never replaces the data, so changed
 * extras no longer match it and parse to null. The data never spells the configId (the system logs it).
 */
final class ChatActionIntent {

    static final String ACTION = "ca.erplibre.home.chatpush.ACTION";
    /** The RemoteInput result key of « Répondre ». */
    static final String KEY_REPLY = "erplibre.reply";

    static final String EXTRA_CONFIG = "erplibre.config_id";
    static final String EXTRA_CHANNEL = "erplibre.channel_id";
    static final String EXTRA_MESSAGE = "erplibre.message_id";
    static final String EXTRA_AT_MOST = "erplibre.at_most_s";
    static final String EXTRA_KIND = "erplibre.kind";
    static final String EXTRA_TAG = "erplibre.tag";

    private static final String DATA_PREFIX = "erplibre-action:";
    private static final String[] STRING_KEYS = {EXTRA_CONFIG, EXTRA_KIND, EXTRA_TAG};
    private static final String[] LONG_KEYS = {EXTRA_CHANNEL, EXTRA_MESSAGE, EXTRA_AT_MOST};

    private ChatActionIntent() {}

    /** What the receiver needs to record an action; messageId 0 is unknown. */
    static final class Parsed {
        final String configId;
        final long channelId;
        final long messageId;
        final long atMostS;
        final ActionKind kind;
        final String tag;

        Parsed(String configId, long channelId, long messageId, long atMostS, ActionKind kind, String tag) {
            this.configId = configId;
            this.channelId = channelId;
            this.messageId = messageId;
            this.atMostS = atMostS;
            this.kind = kind;
            this.tag = tag;
        }
    }

    /**
     * The extras of kind k on n: n.configId, n.discussChannelId, n.messageId (the newest message of the
     * stack), n.at in UTC seconds, k's name, n.tag.
     */
    static Map<String, Object> extras(NotificationModel.Shown n, ActionKind k) {
        Map<String, Object> m = new HashMap<>();
        m.put(EXTRA_CONFIG, n.configId);
        m.put(EXTRA_CHANNEL, n.discussChannelId);
        m.put(EXTRA_MESSAGE, n.messageId);
        m.put(EXTRA_AT_MOST, n.at > 0 ? n.at / 1000 : 0L);
        m.put(EXTRA_KIND, k.name());
        m.put(EXTRA_TAG, n.tag);
        return m;
    }

    /** "erplibre-action:" + hex SHA-256 over the six extras in a fixed order (a missing one as "null"). */
    static String dataOf(Map<String, ?> extras) {
        StringBuilder sb = new StringBuilder();
        for (String k : new String[] {EXTRA_CONFIG, EXTRA_CHANNEL, EXTRA_MESSAGE, EXTRA_AT_MOST, EXTRA_KIND,
                EXTRA_TAG}) {
            sb.append(String.valueOf(extras == null ? null : extras.get(k))).append('\n');
        }
        return DATA_PREFIX + sha256Hex(sb.toString());
    }

    /**
     * The target, or null when an extra is missing or of another type, the configId or tag is empty, the
     * conversation id is not positive, the kind unknown, a 👍 has no message id, or the data does not match
     * the extras.
     */
    static Parsed parse(Map<String, ?> extras, String data) {
        if (extras == null || data == null) return null;
        for (String k : STRING_KEYS) {
            if (!(extras.get(k) instanceof String) || ((String) extras.get(k)).isEmpty()) return null;
        }
        for (String k : LONG_KEYS) {
            if (!(extras.get(k) instanceof Long)) return null;
        }
        if (!MessageDigest.isEqual(dataOf(extras).getBytes(StandardCharsets.UTF_8),
                data.getBytes(StandardCharsets.UTF_8))) {
            return null;
        }
        ActionKind kind;
        try {
            kind = ActionKind.valueOf((String) extras.get(EXTRA_KIND));
        } catch (IllegalArgumentException e) {
            return null;
        }
        long channel = (Long) extras.get(EXTRA_CHANNEL);
        long message = (Long) extras.get(EXTRA_MESSAGE);
        if (channel <= 0 || message < 0 || (kind == ActionKind.REACT && message == 0)) return null;
        return new Parsed((String) extras.get(EXTRA_CONFIG), channel, message, (Long) extras.get(EXTRA_AT_MOST),
                kind, (String) extras.get(EXTRA_TAG));
    }

    /**
     * The PendingIntent request code of kind k on the notification tagged tag: the first four bytes of the
     * tag's SHA-256 with the kind in the low three bits, so the kinds of one tag never share a code.
     */
    static int requestCode(String tag, ActionKind k) {
        String hex = sha256Hex(tag);
        int h = (int) Long.parseLong(hex.substring(0, 8), 16);
        return (h & ~0x7) | k.ordinal();
    }

    /** The explicit broadcast of kind k on n, to the non-exported ChatActionReceiver. */
    static Intent of(Context c, NotificationModel.Shown n, ActionKind k) {
        Map<String, Object> m = extras(n, k);
        Intent i = new Intent(c, ChatActionReceiver.class).setAction(ACTION).setData(Uri.parse(dataOf(m)));
        for (String key : STRING_KEYS) i.putExtra(key, (String) m.get(key));
        for (String key : LONG_KEYS) i.putExtra(key, (long) (Long) m.get(key));
        return i;
    }

    /** The button's PendingIntent: mutable for the reply (its RemoteInput), immutable otherwise. */
    static PendingIntent pending(Context c, NotificationModel.Shown n, ActionKind k) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (k != ActionKind.REPLY) flags |= PendingIntent.FLAG_IMMUTABLE;
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(c, requestCode(n.tag, k), of(c, n, k), flags);
    }

    /** The target of a received broadcast, or null (see parse); an extras bundle that does not unparcel too. */
    static Parsed parse(Intent i) {
        if (i == null || !ACTION.equals(i.getAction())) return null;
        try {
            Bundle b = i.getExtras();
            if (b == null) return null;
            Map<String, Object> m = new HashMap<>();
            for (String k : STRING_KEYS) {
                if (b.containsKey(k)) m.put(k, b.getString(k));
            }
            for (String k : LONG_KEYS) {
                if (b.containsKey(k)) m.put(k, b.getLong(k));
            }
            return parse(m, i.getDataString());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String sha256Hex(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format(Locale.ROOT, "%02x", x & 0xff));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
