package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;

public class UnreadSummaryTest {

    // 2024-01-01 00:00:00 UTC
    private static final long NOW = 1704067200000L;

    private static JSONObject load() throws Exception {
        try (InputStream in = UnreadSummaryTest.class.getResourceAsStream("/chatpush/mail_data_counters.json")) {
            byte[] buf = new byte[in.available()];
            int n = 0;
            while (n < buf.length) n += in.read(buf, n, buf.length - n);
            return new JSONObject(new String(buf, StandardCharsets.UTF_8));
        }
    }

    @Test
    public void chatsCountUnreadChannelsCountMentions() throws Exception {
        JSONObject d = load();
        d.getJSONObject("Store").getJSONObject("inbox").put("counter", 0);
        // chats 2+1, group 4, channel mention 3, channel without mention 0, muted chat and unpinned chat out
        assertEquals(10, UnreadSummary.of(d, null, NOW).total);
    }

    @Test
    public void aMutedConversationAndTheGlobalMuteCountNothing() throws Exception {
        JSONObject d = load();
        d.getJSONObject("Store").getJSONObject("inbox").put("counter", 0);
        d.getJSONArray("discuss.channel").getJSONObject(0).put("mute_until_dt", "2024-01-01 00:00:01");
        assertEquals(8, UnreadSummary.of(d, null, NOW).total);
        d.getJSONArray("discuss.channel").getJSONObject(0).put("mute_until_dt", "2023-12-31 23:59:59");
        assertEquals(10, UnreadSummary.of(d, null, NOW).total);
        assertEquals(0, UnreadSummary.of(d, "9999-12-31 23:59:59", NOW).total);
        assertEquals(10, UnreadSummary.of(d, "2023-01-01 00:00:00", NOW).total);
    }

    @Test
    public void theInboxCountsOnceWithoutTheChannelMentions() throws Exception {
        JSONObject d = load();
        // inbox 7 holds the 3 mentions of the channel and the 2 of an unpinned chat, which the JS
        // takes out too (it subtracts every cached channel's mentions): 2 left, plus 10
        assertEquals(12, UnreadSummary.of(d, null, NOW).total);
        d.getJSONObject("Store").getJSONObject("inbox").put("counter", 1);
        assertEquals(10, UnreadSummary.of(d, null, NOW).total);
        d.getJSONObject("Store").getJSONObject("inbox").put("counter", 6);
        assertEquals(11, UnreadSummary.of(d, null, NOW).total);
    }

    @Test
    public void conversationsAtZeroAreListedAsRead() throws Exception {
        UnreadSummary s = UnreadSummary.of(load(), null, NOW);
        assertTrue(s.readChannelIds.contains(5L));
        assertTrue(s.readChannelIds.contains(7L));
        assertFalse(s.readChannelIds.contains(1L));
        assertFalse(s.readChannelIds.contains(6L));
        assertFalse(s.readChannelIds.contains(8L));
    }
}
