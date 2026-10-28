package ca.erplibre.home.chatpush;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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

    /** A path segment as URLEncoder writes it: unreserved characters and %XX escapes. */
    private static final String SEGMENT = "((?:[A-Za-z0-9._*~-]|%[0-9A-Fa-f]{2})+)";
    private static final String MODEL = "[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)*";
    private static final Pattern LIST = Pattern.compile("/chat");
    private static final Pattern INBOX = Pattern.compile("/chat/inbox\\?s=" + SEGMENT + "&thread=" + MODEL + ",[0-9]+");
    private static final Pattern CHANNEL = Pattern.compile("/chat/" + SEGMENT + "/[0-9]+");
    /** An escaped slash or backslash, which a router that decodes would read as a separator. */
    private static final Pattern ESCAPED_SEPARATOR = Pattern.compile("%(?:2[Ff]|5[Cc])");
    /** Only dots once %2E is decoded: "." or ".." are path steps, not a configId. */
    private static final Pattern DOTS = Pattern.compile("(?:\\.|%2[Ee])+");

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
     * or "/chat/&lt;configId&gt;/&lt;channelId&gt;", the configId URL-encoded.
     * Anything else (another scheme, "//host", another route, extra
     * segments or parameters, a configId that is only dots or holds an
     * escaped slash or backslash) is refused.
     */
    static boolean allowedPath(String url) {
        if (url == null) return false;
        if (LIST.matcher(url).matches()) return true;
        Matcher m = INBOX.matcher(url);
        if (!m.matches()) m = CHANNEL.matcher(url);
        return m.matches() && plainSegment(m.group(1));
    }

    private static boolean plainSegment(String segment) {
        return !ESCAPED_SEPARATOR.matcher(segment).find() && !DOTS.matcher(segment).matches();
    }

    /** Draws the secret once under a lock, so two first notifications never carry two different keys. */
    private static String openKey(Context c) {
        synchronized (KEY_LOCK) {
            return new PushSettingsStore(new PrefsKeyValue(c, ChatPushRuntime.SETTINGS_FILE)).openKey();
        }
    }
}
