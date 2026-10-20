package ca.erplibre.home.streamdeck;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

import ca.erplibre.home.streamdeck.PermissionRequestPlan.Device;

/**
 * Which attached decks restartSessions and retryAttach open, free of
 * Android types so JUnit covers it.
 *
 * A session that closes itself — reader failure, polled reset, failed
 * write — leaves the registry while its deck stays plugged in, and no
 * hotplug attach follows. Selecting on what is attached rather than on
 * what is registered is what reopens such a deck.
 */
final class ReattachPlan {

    private ReattachPlan() {}

    /**
     * Every known Stream Deck in {@code attached} that already has
     * permission and that {@code busy} — a session or an attach in flight
     * on that device name — does not hold. A deck without permission is
     * left out: attaching it would raise the system dialog.
     */
    static List<Device> idleDecks(List<Device> attached, Predicate<String> busy) {
        List<Device> out = new ArrayList<>();
        for (Device d : attached) {
            if (!d.isStreamDeck() || !d.permitted) continue;
            if (busy.test(d.deviceName)) continue;
            out.add(d);
        }
        return out;
    }
}
