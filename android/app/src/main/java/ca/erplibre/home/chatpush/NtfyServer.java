package ca.erplibre.home.chatpush;

import java.util.Locale;

/**
 * One ntfy server as the phone reaches it: its base URL, the bearer token,
 * the topic prefix the account's topics start with and the server's cache
 * duration in seconds. The token is never part of toString().
 */
final class NtfyServer {

    final String url;
    final String token;
    final String prefix;
    final int cacheSeconds;

    NtfyServer(String url, String token, String prefix, int cacheSeconds) {
        this.url = normalize(url);
        this.token = token;
        this.prefix = prefix;
        this.cacheSeconds = cacheSeconds;
    }

    /**
     * Lower-cases the scheme and the host (path and port keep their case) and
     * drops trailing slashes, so two spellings of one server compare equal.
     */
    static String normalize(String url) {
        String u = url == null ? "" : url.trim();
        int schemeEnd = u.indexOf("://");
        if (schemeEnd >= 0) {
            int hostEnd = u.indexOf('/', schemeEnd + 3);
            if (hostEnd < 0) hostEnd = u.length();
            u = u.substring(0, hostEnd).toLowerCase(Locale.ROOT) + u.substring(hostEnd);
        }
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    @Override
    public String toString() {
        return "NtfyServer{" + url + "}";
    }
}
