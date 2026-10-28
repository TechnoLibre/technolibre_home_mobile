package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

public class NotificationModelTest {

    private static final String CONFIG = "upab12cd34";

    private static PushPayload payload(String title, String body, String model, long resId, String action)
            throws Exception {
        String json = new org.json.JSONObject()
                .put("title", title)
                .put("options", new org.json.JSONObject()
                        .put("body", body)
                        .put("data", new org.json.JSONObject()
                                .put("model", model)
                                .put("res_id", resId)
                                .put("action", action)))
                .toString();
        return PushPayload.parse(json.getBytes(StandardCharsets.UTF_8));
    }

    private static AccountView account(LockScreenMode mode) {
        Map<Long, ChannelInfo> channels = new HashMap<>();
        channels.put(4L, new ChannelInfo("", "chat"));
        channels.put(5L, new ChannelInfo("groupe spike", "group"));
        channels.put(6L, new ChannelInfo("canal spike", "channel"));
        return new AccountView(CONFIG, "Serveur Alice", mode, channels);
    }

    private static final PushStrings FR = new PushStrings(new HashMap<>());

    @Test
    public void aChatPushIsTitledByTheConversationTheAuthorFromTheTitle() throws Exception {
        Map<Long, ChannelInfo> channels = new HashMap<>();
        channels.put(4L, new ChannelInfo("Alice Martin", "chat"));
        AccountView a = new AccountView(CONFIG, "Serveur", LockScreenMode.ALWAYS, channels);
        NotificationModel.Shown s =
                NotificationModel.chat(a, payload("Alice Martin", "Bonjour", "discuss.channel", 4, "x"), FR);
        assertEquals("Alice Martin", s.conversationTitle);
        assertEquals("Alice Martin", s.author);
        assertEquals("Bonjour", s.text);
        assertEquals("chat:" + CONFIG + ":4", s.tag);
        assertEquals("/chat/" + CONFIG + "/4", s.openUrl);
        assertTrue(s.messaging);
    }

    @Test
    public void aChannelPushStripsTheNamePrefix() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("#canal spike - Bruno Tremblay", "Salut", "discuss.channel", 6, "x"), FR);
        assertEquals("canal spike", s.conversationTitle);
        assertEquals("Bruno Tremblay", s.author);
    }

    @Test
    public void aGroupPushStripsTheNamePrefix() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("groupe spike - Bruno Tremblay", "Salut", "discuss.channel", 5, "x"), FR);
        assertEquals("groupe spike", s.conversationTitle);
        assertEquals("Bruno Tremblay", s.author);
    }

    @Test
    public void anUnknownConversationKeepsThePayloadTitle() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("#autre - Bruno Tremblay", "Salut", "discuss.channel", 99, "x"), FR);
        assertEquals("#autre - Bruno Tremblay", s.conversationTitle);
        assertEquals("#autre - Bruno Tremblay", s.author);
    }

    @Test
    public void aTitleWithoutTheKnownPrefixKeepsItWhole() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("Bruno Tremblay", "Salut", "discuss.channel", 6, "x"), FR);
        assertEquals("canal spike", s.conversationTitle);
        assertEquals("Bruno Tremblay", s.author);
    }

    @Test
    public void anEmptyBodySaysNewMessage() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("Alice Martin", "", "discuss.channel", 4, "x"), FR);
        assertEquals("Nouveau message", s.text);
    }

    @Test
    public void hiddenWhenLockedIsPrivateWithTheServerInThePublicTitle() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.HIDDEN_LOCKED),
                payload("Alice Martin", "Secret", "discuss.channel", 4, "x"), FR);
        assertTrue(s.privateVisibility);
        assertEquals("Nouveau message — Serveur Alice", s.publicTitle);
        assertEquals("Secret", s.text);
        assertEquals("Alice Martin", s.author);
    }

    @Test
    public void neverShownSaysNewMessageEvenUnlocked() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.NEVER),
                payload("Alice Martin", "Secret", "discuss.channel", 4, "x"), FR);
        assertEquals("Nouveau message", s.conversationTitle);
        assertEquals("Nouveau message", s.text);
        assertEquals("Nouveau message", s.publicTitle);
        assertFalse(s.messaging);
        assertFalse(s.privateVisibility);
        assertFalse(s.author.contains("Alice"));
    }

    @Test
    public void alwaysShownIsPublicWithTheText() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("Alice Martin", "Secret", "discuss.channel", 4, "x"), FR);
        assertFalse(s.privateVisibility);
        assertEquals("Secret", s.text);
        assertEquals("Alice Martin", s.author);
        assertTrue(s.messaging);
    }

    @Test
    public void aRecordPushGoesToTheInboxChannelAndOpensItsThreadInTheInbox() throws Exception {
        NotificationModel.Shown s = NotificationModel.inbox(account(LockScreenMode.ALWAYS),
                payload("MS Boite: Tâche spike", "Un commentaire", "project.task", 12, ""), FR);
        String h = NotificationModel.hashOf(CONFIG);
        assertEquals("inbox." + h, s.channelId);
        assertEquals("server." + h, s.groupId);
        assertEquals("inbox:" + CONFIG + ":project.task:12", s.tag);
        assertEquals("MS Boite: Tâche spike", s.conversationTitle);
        assertEquals("Un commentaire", s.text);
        assertEquals("/chat/inbox?s=" + CONFIG + "&thread=project.task,12", s.openUrl);
        assertFalse(s.messaging);
    }

    @Test
    public void inboxLockScreenFollowsTheSameRule() throws Exception {
        PushPayload p = payload("Titre", "Corps", "project.task", 1, "");
        assertTrue(NotificationModel.inbox(account(LockScreenMode.HIDDEN_LOCKED), p, FR).privateVisibility);
        NotificationModel.Shown never = NotificationModel.inbox(account(LockScreenMode.NEVER), p, FR);
        assertEquals("Nouveau message", never.text);
        assertEquals("Nouveau message", never.conversationTitle);
    }

    @Test
    public void channelIdsArePerServerAndCarryNoConfigIdText() throws Exception {
        PushPayload p = payload("Alice Martin", "x", "discuss.channel", 4, "x");
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS), p, FR);
        String h = NotificationModel.hashOf(CONFIG);
        assertEquals(12, h.length());
        assertTrue(h.matches("[0-9a-f]{12}"));
        assertEquals("chat." + h, s.channelId);
        assertEquals("server." + h, s.groupId);
        assertFalse(s.channelId.contains(CONFIG));
        assertFalse(s.groupId.contains(CONFIG));
        assertNotEquals(h, NotificationModel.hashOf("upzz99yy88"));
    }

    @Test
    public void theSummarySays1OrNNewMessagesAndIsPublic() {
        AccountView a = account(LockScreenMode.HIDDEN_LOCKED);
        NotificationModel.Shown one = NotificationModel.summary(a, 1, FR);
        assertEquals("1 nouveau message — Serveur Alice", one.publicTitle);
        assertFalse(one.privateVisibility);
        assertEquals("summary:" + CONFIG, one.tag);
        assertEquals("chat." + NotificationModel.hashOf(CONFIG), one.channelId);
        assertEquals("/chat", one.openUrl);
        assertEquals("", one.text);
        NotificationModel.Shown three = NotificationModel.summary(a, 3, FR);
        assertEquals("3 nouveaux messages — Serveur Alice", three.publicTitle);
        assertFalse(NotificationModel.summary(account(LockScreenMode.NEVER), 3, FR).privateVisibility);
    }

    @Test
    public void mirroredStringsWinOverTheFrenchFallbacks() throws Exception {
        Map<String, String> m = new HashMap<>();
        m.put("new_message", "New message");
        m.put("summary", "{n} new messages — {server}");
        PushStrings en = new PushStrings(m);
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS),
                payload("Alice Martin", "", "discuss.channel", 4, "x"), en);
        assertEquals("New message", s.text);
        assertEquals("2 new messages — Serveur Alice",
                NotificationModel.summary(account(LockScreenMode.ALWAYS), 2, en).publicTitle);
        assertEquals("Clavardage", en.get("channel_chat"));
    }

    @Test
    public void formatFillsPlaceholders() {
        Map<String, String> vars = new HashMap<>();
        vars.put("server", "S");
        vars.put("reason", "jeton refusé par ntfy");
        assertEquals("Les notifications de S ne passent plus : jeton refusé par ntfy",
                FR.format("status_not_listening", vars));
        assertEquals(LockScreenMode.HIDDEN_LOCKED, LockScreenMode.fromKey("bogus"));
        assertEquals(LockScreenMode.NEVER, LockScreenMode.fromKey("never"));
        assertEquals(LockScreenMode.ALWAYS, LockScreenMode.fromKey("always"));
        assertEquals(LockScreenMode.HIDDEN_LOCKED, LockScreenMode.fromKey(null));
    }
}
