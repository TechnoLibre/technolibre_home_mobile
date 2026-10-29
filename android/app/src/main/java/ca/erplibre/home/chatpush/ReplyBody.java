package ca.erplibre.home.chatpush;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The HTML body of a reply typed in a notification, as the app's composeBody writes it for a text without
 * mention or emoji conversion: linkifyHtml(escapeAndCompact(text)), then the marker comment that lets the
 * sender find the post again.
 */
final class ReplyBody {

    private static final Pattern DOUBLE_BREAK = Pattern.compile("[\\r\\n]{2,}");
    private static final Pattern BREAK = Pattern.compile("[\\r\\n]");
    private static final Pattern INNER_NBSP = Pattern.compile("([^>])&nbsp;([^<])");
    private static final Pattern ENTITY = Pattern.compile("&(amp|lt|gt|#x27|quot|#x60);");

    /** An ASCII word boundary, as JavaScript's \\b (Java's also counts accented letters). */
    private static final String WB = "(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";
    private static final String TAIL = "[-a-z0-9@:%_+~#?&\\[\\]^|{}`\\\\'$/=\u00c0-\u024f\u1e00-\u1eff]";
    /** format.js URL_RE, case-insensitive on ASCII only like a JavaScript pattern without the u flag. */
    private static final Pattern URL_RE = Pattern.compile(WB
            + "(?:https?://\\d{1,3}(?:\\.\\d{1,3}){3}|(?:https?://|(?:www\\.))"
            + "[-a-z0-9@:%._+~#=\u00c0-\u024f\u1e00-\u1eff]{1,256}\\.[a-z]{2,13})" + WB
            + "(?:" + TAIL + "|[.]*" + TAIL + "|,(?!$| )|\\.(?!$| |\\.)|;(?!$| ))*",
            Pattern.CASE_INSENSITIVE);

    private ReplyBody() {}

    static String of(String text, String clientUuid) {
        return linkifyHtml(escapeAndCompact(text)) + "<!-- erplibre-mobile:" + clientUuid + " -->";
    }

    private static String escape(String text) {
        StringBuilder e = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '&': e.append("&amp;"); break;
                case '<': e.append("&lt;"); break;
                case '>': e.append("&gt;"); break;
                case '\'': e.append("&#x27;"); break;
                case '"': e.append("&quot;"); break;
                case '`': e.append("&#x60;"); break;
                default: e.append(c);
            }
        }
        return e.toString();
    }

    private static String unescape(String html) {
        Matcher m = ENTITY.matcher(html);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String name = m.group(1);
            String ch = name.equals("amp") ? "&" : name.equals("lt") ? "<" : name.equals("gt") ? ">"
                    : name.equals("#x27") ? "'" : name.equals("quot") ? "\"" : "`";
            m.appendReplacement(sb, Matcher.quoteReplacement(ch));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /** Odoo's escape, trimmed, a run of line ends as two breaks and any other as one. */
    static String escapeAndCompact(String text) {
        String value = trim(escape(text));
        value = DOUBLE_BREAK.matcher(value).replaceAll("<br/><br/>");
        value = BREAK.matcher(value).replaceAll("<br/>");
        value = value.replace(" ", "&nbsp;");
        value = INNER_NBSP.matcher(value).replaceAll("$1 $2");
        value = value.replace("&nbsp;", " ");
        return trim(value);
    }

    /** The browser parses the body, links the URLs of its text and writes `<br/>` back as `<br>`. */
    private static String linkifyHtml(String body) {
        StringBuilder out = new StringBuilder();
        int current = 0;
        int br;
        while ((br = body.indexOf("<br/>", current)) >= 0) {
            out.append(linkify(unescape(body.substring(current, br)))).append("<br>");
            current = br + 5;
        }
        return out.append(linkify(unescape(body.substring(current)))).toString();
    }

    /** format.js linkify of one plain text: escaped, each URL an anchor with its normalised href. */
    private static String linkify(String text) {
        Matcher m = URL_RE.matcher(text);
        StringBuilder out = new StringBuilder();
        int current = 0;
        while (m.find()) {
            String url = m.group();
            String href = UrlHref.of(url.regionMatches(true, 0, "http://", 0, 7)
                    || url.regionMatches(true, 0, "https://", 0, 8) ? url : "http://" + url);
            if (href == null) continue;
            out.append(escape(text.substring(current, m.start())));
            out.append("<a target=\"_blank\" rel=\"noreferrer noopener\" href=\"").append(escape(href))
                    .append("\">").append(escape(url)).append("</a>");
            current = m.end();
        }
        return out.append(escape(text.substring(current))).toString();
    }

    /** JavaScript's String.trim: white space and line terminators, the no-break space and BOM included. */
    private static String trim(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isBlank(s.charAt(start))) start++;
        while (end > start && isBlank(s.charAt(end - 1))) end--;
        return s.substring(start, end);
    }

    private static boolean isBlank(char c) {
        if (c == ' ' || c >= 0x09 && c <= 0x0d || c == 0xa0 || c == 0x1680 || c >= 0x2000 && c <= 0x200a) return true;
        return c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    }
}
