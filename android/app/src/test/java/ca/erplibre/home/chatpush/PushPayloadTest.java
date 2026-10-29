package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class PushPayloadTest {

    private static PushPayload parse(String json) throws JSONException {
        return PushPayload.parse(json.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void chat() throws Exception {
        PushPayload p = parse("{\"title\": \"MS Chat\", \"options\": {\"icon\": \"/web/image/res.partner/9/avatar_128\","
                + " \"data\": {\"model\": \"discuss.channel\", \"res_id\": 4, \"action\": \"mail.action_discuss\"},"
                + " \"body\": \"Bonjour du test de notification\"}}");
        assertEquals("MS Chat", p.title);
        assertEquals("Bonjour du test de notification", p.body);
        assertEquals("discuss.channel", p.model);
        assertEquals(4L, p.resId);
        assertEquals("mail.action_discuss", p.action);
        assertTrue(p.isChat());
    }

    @Test
    public void group() throws Exception {
        PushPayload p = parse("{\"title\": \"ms chat - MS Chat\", \"options\": {\"icon\": \"/web/image/res.partner/9/avatar_128\","
                + " \"data\": {\"model\": \"discuss.channel\", \"res_id\": 3, \"action\": \"mail.action_discuss\"},"
                + " \"body\": \"Bonjour @Administrator , r\\u00e9union jeudi \\u00e0 10 h\"}}");
        assertEquals("ms chat - MS Chat", p.title);
        assertEquals("Bonjour @Administrator , réunion jeudi à 10 h", p.body);
        assertEquals(3L, p.resId);
        assertTrue(p.isChat());
    }

    @Test
    public void channelWithAction() throws Exception {
        PushPayload p = parse("{\"title\": \"#canal spike - MS Chat\", \"options\": {\"icon\": \"/web/image/res.partner/9/avatar_128\","
                + " \"data\": {\"model\": \"discuss.channel\", \"res_id\": 6, \"action\": \"mail.action_discuss\"},"
                + " \"body\": \"@Administrator peux-tu relire le devis ?\"}}");
        assertEquals("#canal spike - MS Chat", p.title);
        assertEquals(6L, p.resId);
        assertEquals("mail.action_discuss", p.action);
        assertTrue(p.isChat());
    }

    @Test
    public void recordCommentHasNoActionAndIsNotChat() throws Exception {
        PushPayload p = parse("{\"title\": \"MS Boite: T\\u00e2che spike\", \"options\": {\"icon\": \"/web/image/res.partner/10/avatar_128\","
                + " \"data\": {\"model\": \"project.task\", \"res_id\": 2}, \"body\": \"Le client a confirm\\u00e9 la date.\"}}");
        assertEquals("MS Boite: Tâche spike", p.title);
        assertEquals("project.task", p.model);
        assertEquals(2L, p.resId);
        assertEquals("", p.action);
        assertFalse(p.isChat());
    }

    @Test
    public void emptyResIdReadsAsZero() throws Exception {
        PushPayload p = parse("{\"title\": \"x\", \"options\": {\"data\": {\"model\": \"res.partner\", \"res_id\": \"\"}, \"body\": \"b\"}}");
        assertEquals(0L, p.resId);
    }

    @Test
    public void accentedTitleEscapedAsUnicodeIsDecoded() throws Exception {
        PushPayload p = parse("{\"title\": \"\\u00c9quipe\", \"options\": {\"body\": \"\"}}");
        assertEquals("Équipe", p.title);
        assertEquals("", p.model);
    }

    /** A plaintext captured from Odoo 18, under test/resources/chatpush. */
    static byte[] resource(String name) throws Exception {
        try (InputStream in = PushPayloadTest.class.getResourceAsStream("/chatpush/" + name)) {
            return in.readAllBytes();
        }
    }

    @Test
    public void a15ChatPushCarriesItsMessageIdAndType() throws Exception {
        PushPayload chat = PushPayload.parse(resource("push_module_chat.json"));
        assertEquals(PushPayload.Kind.MESSAGE, chat.kind);
        assertEquals(17L, chat.messageId);
        assertEquals("chat", chat.channelType);
        assertEquals(4L, chat.resId);
        assertEquals("MS Chat", chat.title);
        assertTrue(chat.isChat());
        PushPayload group = PushPayload.parse(resource("push_module_group.json"));
        assertEquals(18L, group.messageId);
        assertEquals("group", group.channelType);
        PushPayload channel = PushPayload.parse(resource("push_module_channel.json"));
        assertEquals(19L, channel.messageId);
        assertEquals("channel", channel.channelType);
        assertEquals("#canal module - MS Chat", channel.title);
        PushPayload record = PushPayload.parse(resource("push_module_record.json"));
        assertEquals(PushPayload.Kind.MESSAGE, record.kind);
        assertEquals(22L, record.messageId);
        assertEquals("", record.channelType);
        assertFalse(record.isChat());
    }

    @Test
    public void aStockPushHasNoMessageId() throws Exception {
        String plain = new JSONObject(new String(resource("odoo18_push.json"), StandardCharsets.UTF_8))
                .getString("plaintext");
        PushPayload p = parse(plain);
        assertEquals(PushPayload.Kind.MESSAGE, p.kind);
        assertEquals(0L, p.messageId);
        assertEquals("", p.channelType);
        assertTrue(p.isChat());
    }

    @Test
    public void aReadPushIsReadWithItsChannelAndId() throws Exception {
        PushPayload p = PushPayload.parse(resource("push_read.json"));
        assertEquals(PushPayload.Kind.READ, p.kind);
        assertEquals(4L, p.channelId);
        assertEquals(23L, p.lastMessageId);
        assertFalse(p.isChat());
        assertEquals("", p.title);
    }

    @Test
    public void anInboxDonePushListsItsThreadsNullForAll() throws Exception {
        PushPayload p = PushPayload.parse(resource("push_inbox_done.json"));
        assertEquals(PushPayload.Kind.INBOX_DONE, p.kind);
        List<String[]> threads = p.threads;
        assertEquals(1, threads.size());
        assertArrayEquals(new String[] {"project.task", "1"}, threads.get(0));
        JSONObject all = new JSONObject(new String(resource("push_inbox_done.json"), StandardCharsets.UTF_8));
        all.getJSONObject("erplibre").put("threads", JSONObject.NULL);
        PushPayload every = parse(all.toString());
        assertEquals(PushPayload.Kind.INBOX_DONE, every.kind);
        assertNull(every.threads);
    }

    @Test(expected = JSONException.class)
    public void garbageIsAJsonException() throws Exception {
        parse("not json");
    }
}
