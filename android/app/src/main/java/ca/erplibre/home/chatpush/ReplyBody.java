package ca.erplibre.home.chatpush;

import java.util.regex.Pattern;

/**
 * The HTML body of a reply typed in a notification: the app's escapeAndCompact of the text (no mention, no
 * emoji conversion) followed by the marker comment that lets the sender find the post again.
 */
final class ReplyBody {

    private static final Pattern DOUBLE_BREAK = Pattern.compile("[\\r\\n]{2,}");
    private static final Pattern BREAK = Pattern.compile("[\\r\\n]");
    private static final Pattern INNER_NBSP = Pattern.compile("([^>])&nbsp;([^<])");

    private ReplyBody() {}

    static String of(String text, String clientUuid) {
        return escapeAndCompact(text) + "<!-- erplibre-mobile:" + clientUuid + " -->";
    }

    /** Odoo's escape of six characters, trimmed, a run of line ends as two breaks and any other as one. */
    static String escapeAndCompact(String text) {
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
        String value = trim(e.toString());
        value = DOUBLE_BREAK.matcher(value).replaceAll("<br/><br/>");
        value = BREAK.matcher(value).replaceAll("<br/>");
        value = value.replace(" ", "&nbsp;");
        value = INNER_NBSP.matcher(value).replaceAll("$1 $2");
        value = value.replace("&nbsp;", " ");
        return trim(value);
    }

    /** String.trim() of JavaScript: strips every white space and line terminator, the no-break space included. */
    private static String trim(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isBlank(s.charAt(start))) start++;
        while (end > start && isBlank(s.charAt(end - 1))) end--;
        return s.substring(start, end);
    }

    private static boolean isBlank(char c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '﻿';
    }
}
