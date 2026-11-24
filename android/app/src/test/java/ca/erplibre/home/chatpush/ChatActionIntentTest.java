package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public class ChatActionIntentTest {

    private static final String CONFIG = "https://odoo.exemple.test|alice|base";
    private static final String TAG = "chat:" + CONFIG + ":4";

    private static NotificationModel.Shown shown() {
        NotificationModel.Shown n = new NotificationModel.Shown();
        n.configId = CONFIG;
        n.tag = TAG;
        n.channelId = NotificationModel.chatChannelId(CONFIG);
        n.discussChannelId = 4;
        n.messageId = 12;
        n.at = 1_790_000_000_500L;
        return n;
    }

    @Test
    public void anActionIntentCarriesWhatTheRunnerNeeds() {
        for (ActionKind k : ActionKind.values()) {
            Map<String, Object> extras = ChatActionIntent.extras(shown(), k);
            ChatActionIntent.Parsed p = ChatActionIntent.parse(extras, ChatActionIntent.dataOf(extras));
            assertNotNull(k.name(), p);
            assertEquals(CONFIG, p.configId);
            assertEquals(4, p.channelId);
            assertEquals(12, p.messageId);
            assertEquals(1_790_000_000L, p.atMostS);
            assertEquals(k, p.kind);
            assertEquals(TAG, p.tag);
        }
        // mark read without a message id: the bound alone names the newest message
        NotificationModel.Shown n = shown();
        n.messageId = 0;
        Map<String, Object> extras = ChatActionIntent.extras(n, ActionKind.READ);
        ChatActionIntent.Parsed p = ChatActionIntent.parse(extras, ChatActionIntent.dataOf(extras));
        assertNotNull(p);
        assertEquals(0, p.messageId);
    }

    @Test
    public void anIncompleteIntentParsesToNull() {
        Map<String, Object> full = ChatActionIntent.extras(shown(), ActionKind.REACT);
        String data = ChatActionIntent.dataOf(full);
        assertNull(ChatActionIntent.parse(null, data));
        assertNull(ChatActionIntent.parse(full, null));
        for (String key : full.keySet()) {
            Map<String, Object> less = new HashMap<>(full);
            less.remove(key);
            assertNull(key, ChatActionIntent.parse(less, ChatActionIntent.dataOf(less)));
        }
        Map<String, Object> unknown = new HashMap<>(full);
        unknown.put(ChatActionIntent.EXTRA_KIND, "LIKE");
        assertNull(ChatActionIntent.parse(unknown, ChatActionIntent.dataOf(unknown)));
        // 👍 names its message
        NotificationModel.Shown n = shown();
        n.messageId = 0;
        Map<String, Object> noMessage = ChatActionIntent.extras(n, ActionKind.REACT);
        assertNull(ChatActionIntent.parse(noMessage, ChatActionIntent.dataOf(noMessage)));
        // a target changed after the intent was built no longer matches its data
        Map<String, Object> moved = new HashMap<>(full);
        moved.put(ChatActionIntent.EXTRA_CHANNEL, 5L);
        assertNull(ChatActionIntent.parse(moved, data));
    }

    @Test
    public void requestCodesDifferPerTagAndKind() {
        Set<Integer> codes = new HashSet<>();
        Set<String> data = new HashSet<>();
        String[] tags = {TAG, "chat:" + CONFIG + ":5", "chat:https://odoo.exemple.test|bruno|base:4"};
        for (String tag : tags) {
            for (ActionKind k : ActionKind.values()) {
                codes.add(ChatActionIntent.requestCode(tag, k));
                NotificationModel.Shown n = shown();
                n.tag = tag;
                data.add(ChatActionIntent.dataOf(ChatActionIntent.extras(n, k)));
            }
        }
        int want = tags.length * ActionKind.values().length;
        assertEquals(want, codes.size());
        assertEquals(want, data.size());
        for (String d : data) assertTrue(d, d.startsWith("erplibre-action:") && !d.contains("odoo"));
        assertEquals(ChatActionIntent.requestCode(TAG, ActionKind.MUTE), ChatActionIntent.requestCode(TAG, ActionKind.MUTE));
    }
}
