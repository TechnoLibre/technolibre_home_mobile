package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.EnumSet;

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
    public void aRepostAfterReactOffersMuteAsItsThirdButton() {
        assertEquals(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.MUTE),
                ChatNotifier.offerFor(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.MUTE), 17L));
    }

    @Test
    public void aRepostKeepsReactWhileTheNewestMessageHasAnId() {
        assertEquals(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.REACT),
                ChatNotifier.offerFor(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.REACT), 17L));
        // A stack without any id: nothing to react to
        assertEquals(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.MUTE),
                ChatNotifier.offerFor(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.REACT), 0L));
    }

    @Test
    public void aNotificationDrawnWithFourKindsIsRepostedWithThree() {
        assertEquals(EnumSet.of(ActionKind.REPLY, ActionKind.READ, ActionKind.REACT),
                ChatNotifier.offerFor(EnumSet.allOf(ActionKind.class), 17L));
        assertTrue(ChatNotifier.offerFor(EnumSet.noneOf(ActionKind.class), 17L).isEmpty());
    }

    @Test
    public void theTargetIsTheNewestMessageWithAnIdAboveTheUsersOwnReply() {
        NotificationModel.Shown t = ChatNotifier.targetOf("chat:cfg1:4", new long[] {7, 9, 0}, 5L);
        assertEquals(9L, t.messageId);
        assertEquals(4L, t.discussChannelId);
        assertEquals(0L, ChatNotifier.targetOf("chat:cfg1:4", new long[] {0, 0}, 5L).messageId);
        assertEquals(0L, ChatNotifier.targetOf("chat:cfg1:4", null, 5L).messageId);
    }

    @Test
    public void aRepostStartsFromWhatWasLastPostedNotFromAStaleReadBack() {
        ChatNotifier.LastPosted<String> posted = new ChatNotifier.LastPosted<>();
        posted.put("chat:cfg1:4", "trois messages", 1_000L);
        // Android still shows the copy before the last post
        assertEquals("trois messages", posted.pick("chat:cfg1:4", "deux messages", 1_100L));
        // Not shown yet, posted a moment ago: the post is still being applied
        assertEquals("trois messages", posted.pick("chat:cfg1:4", null, 1_000L + ChatNotifier.LastPosted.APPLY_MS));
        // Never posted by this process: Android's copy
        assertEquals("deux messages", posted.pick("chat:cfg1:5", "deux messages", 1_100L));
    }

    @Test
    public void aNotificationGoneLongAfterItsPostIsNoLongerDrawn() {
        ChatNotifier.LastPosted<String> posted = new ChatNotifier.LastPosted<>();
        posted.put("chat:cfg1:4", "trois messages", 1_000L);
        assertNull(posted.pick("chat:cfg1:4", null, 1_001L + ChatNotifier.LastPosted.APPLY_MS));
        // forgotten: a later read-back is Android's alone
        assertEquals("deux messages", posted.pick("chat:cfg1:4", "deux messages", 1_002L + ChatNotifier.LastPosted.APPLY_MS));
        posted.put("chat:cfg1:4", "trois messages", 1_000L);
        posted.remove("chat:cfg1:4");
        assertNull(posted.pick("chat:cfg1:4", null, 1_000L));
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
