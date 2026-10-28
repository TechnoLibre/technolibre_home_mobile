package ca.erplibre.home.chatpush;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
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

    /** A path segment as URLEncoder writes it: unreserved characters and %XX escapes. */
    private static final String SEGMENT = "(?:[A-Za-z0-9._*~-]|%[0-9A-Fa-f]{2})+";
    private static final String MODEL = "[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)*";
    private static final Pattern LIST = Pattern.compile("/chat");
    private static final Pattern INBOX = Pattern.compile("/chat/inbox\\?s=" + SEGMENT + "&thread=" + MODEL + ",[0-9]+");
    private static final Pattern CHANNEL = Pattern.compile("/chat/" + SEGMENT + "/[0-9]+");
    private static final Pattern DOTS = Pattern.compile("/chat/\\.+/.*");

    private static final Object KEY_LOCK = new Object();

    private ChatPushOpen() {}

    /**
     * The content intent of a notification opening url. Each url gets its
     * own PendingIntent (request code and, from Android 10, identifier), so
     * one notification's extras never replace another's.
     */
    static PendingIntent intent(Context c, String url) {
        Intent i = new Intent(c, ca.erplibre.home.MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_KEY, openKey(c));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) i.setIdentifier("push:" + url);
        return PendingIntent.getActivity(c, url.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * The path the intent asks to open, or null: no extras, a wrong or
     * missing secret, or a path allowedPath refuses. Both extras are removed
     * from the intent whatever the answer, so the same intent never opens
     * twice.
     */
    public static String takeUrl(Context c, Intent i) {
        if (i == null || !i.hasExtra(EXTRA_URL)) return null;
        String url = i.getStringExtra(EXTRA_URL);
        String key = i.getStringExtra(EXTRA_KEY);
        i.removeExtra(EXTRA_URL);
        i.removeExtra(EXTRA_KEY);
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
     * segments or parameters) is refused.
     */
    static boolean allowedPath(String url) {
        if (url == null) return false;
        if (LIST.matcher(url).matches() || INBOX.matcher(url).matches()) return true;
        return CHANNEL.matcher(url).matches() && !DOTS.matcher(url).matches();
    }

    /** Draws the secret once under a lock, so two first notifications never carry two different keys. */
    private static String openKey(Context c) {
        synchronized (KEY_LOCK) {
            return new PushSettingsStore(new PrefsKeyValue(c, ChatPushRuntime.SETTINGS_FILE)).openKey();
        }
    }
}
