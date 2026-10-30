package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class UnreadSummaryTest {

    // 2024-01-01 00:00:00 UTC
    private static final long NOW = 1704067200000L;

    private static JSONObject load() throws Exception {
        return load("mail_data_counters.json");
    }

    private static JSONObject load(String name) throws Exception {
        try (InputStream in = UnreadSummaryTest.class.getResourceAsStream("/chatpush/" + name)) {
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

    @Test
    public void chatAndInboxSharesAddUpToTheTotal() throws Exception {
        UnreadSummary s = UnreadSummary.of(load(), null, NOW);
        // conversations 10 (see chatsCountUnreadChannelsCountMentions), inbox 7 less 5 channel mentions
        assertEquals(10, s.chat);
        assertEquals(2, s.inbox);
        assertEquals(s.chat + s.inbox, s.total);
    }

    /** The captured /mail/data of Task 0: self partner 3, channel 4 set to « no_notif », 1, 2 and 5 default. */
    private static JSONObject settingsData() throws Exception {
        return load("mail_data_settings.json").getJSONObject("result");
    }

    private static JSONObject channel(JSONObject d, long id) throws Exception {
        for (int i = 0; i < d.getJSONArray("discuss.channel").length(); i++) {
            JSONObject c = d.getJSONArray("discuss.channel").getJSONObject(i);
            if (c.getLong("id") == id) return c;
        }
        throw new AssertionError("no channel " + id);
    }

    @Test
    public void aChannelSetToNothingInOdooCountsNothing() throws Exception {
        JSONObject d = settingsData();
        channel(d, 4).put("message_needaction_counter", 2);
        channel(d, 5).put("message_needaction_counter", 1);
        assertEquals(1, UnreadSummary.of(d, 3, null, null, NOW).total);
        assertEquals(1, UnreadSummary.of(d, 3, null, "all", NOW).total);
        // its mentions are still unread: a notification of it is not cancelled as read
        assertFalse(UnreadSummary.of(d, 3, null, null, NOW).readChannelIds.contains(4L));
    }

    @Test
    public void aDefaultChannelCountsNothingWhenTheGeneralSettingIsNothing() throws Exception {
        JSONObject d = settingsData();
        channel(d, 1).put("message_needaction_counter", 2);
        channel(d, 5).put("message_needaction_counter", 1);
        // the group (self member row 7) counts its unread messages whatever the channel settings
        JSONArray members = d.getJSONArray("discuss.channel.member");
        for (int i = 0; i < members.length(); i++) {
            if (members.getJSONObject(i).getLong("id") == 7) members.getJSONObject(i).put("message_unread_counter", 4);
        }
        assertEquals(7, UnreadSummary.of(d, 3, null, null, NOW).total);
        assertEquals(7, UnreadSummary.of(d, 3, null, "mentions", NOW).total);
        assertEquals(4, UnreadSummary.of(d, 3, null, "no_notif", NOW).total);
        // a channel's own « all » wins over the general « no_notif »
        channel(d, 2).put("custom_notifications", "all").put("message_needaction_counter", 3);
        assertEquals(7, UnreadSummary.of(d, 3, null, "no_notif", NOW).total);
    }
}
