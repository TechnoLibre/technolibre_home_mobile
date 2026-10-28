package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ChatNotifierTest {

    private static NotificationModel.Shown shown(String author, String text, long at) {
        NotificationModel.Shown n = new NotificationModel.Shown();
        n.author = author;
        n.conversationTitle = "Bruno Tremblay";
        n.text = text;
        n.at = at;
        return n;
    }

    @Test
    public void aReplayedMessageIsARepeatOfTheLastOne() {
        assertTrue(ChatNotifier.repeats("vu", "Alice Martin", 1_790_000_000_000L,
                shown("Alice Martin", "vu", 1_790_000_000_000L)));
    }

    @Test
    public void anotherTextAuthorOrTimeIsANewMessage() {
        long at = 1_790_000_000_000L;
        assertFalse(ChatNotifier.repeats("vu", "Alice Martin", at, shown("Alice Martin", "lu", at)));
        assertFalse(ChatNotifier.repeats("vu", "Alice Martin", at, shown("Bruno Tremblay", "vu", at)));
        assertFalse(ChatNotifier.repeats("vu", "Alice Martin", at, shown("Alice Martin", "vu", at + 1000)));
        assertFalse(ChatNotifier.repeats(null, null, 0L, shown("Alice Martin", "vu", at)));
    }

    @Test
    public void aMessageWithoutTimeIsNeverARepeat() {
        assertFalse(ChatNotifier.repeats("vu", "Alice Martin", 0L, shown("Alice Martin", "vu", 0L)));
    }
}
