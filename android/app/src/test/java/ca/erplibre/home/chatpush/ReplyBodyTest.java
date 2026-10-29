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
        assertEquals("ligne un<br/>ligne deux", bodyOf("ligne un\nligne deux"));
        assertEquals("ligne un<br/><br/>ligne deux", bodyOf("ligne un\n\n\nligne deux"));
        assertEquals("ligne un<br/><br/>ligne deux", bodyOf("ligne un\r\nligne deux"));
        assertEquals("bonjour   le monde", bodyOf("  \n  bonjour   le monde \n  "));
        assertEquals("Bravo 🎉 à tous", bodyOf("Bravo 🎉 à tous"));
    }

    @Test
    public void noMentionAndNoEmojiConversionIsApplied() {
        assertEquals("@everyone :) :grinning:", bodyOf("@everyone :) :grinning:"));
    }

    @Test
    public void theMarkerEndsTheBody() {
        String body = ReplyBody.of("salut", UUID);
        assertEquals("salut" + MARKER, body);
    }
}
