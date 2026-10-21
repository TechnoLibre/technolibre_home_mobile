package ca.erplibre.home.streamdeck;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;

import ca.erplibre.home.streamdeck.PermissionRequestPlan.Device;
import ca.erplibre.home.streamdeck.usb.PermissionTimeoutException;

/**
 * Which attached decks restartSessions and retryAttach open, and which a
 * resume or the attach intent opens, free of Android types so JUnit
 * covers it.
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
        return idleDecks(attached, busy, null);
    }

    /** idleDecks limited to the device names in {@code only}; null means
     *  every device, as restartSessions without deviceNames. */
    static List<Device> idleDecks(List<Device> attached, Predicate<String> busy,
                                  Set<String> only) {
        List<Device> out = new ArrayList<>();
        for (Device d : attached) {
            if (only != null && !only.contains(d.deviceName)) continue;
            if (!d.isStreamDeck() || !d.permitted) continue;
            if (busy.test(d.deviceName)) continue;
            out.add(d);
        }
        return out;
    }

    /**
     * The decks a resume or the attach intent opens: idleDecks, less every
     * deck ReattachPolicy gave up on after failures other than its
     * permission ({@code gaveUpReason}, null when not given up). Such a
     * deck's reopens kept failing while it held the permission; a
     * registration restores its three retries, so opening it on each
     * resume would start them over each time. A deck given up for its
     * permission is opened once permitted: the grant is what it lacked.
     *
     * Likewise a deck whose last attach failed to open it
     * ({@code lastAttachError}, null when the last attach succeeded or none
     * failed): the grant that completes a waiting attach also brings the
     * attach intent and a resume, and opening the deck again from either
     * would repeat that failure at once. The caller records the failure
     * before releasing the device, so a deck seen free is never seen
     * without it. A deck whose attach lacked the permission is opened.
     */
    static List<Device> returnDecks(List<Device> attached, Predicate<String> busy,
                                    Function<String, String> gaveUpReason,
                                    Function<String, String> lastAttachError,
                                    Set<String> only) {
        List<Device> out = new ArrayList<>();
        for (Device d : idleDecks(attached, busy, only)) {
            if (!grantResolves(gaveUpReason.apply(d.deviceName))) continue;
            if (!grantResolves(lastAttachError.apply(d.deviceName))) continue;
            out.add(d);
        }
        return out;
    }

    /** True for no failure, or one a grant of the permission resolves. */
    private static boolean grantResolves(String failure) {
        return failure == null || isPermissionFailure(failure);
    }

    /** A failure a grant of the USB permission resolves. */
    static boolean isPermissionFailure(String reason) {
        return PermissionTimeoutException.MISSING.equals(reason)
            || PermissionTimeoutException.TIMEOUT.equals(reason)
            || "permission_denied".equals(reason);
    }

    /**
     * The decks a resume asks the permission for, with the plugin's
     * dialog: Stream Decks still without it whose hotplug attach waited for
     * the system's confirmation and got no grant, {@code owesDialog} by
     * device name (PermissionWaits.owesDialog). The confirmation was
     * dismissed, or another app took the device: without this dialog the
     * deck would stay dark with no prompt. Asked once: a dialog shown
     * settles the debt, refused or not. The deck may still be held by that
     * waiting attach, which the dialog's answer completes.
     */
    static List<Device> askDecks(List<Device> attached, Predicate<String> owesDialog) {
        List<Device> out = new ArrayList<>();
        for (Device d : attached) {
            if (!d.isStreamDeck() || d.permitted) continue;
            if (owesDialog.test(d.deviceName)) out.add(d);
        }
        return out;
    }
}
