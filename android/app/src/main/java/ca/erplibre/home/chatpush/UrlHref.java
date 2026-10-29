package ca.erplibre.home.chatpush;

import java.io.ByteArrayOutputStream;
import java.net.IDN;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The href of `new URL(text)` for an http or https URL, as the WHATWG URL parser writes it: lower-case
 * scheme and host, an IDN host in punycode, an IPv4 host in dotted decimal, the default port dropped,
 * dot segments resolved, an empty path as "/", and each part percent-encoded with its own set. Null when
 * the parser would throw. It covers the shapes the composer's URL pattern can match; IPv6 hosts cannot occur.
 */
final class UrlHref {

    private UrlHref() {}

    static String of(String input) {
        String url = input;
        int colon = url.indexOf("://");
        if (colon < 0) return null;
        String scheme = url.substring(0, colon).toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        String rest = url.substring(colon + 3);
        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '\\' || c == '?' || c == '#') {
                end = i;
                break;
            }
        }
        String authority = rest.substring(0, end);
        String tail = rest.substring(end);
        String userinfo = "";
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            userinfo = authority.substring(0, at);
            authority = authority.substring(at + 1);
        }
        String hostPort = authority;
        String port = "";
        int pc = hostPort.lastIndexOf(':');
        if (pc >= 0) {
            port = hostPort.substring(pc + 1);
            hostPort = hostPort.substring(0, pc);
        }
        if (hostPort.isEmpty()) return null;
        String host = host(hostPort);
        if (host == null) return null;
        String portOut = "";
        if (!port.isEmpty()) {
            for (int i = 0; i < port.length(); i++) {
                if (port.charAt(i) < '0' || port.charAt(i) > '9') return null;
            }
            String digits = port.replaceFirst("^0+(?=.)", "");
            if (digits.length() > 5 || Integer.parseInt(digits) > 65535) return null;
            int number = Integer.parseInt(digits);
            if (number != (scheme.equals("http") ? 80 : 443)) portOut = ":" + number;
        }
        StringBuilder out = new StringBuilder(scheme).append("://");
        if (!userinfo.isEmpty()) {
            String user = userinfo;
            String pass = "";
            int uc = userinfo.indexOf(':');
            if (uc >= 0) {
                user = userinfo.substring(0, uc);
                pass = userinfo.substring(uc + 1);
            }
            out.append(encode(user, USERINFO));
            if (!pass.isEmpty()) out.append(':').append(encode(pass, USERINFO));
            if (!user.isEmpty() || !pass.isEmpty()) out.append('@');
        }
        out.append(host).append(portOut);
        String fragment = null;
        int hash = tail.indexOf('#');
        if (hash >= 0) {
            fragment = tail.substring(hash + 1);
            tail = tail.substring(0, hash);
        }
        String query = null;
        int q = tail.indexOf('?');
        if (q >= 0) {
            query = tail.substring(q + 1);
            tail = tail.substring(0, q);
        }
        out.append(path(tail));
        if (query != null) out.append('?').append(encode(query, SPECIAL_QUERY));
        if (fragment != null) out.append('#').append(encode(fragment, FRAGMENT));
        return out.toString();
    }

    private static final String FRAGMENT = " \"<>`";
    private static final String SPECIAL_QUERY = " \"#<>'";
    private static final String PATH = " \"#<>?`{}";
    private static final String USERINFO = " \"#<>?`{}/:;=@[\\]^|";

    /** Percent-encodes C0 controls, DEL, every non-ASCII code point (as UTF-8) and the characters of `set`. */
    private static String encode(String text, String set) {
        StringBuilder sb = new StringBuilder();
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        for (byte b : bytes) {
            int c = b & 0xff;
            if (c <= 0x20 && c != 0x20 || c >= 0x7f || set.indexOf((char) c) >= 0 && c < 0x7f) {
                sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 15, 16)));
            } else {
                sb.append((char) c);
            }
        }
        return sb.toString();
    }

    private static String path(String raw) {
        String p = raw.replace('\\', '/');
        if (p.isEmpty()) return "/";
        String[] parts = p.substring(p.startsWith("/") ? 1 : 0).split("/", -1);
        List<String> segs = new ArrayList<>();
        for (int i = 0; i < parts.length; i++) {
            String seg = parts[i];
            String low = seg.toLowerCase(Locale.ROOT);
            boolean last = i == parts.length - 1;
            boolean dotdot = low.equals("..") || low.equals(".%2e") || low.equals("%2e.") || low.equals("%2e%2e");
            boolean dot = low.equals(".") || low.equals("%2e");
            if (dotdot) {
                if (!segs.isEmpty()) segs.remove(segs.size() - 1);
                if (last) segs.add("");
            } else if (dot) {
                if (last) segs.add("");
            } else {
                segs.add(encode(seg, PATH));
            }
        }
        StringBuilder sb = new StringBuilder();
        for (String seg : segs) sb.append('/').append(seg);
        return sb.length() == 0 ? "/" : sb.toString();
    }

    /** The host parser: percent-decode, domain to ASCII, forbidden code points, then the IPv4 check. */
    private static String host(String raw) {
        String decoded = percentDecode(raw);
        if (decoded == null) return null;
        StringBuilder joined = new StringBuilder();
        String[] dotted = decoded.split("[.\\u3002\\uff0e\\uff61]", -1);
        for (int k = 0; k < dotted.length; k++) {
            String l = dotted[k];
            if (!l.chars().allMatch(c -> c < 0x80)) {
                try {
                    l = IDN.toASCII(l, IDN.ALLOW_UNASSIGNED);
                } catch (IllegalArgumentException e) {
                    return null;
                }
            }
            if (k > 0) joined.append('.');
            joined.append(l.toLowerCase(Locale.ROOT));
        }
        String ascii = joined.toString();
        if (ascii.isEmpty()) return null;
        for (String label : ascii.split("\\.", -1)) {
            // A punycode label that does not decode, or does not encode back to itself, is invalid
            if (label.startsWith("xn--")) {
                try {
                    if (!IDN.toASCII(IDN.toUnicode(label, IDN.ALLOW_UNASSIGNED), IDN.ALLOW_UNASSIGNED)
                            .equalsIgnoreCase(label) || IDN.toUnicode(label).equals(label)) {
                        return null;
                    }
                } catch (IllegalArgumentException e) {
                    return null;
                }
            }
        }
        for (int i = 0; i < ascii.length(); i++) {
            char c = ascii.charAt(i);
            if (c <= 0x20 || c == 0x7f || "#%/:<>?@[\\]^|".indexOf(c) >= 0) return null;
        }
        String[] labels = ascii.split("\\.", -1);
        int n = labels.length;
        String lastLabel = labels[n - 1];
        if (lastLabel.isEmpty() && n > 1) lastLabel = labels[n - 2];
        if (endsInNumber(lastLabel)) return ipv4(ascii);
        return ascii;
    }

    private static boolean endsInNumber(String label) {
        if (label.isEmpty()) return false;
        if (label.matches("[0-9]+")) return true;
        return label.matches("0[xX][0-9a-fA-F]*");
    }

    private static String ipv4(String host) {
        String[] parts = host.split("\\.", -1);
        int n = parts.length;
        if (parts[n - 1].isEmpty() && n > 1) n--;
        if (n > 4) return null;
        long[] nums = new long[n];
        for (int i = 0; i < n; i++) {
            Long v = number(parts[i]);
            if (v == null) return null;
            nums[i] = v;
        }
        for (int i = 0; i < n - 1; i++) {
            if (nums[i] > 255) return null;
        }
        long limit = 1L << (8 * (5 - n));
        if (nums[n - 1] >= limit) return null;
        long ipv4 = nums[n - 1];
        for (int i = 0; i < n - 1; i++) ipv4 += nums[i] << (8 * (3 - i));
        return (ipv4 >> 24 & 255) + "." + (ipv4 >> 16 & 255) + "." + (ipv4 >> 8 & 255) + "." + (ipv4 & 255);
    }

    private static Long number(String s) {
        if (s.isEmpty()) return null;
        int radix = 10;
        String d = s;
        if (d.length() >= 2 && (d.startsWith("0x") || d.startsWith("0X"))) {
            radix = 16;
            d = d.substring(2);
        } else if (d.length() >= 2 && d.startsWith("0")) {
            radix = 8;
            d = d.substring(1);
        }
        if (d.isEmpty()) return 0L;
        try {
            return new java.math.BigInteger(d, radix).min(java.math.BigInteger.valueOf(1L << 40)).longValue();
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String percentDecode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] in = s.getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < in.length; i++) {
            if (in[i] == '%' && i + 2 < in.length && hex(in[i + 1]) >= 0 && hex(in[i + 2]) >= 0) {
                out.write(hex(in[i + 1]) * 16 + hex(in[i + 2]));
                i += 2;
            } else {
                out.write(in[i]);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static int hex(byte b) {
        return Character.digit((char) b, 16);
    }
}
