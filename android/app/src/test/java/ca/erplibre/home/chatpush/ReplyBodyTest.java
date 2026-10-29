package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ReplyBodyTest {

    private static final String UUID = "03b81044-5d6f-4256-9671-773a54cfe4d3";
    private static final String MARKER = "<!-- erplibre-mobile:" + UUID + " -->";

    private static String bodyOf(String text) {
        String body = ReplyBody.of(text, UUID);
        assertTrue(body.endsWith(MARKER));
        return body.substring(0, body.length() - MARKER.length());
    }

    @Test
    public void theBodyIsEscapedAndCompactedAsTheAppDoes() {
        assertEquals("Bonjour tout le monde", bodyOf("Bonjour tout le monde"));
        assertEquals("&lt;b&gt;gras&lt;/b&gt; &amp; &quot;citation&quot; &#x27;apostrophe&#x27; &#x60;accent&#x60;",
                bodyOf("<b>gras</b> & \"citation\" 'apostrophe' `accent`"));
        assertEquals("a  b", bodyOf("a  b"));
        assertEquals("ligne un<br>ligne deux", bodyOf("ligne un\nligne deux"));
        assertEquals("ligne un<br><br>ligne deux", bodyOf("ligne un\n\n\nligne deux"));
        assertEquals("ligne un<br><br>ligne deux", bodyOf("ligne un\r\nligne deux"));
        assertEquals("bonjour   le monde", bodyOf("  \n  bonjour   le monde \n  "));
        assertEquals("Bravo 🎉 à tous", bodyOf("Bravo 🎉 à tous"));
    }

    @Test
    public void noMentionAndNoEmojiConversionIsApplied() {
        assertEquals("@everyone :) :grinning:", bodyOf("@everyone :) :grinning:"));
    }

    @Test
    public void aUrlBecomesTheLinkTheBrowserComposerWrites() {
        assertEquals("voir <a target=\"_blank\" rel=\"noreferrer noopener\" href=\"https://example.com/\">"
                + "https://example.com</a> fin", bodyOf("voir https://example.com fin"));
        assertEquals("a &lt; b<br>line", bodyOf("a < b\nline"));
    }

    @Test
    public void javaScriptTrimKeepsTheSeparatorControlsAndStripsTheOthers() {
        assertEquals("\u001cx\u001f", bodyOf("\u001cx\u001f"));
        assertEquals("x", bodyOf("\u00a0\ufeff\u2003x\u3000"));
    }

    /** Bodies the app's composeBody (no mention, no conversion) produced, goldens of the browser composer included. */
    @Test
    public void everyCaseOfTheAppParityListGivesTheSameBody() throws Exception {
        String text;
        try (java.io.InputStream in = ReplyBodyTest.class.getResourceAsStream("/chatpush/reply_body_parity.json")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            text = new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        }
        org.json.JSONArray cases = new org.json.JSONArray(text);
        assertTrue(cases.length() > 50);
        for (int i = 0; i < cases.length(); i++) {
            org.json.JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getString("name"), c.getString("body") + MARKER, ReplyBody.of(c.getString("text"), UUID));
        }
    }

    @Test
    public void theMarkerEndsTheBody() {
        String body = ReplyBody.of("salut", UUID);
        assertEquals("salut" + MARKER, body);
    }
}
