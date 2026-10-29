package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
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
    public void hiddenWhenLockedIsPrivateOnlyWhereAndroidHidesSensitiveContent() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.HIDDEN_LOCKED),
                payload("Alice Martin", "Secret", "discuss.channel", 4, "x"), FR);
        assertEquals(NotificationModel.Visibility.PRIVATE,
                NotificationModel.visibility(s, NotificationModel.Redaction.HIDDEN));
        // Android would draw the private text on the locked screen: nothing is drawn there at all
        assertEquals(NotificationModel.Visibility.SECRET,
                NotificationModel.visibility(s, NotificationModel.Redaction.ALLOWED));
        assertEquals(NotificationModel.Visibility.SECRET,
                NotificationModel.visibility(s, NotificationModel.Redaction.UNKNOWN));
    }

    @Test
    public void neverAlwaysAndTheSummaryArePublicWhateverTheRedaction() throws Exception {
        PushPayload p = payload("Alice Martin", "Secret", "discuss.channel", 4, "x");
        NotificationModel.Shown[] shown = {
            NotificationModel.chat(account(LockScreenMode.NEVER), p, FR),
            NotificationModel.chat(account(LockScreenMode.ALWAYS), p, FR),
            NotificationModel.summary(account(LockScreenMode.HIDDEN_LOCKED), 2, FR),
        };
        for (NotificationModel.Shown s : shown) {
            for (NotificationModel.Redaction r : NotificationModel.Redaction.values()) {
                assertEquals(NotificationModel.Visibility.PUBLIC, NotificationModel.visibility(s, r));
            }
        }
    }

    @Test
    public void theRedactionComesFromTheTwoLockScreenSettings() {
        // lock_screen_show_notifications, lock_screen_allow_private_notifications; null: unreadable
        assertEquals(NotificationModel.Redaction.HIDDEN, NotificationModel.redactionOf(1, 0));
        assertEquals(NotificationModel.Redaction.HIDDEN, NotificationModel.redactionOf(0, 1));
        assertEquals(NotificationModel.Redaction.HIDDEN, NotificationModel.redactionOf(0, null));
        assertEquals(NotificationModel.Redaction.ALLOWED, NotificationModel.redactionOf(1, 1));
        assertEquals(NotificationModel.Redaction.UNKNOWN, NotificationModel.redactionOf(1, null));
        assertEquals(NotificationModel.Redaction.UNKNOWN, NotificationModel.redactionOf(null, null));
        assertEquals(NotificationModel.Redaction.UNKNOWN, NotificationModel.redactionOf(null, 1));
        assertEquals(NotificationModel.Redaction.HIDDEN, NotificationModel.redactionOf(null, 0));
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
    public void anInboxPushWithAnEmptyTitleIsTitledByTheServer() throws Exception {
        NotificationModel.Shown s = NotificationModel.inbox(account(LockScreenMode.ALWAYS),
                payload("", "Un commentaire", "project.task", 12, ""), FR);
        assertEquals("Serveur Alice", s.conversationTitle);
        assertEquals("Un commentaire", s.text);
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

    @Test
    public void aClearTakesWhatItNamesOfItsAccountPostedUpToItsBound() {
        String chat = "chat:" + CONFIG + ":4";
        String inbox = "inbox:" + CONFIG + ":res.partner:70";
        String summary = "summary:" + CONFIG;
        NotificationModel.Clear one = new NotificationModel.Clear(CONFIG, 4L, false, null, null, false, 1000L);
        assertTrue(one.matches(chat, 1000L));
        assertFalse("posted after the bound", one.matches(chat, 1001L));
        assertFalse(one.matches("chat:" + CONFIG + ":5", 0L));
        assertFalse(one.matches(inbox, 0L));

        NotificationModel.Clear record = new NotificationModel.Clear(CONFIG, null, true, "res.partner", 70L, false, 1000L);
        assertTrue(record.matches(inbox, 999L));
        assertFalse(record.matches(inbox, 2000L));
        assertFalse("another record", record.matches("inbox:" + CONFIG + ":res.partner:71", 0L));
        assertFalse(record.matches(chat, 0L));

        NotificationModel.Clear sum = new NotificationModel.Clear(CONFIG, null, false, null, null, true, 1000L);
        assertTrue(sum.matches(summary, 1000L));
        assertFalse(sum.matches(summary, 1001L));

        NotificationModel.Clear all = new NotificationModel.Clear(CONFIG, null, false, null, null, false, null);
        assertTrue(all.matches(chat, Long.MAX_VALUE));
        assertTrue(all.matches(inbox, 0L));
        assertTrue(all.matches(summary, 0L));
        assertFalse("the status one stays", all.matches("status:" + CONFIG, 0L));
        assertFalse("another account", all.matches("chat:" + CONFIG + "x:4", 0L));
    }

    // ---- module 1.5: message ids and actions ----

    private static PushPayload captured(String name) throws Exception {
        return PushPayload.parse(PushPayloadTest.resource(name));
    }

    private static PushPayload stock() throws Exception {
        String plain = new org.json.JSONObject(new String(PushPayloadTest.resource("odoo18_push.json"),
                StandardCharsets.UTF_8)).getString("plaintext");
        return PushPayload.parse(plain.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void hiddenAndAlwaysServersOfferTheFourActionsWithAMessageId() throws Exception {
        for (LockScreenMode mode : new LockScreenMode[] {LockScreenMode.HIDDEN_LOCKED, LockScreenMode.ALWAYS}) {
            NotificationModel.Shown s = NotificationModel.chat(account(mode), captured("push_module_chat.json"), FR);
            assertEquals(mode.key, EnumSet.allOf(ActionKind.class), s.actions);
            assertEquals(CONFIG, s.configId);
            assertEquals(4L, s.discussChannelId);
            assertEquals(17L, s.messageId);
        }
    }

    @Test
    public void withoutAMessageIdThereIsNoReact() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.ALWAYS), stock(), FR);
        assertEquals(0L, s.messageId);
        assertEquals(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.MUTE), s.actions);
    }

    @Test
    public void aNeverServerOffersEveryActionWithItsTextHidden() throws Exception {
        NotificationModel.Shown s = NotificationModel.chat(account(LockScreenMode.NEVER),
                captured("push_module_chat.json"), FR);
        assertEquals(EnumSet.allOf(ActionKind.class), s.actions);
        assertEquals(17L, s.messageId);
        assertEquals("Nouveau message", s.conversationTitle);
        assertEquals("Nouveau message", s.text);
        assertFalse(s.messaging);
    }

    @Test
    public void inboxAndSummaryOfferNothing() throws Exception {
        AccountView a = account(LockScreenMode.ALWAYS);
        assertTrue(NotificationModel.inbox(a, captured("push_module_record.json"), FR).actions.isEmpty());
        assertTrue(NotificationModel.summary(a, 3, FR).actions.isEmpty());
        assertTrue(NotificationModel.status(a, "x").actions.isEmpty());
    }

    @Test
    public void thePayloadTypeStandsInForAMissingMirroredType() throws Exception {
        Map<Long, ChannelInfo> channels = new HashMap<>();
        channels.put(5L, new ChannelInfo("canal module", ""));
        AccountView a = new AccountView(CONFIG, "Serveur", LockScreenMode.ALWAYS, channels);
        NotificationModel.Shown s = NotificationModel.chat(a, captured("push_module_channel.json"), FR);
        assertEquals("canal module", s.conversationTitle);
        assertEquals("MS Chat", s.author);
    }

    @Test
    public void keptAfterReadDropsIdsUpToTheReadPointAndThoseWithoutId() {
        assertEquals(Arrays.asList(9L, 12L), NotificationModel.keptAfterRead(Arrays.asList(5L, 7L, 0L, 9L, 12L), 7));
        assertEquals(Collections.emptyList(), NotificationModel.keptAfterRead(Arrays.asList(0L, 0L), 1));
        assertEquals(Collections.emptyList(), NotificationModel.keptAfterRead(Arrays.asList(3L, 7L), 7));
        assertEquals(Collections.emptyList(), NotificationModel.keptAfterRead(Collections.<Long>emptyList(), 7));
    }
}
