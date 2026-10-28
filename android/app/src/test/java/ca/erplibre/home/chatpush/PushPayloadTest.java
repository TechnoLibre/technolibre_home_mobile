package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;

import org.json.JSONException;
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

    @Test(expected = JSONException.class)
    public void garbageIsAJsonException() throws Exception {
        parse("not json");
    }
}
