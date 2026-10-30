package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;

import androidx.core.app.NotificationCompat;

import org.junit.Test;

public class TestDoorChoiceTest {

    private static final int REPLY = NotificationCompat.Action.SEMANTIC_ACTION_REPLY;
    private static final int READ = NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ;
    private static final int MUTE = NotificationCompat.Action.SEMANTIC_ACTION_MUTE;
    private static final int THUMBS_UP = NotificationCompat.Action.SEMANTIC_ACTION_THUMBS_UP;
    private static final int NONE = NotificationCompat.Action.SEMANTIC_ACTION_NONE;

    @Test
    public void eachKindPicksTheButtonDeclaringItsSemanticAction() {
        int[] withReact = {REPLY, READ, THUMBS_UP};
        assertEquals(0, TestDoorChoice.pick("reply", withReact));
        assertEquals(1, TestDoorChoice.pick("read", withReact));
        assertEquals(2, TestDoorChoice.pick("react", withReact));
        int[] withMute = {REPLY, READ, MUTE};
        assertEquals(2, TestDoorChoice.pick("mute", withMute));
    }

    @Test
    public void aKindTheNotificationDoesNotOfferPicksNothing() {
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("mute", new int[] {REPLY, READ, THUMBS_UP}));
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("react", new int[] {REPLY, READ, MUTE}));
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("read", new int[0]));
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("reply", new int[] {NONE, NONE}));
    }

    @Test
    public void twoButtonsDeclaringTheSameSemanticActionPickNothing() {
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("read", new int[] {READ, REPLY, READ}));
    }

    @Test
    public void openIsTheContentIntentWhateverTheButtons() {
        assertEquals(TestDoorChoice.OPEN, TestDoorChoice.pick("open", new int[] {REPLY, READ, MUTE}));
        assertEquals(TestDoorChoice.OPEN, TestDoorChoice.pick("open", new int[0]));
    }

    @Test
    public void anUnknownOrMissingKindPicksNothing() {
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("delete", new int[] {REPLY, READ, MUTE}));
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("REPLY", new int[] {REPLY, READ, MUTE}));
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick(null, new int[] {REPLY, READ, MUTE}));
        assertEquals(TestDoorChoice.NONE, TestDoorChoice.pick("reply", null));
    }
}
