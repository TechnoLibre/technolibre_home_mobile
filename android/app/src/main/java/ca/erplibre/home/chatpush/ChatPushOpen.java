package ca.erplibre.home.chatpush;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The tap of a chat notification. It opens MainActivity with two extras:
 * the app path to show and the per-install secret of PushSettingsStore.
 * MainActivity is exported, so any app can start it with any extras;
 * takeUrl accepts a path only when the secret matches and the path is one
 * of the three a notification builds.
 */
public final class ChatPushOpen {

    static final String EXTRA_URL = "erplibre.push_open";
    static final String EXTRA_KEY = "erplibre.push_key";
    private static final String ACTION_PREFIX = "ca.erplibre.home.PUSH_OPEN:";

    /** A path segment as encodeURIComponent writes it: its unreserved characters and %XX escapes. */
    private static final String SEGMENT = "((?:[A-Za-z0-9._~!'()*-]|%[0-9A-Fa-f]{2})+)";
    private static final String MODEL = "[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)*";
    private static final Pattern LIST = Pattern.compile("/chat");
    private static final Pattern INBOX = Pattern.compile("/chat/inbox\\?s=" + SEGMENT + "&thread=" + MODEL + ",[0-9]+");
    private static final Pattern CHANNEL = Pattern.compile("/chat/" + SEGMENT + "/[0-9]+");
    /**
     * The app's configId once decoded, "&lt;url&gt;|&lt;username&gt;|&lt;database&gt;":
     * an http(s) URL, a login that may be empty or hold spaces, a database;
     * no part holds a "|" or a control character, and only the login a space.
     */
    private static final Pattern CONFIG_ID = Pattern.compile(
            "https?://[^|\\s\\p{Cntrl}]+\\|[^|\\p{Cntrl}]*\\|[^|\\s\\p{Cntrl}]+");

    private static final Object KEY_LOCK = new Object();

    private ChatPushOpen() {}

    /**
     * The content intent of a notification opening url. The url is part of
     * the intent's action, which PendingIntent matching compares on every
     * Android version: two urls never share a PendingIntent, so one
     * notification's extras never replace another's. Notifications that
     * open the same url share one, with the same extras. No other part of
     * the app reads this action.
     */
    static PendingIntent intent(Context c, String url) {
        Intent i = new Intent(c, ca.erplibre.home.MainActivity.class)
                .setAction(ACTION_PREFIX + url)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_KEY, openKey(c));
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * The path the intent asks to open, or null: no extras, a relaunch
     * from Recents (which replays the original intent, extras included), a
     * wrong or missing secret, or a path allowedPath refuses. Both extras
     * are removed from the intent whatever the answer, so the same intent
     * never opens twice.
     */
    public static String takeUrl(Context c, Intent i) {
        if (i == null || !i.hasExtra(EXTRA_URL)) return null;
        String url = i.getStringExtra(EXTRA_URL);
        String key = i.getStringExtra(EXTRA_KEY);
        i.removeExtra(EXTRA_URL);
        i.removeExtra(EXTRA_KEY);
        if ((i.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;
        if (url == null || key == null) return null;
        byte[] want = openKey(c).getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(want, key.getBytes(StandardCharsets.UTF_8))) return null;
        return allowedPath(url) ? url : null;
    }

    /**
     * Whether url is one of the app paths a notification opens: "/chat",
     * "/chat/inbox?s=&lt;configId&gt;&amp;thread=&lt;model&gt;,&lt;resId&gt;"
     * or "/chat/&lt;configId&gt;/&lt;channelId&gt;", the configId written by
     * encodeURIComponent and, once decoded, of the CONFIG_ID shape. Anything
     * else (another scheme, "//host", another route, extra segments or
     * parameters, a raw "/" or ":" in the configId, a malformed escape) is
     * refused.
     */
    static boolean allowedPath(String url) {
        if (url == null) return false;
        if (LIST.matcher(url).matches()) return true;
        Matcher m = INBOX.matcher(url);
        if (!m.matches()) m = CHANNEL.matcher(url);
        if (!m.matches()) return false;
        String configId = decode(m.group(1));
        return configId != null && CONFIG_ID.matcher(configId).matches();
    }

    /** Percent-decodes a segment as UTF-8; null on a malformed escape or bytes that are not UTF-8. */
    private static String decode(String segment) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < segment.length(); i++) {
            char c = segment.charAt(i);
            if (c != '%') {
                if (c > 0x7e) return null;
                out.write(c);
                continue;
            }
            if (i + 2 >= segment.length()) return null;
            int hi = Character.digit(segment.charAt(i + 1), 16);
            int lo = Character.digit(segment.charAt(i + 2), 16);
            if (hi < 0 || lo < 0) return null;
            out.write(hi * 16 + lo);
            i += 2;
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(out.toByteArray()))
                    .toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    /** Draws the secret once under a lock, so two first notifications never carry two different keys. */
    private static String openKey(Context c) {
        synchronized (KEY_LOCK) {
            return new PushSettingsStore(new PrefsKeyValue(c, ChatPushRuntime.SETTINGS_FILE)).openKey();
        }
    }
}
