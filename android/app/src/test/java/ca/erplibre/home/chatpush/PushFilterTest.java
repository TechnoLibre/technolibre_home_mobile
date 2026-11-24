package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;

public class PushFilterTest {

    private static PushPayload payload(String name) throws Exception {
        return PushPayload.parse(PushPayloadTest.resource(name));
    }

    private static AccountView account(PhoneFilter filter, boolean inbox, boolean inboxMentions) {
        return account(filter, inbox, inboxMentions, Collections.<Long, ChannelInfo>emptyMap());
    }

    private static AccountView account(PhoneFilter filter, boolean inbox, boolean inboxMentions,
            Map<Long, ChannelInfo> channels) {
        return new AccountView("cfg1", "Serveur A", LockScreenMode.ALWAYS, channels, "1.6",
                new AccountView.AccountPrefs(filter, inbox, inboxMentions, false, 1320, 420, null));
    }

    private static final String[] CONVERSATIONS = {"push16_chat.json", "push16_group.json",
        "push16_channel_plain.json", "push16_channel_mention.json", "push16_channel_everyone.json",
        "push16_v1_device.json", "push_module_chat.json", "push_module_group.json", "push_module_channel.json"};

    private static final String[] RECORDS = {"push16_record.json", "push16_record_mention.json",
        "push_module_record.json"};

    @Test
    public void allLetsEveryPushThrough() throws Exception {
        AccountView a = account(PhoneFilter.ALL, true, false);
        for (String name : CONVERSATIONS) assertTrue(name, PushFilter.allows(a, payload(name)));
        for (String name : RECORDS) assertTrue(name, PushFilter.allows(a, payload(name)));
    }

    @Test
    public void noneDropsChatAndInbox() throws Exception {
        AccountView a = account(PhoneFilter.NONE, true, true);
        for (String name : CONVERSATIONS) assertFalse(name, PushFilter.allows(a, payload(name)));
        for (String name : RECORDS) assertFalse(name, PushFilter.allows(a, payload(name)));
    }

    @Test
    public void mentionsDmLetsChatAndGroupThrough() throws Exception {
        AccountView a = account(PhoneFilter.MENTIONS_DM, true, false);
        assertTrue(PushFilter.allows(a, payload("push16_chat.json")));
        assertTrue(PushFilter.allows(a, payload("push16_group.json")));
    }

    @Test
    public void mentionsDmDropsAChannelPushWithoutMention() throws Exception {
        assertFalse(PushFilter.allows(account(PhoneFilter.MENTIONS_DM, true, false),
                payload("push16_channel_plain.json")));
    }

    @Test
    public void mentionsDmLetsAMentionedChannelPushThrough() throws Exception {
        AccountView a = account(PhoneFilter.MENTIONS_DM, true, false);
        assertTrue(PushFilter.allows(a, payload("push16_channel_mention.json")));
        assertTrue(PushFilter.allows(a, payload("push16_channel_everyone.json")));
    }

    @Test
    public void withoutThe16FlagsAChannelPushPasses() throws Exception {
        assertTrue(PushFilter.allows(account(PhoneFilter.MENTIONS_DM, true, false),
                payload("push_module_channel.json")));
    }

    @Test
    public void anUnknownTypePasses() throws Exception {
        JSONObject root = new JSONObject(
                new String(PushPayloadTest.resource("push16_channel_plain.json"), StandardCharsets.UTF_8));
        root.getJSONObject("options").getJSONObject("data").getJSONObject("erplibre")
                .put("channel_type", JSONObject.NULL);
        PushPayload untyped = PushPayload.parse(root.toString().getBytes(StandardCharsets.UTF_8));
        assertTrue(PushFilter.allows(account(PhoneFilter.MENTIONS_DM, true, false), untyped));
        // the mirrored type stands in for a missing payload type
        assertFalse(PushFilter.allows(account(PhoneFilter.MENTIONS_DM, true, false,
                Collections.singletonMap(5L, new ChannelInfo("canal", "channel"))), untyped));
    }

    @Test
    public void inboxOffDropsARecordPushAndKeepsChat() throws Exception {
        AccountView a = account(PhoneFilter.ALL, false, false);
        assertFalse(PushFilter.allows(a, payload("push16_record.json")));
        assertFalse(PushFilter.allows(a, payload("push_module_record.json")));
        assertTrue(PushFilter.allows(a, payload("push16_chat.json")));
        assertTrue(PushFilter.allows(a, payload("push16_channel_plain.json")));
    }

    @Test
    public void inboxOffDropsAMentionedRecordPushByDefault() throws Exception {
        assertFalse(PushFilter.allows(account(PhoneFilter.ALL, false, false), payload("push16_record_mention.json")));
    }

    @Test
    public void inboxOffWithRecordMentionsLetsAMentionedRecordPushThrough() throws Exception {
        assertTrue(PushFilter.allows(account(PhoneFilter.ALL, false, true), payload("push16_record_mention.json")));
    }

    @Test
    public void inboxOffWithRecordMentionsDropsAnUnmentionedRecordPush() throws Exception {
        assertFalse(PushFilter.allows(account(PhoneFilter.ALL, false, true), payload("push16_record.json")));
    }

    @Test
    public void recordMentionsWithoutThe16FlagsDropTheRecordPush() throws Exception {
        assertFalse(PushFilter.allows(account(PhoneFilter.ALL, false, true), payload("push_module_record.json")));
    }
}
