package ca.erplibre.home.chatpush;

import java.util.Locale;

/** Which URLs the ntfy client may call: https always, http only when the caller allows cleartext. */
final class HttpPolicy {

    private HttpPolicy() {}

    static boolean allowed(String url, boolean allowHttp) {
        if (url == null) return false;
        String u = url.toLowerCase(Locale.ROOT);
        if (u.startsWith("https://")) return true;
        return allowHttp && u.startsWith("http://");
    }
}
