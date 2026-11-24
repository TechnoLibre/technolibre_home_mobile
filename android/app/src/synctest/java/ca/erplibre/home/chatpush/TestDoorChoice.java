package ca.erplibre.home.chatpush;

import androidx.core.app.NotificationCompat;

/**
 * What the test door (ChatTestDoor) sends for a kind on a chat notification: the one action button
 * declaring the kind's semantic action, as ChatNotifier.setActions declares them, or the content intent
 * for "open". Pure: the door reads the semantic actions off the posted notification and sends what this
 * picks.
 */
final class TestDoorChoice {

    /** Nothing to send: the kind is unknown, not offered, or offered twice. */
    static final int NONE = -1;
    /** The notification's content intent, its tap. */
    static final int OPEN = -2;

    private TestDoorChoice() {}

    /**
     * The index in semantics (the semantic action of each button, in order) of the one button declaring
     * kind's semantic action ("reply", "read", "mute", "react"), OPEN for "open", or NONE when kind is
     * unknown, no button declares it or more than one does.
     */
    static int pick(String kind, int[] semantics) {
        if ("open".equals(kind)) return OPEN;
        int wanted = semanticOf(kind);
        if (wanted == NotificationCompat.Action.SEMANTIC_ACTION_NONE || semantics == null) return NONE;
        int found = NONE;
        for (int i = 0; i < semantics.length; i++) {
            if (semantics[i] != wanted) continue;
            if (found != NONE) return NONE;
            found = i;
        }
        return found;
    }

    private static int semanticOf(String kind) {
        if (kind == null) return NotificationCompat.Action.SEMANTIC_ACTION_NONE;
        switch (kind) {
            case "reply":
                return NotificationCompat.Action.SEMANTIC_ACTION_REPLY;
            case "read":
                return NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ;
            case "mute":
                return NotificationCompat.Action.SEMANTIC_ACTION_MUTE;
            case "react":
                return NotificationCompat.Action.SEMANTIC_ACTION_THUMBS_UP;
            default:
                return NotificationCompat.Action.SEMANTIC_ACTION_NONE;
        }
    }
}
