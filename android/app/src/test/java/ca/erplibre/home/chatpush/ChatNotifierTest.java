package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
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

    @Test
    public void theIdsOfAStackAlignOnItsLastMessages() {
        // a notification drawn without ids: one 0 per message
        assertArrayEquals(new long[] {0, 0}, ChatNotifier.aligned(null, 2));
        assertArrayEquals(new long[] {0, 7, 9}, ChatNotifier.aligned(new long[] {7, 9}, 3));
        // the style keeps only its last messages: the ids follow
        assertArrayEquals(new long[] {9, 12}, ChatNotifier.aligned(new long[] {5, 7, 9, 12}, 2));
        assertArrayEquals(new long[] {}, ChatNotifier.aligned(new long[] {5}, 0));
    }

    @Test
    public void aStackGrowsByItsNewIdUpToTheCap() {
        assertArrayEquals(new long[] {7, 9}, ChatNotifier.extended(new long[] {7}, 9));
        assertArrayEquals(new long[] {0}, ChatNotifier.extended(null, 0));
        long[] full = new long[ChatNotifier.MAX_STACK];
        for (int i = 0; i < full.length; i++) full[i] = i + 1;
        long[] more = ChatNotifier.extended(full, 99);
        assertArrayEquals(new long[] {2, 3}, java.util.Arrays.copyOf(more, 2));
        assertTrue(more.length == ChatNotifier.MAX_STACK && more[more.length - 1] == 99);
    }

    @Test
    public void aReadPushKeepsTheIdsAboveItsPoint() {
        assertArrayEquals(new long[] {9}, ChatNotifier.keptIds(new long[] {0, 7, 9}, 7));
        assertArrayEquals(new long[] {}, ChatNotifier.keptIds(new long[] {0, 3}, 7));
    }
}
