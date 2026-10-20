package ca.erplibre.home.streamdeck;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletionException;

import ca.erplibre.home.streamdeck.usb.PermissionTimeoutException;

/**
 * The decisions behind the requestPermission plugin method, free of Android
 * types so JUnit covers them: which attached devices a call targets, what
 * each permission request came to, and whether the call as a whole is
 * granted.
 */
final class PermissionRequestPlan {

    /** One attached USB device, as read from UsbManager. */
    static final class Device {
        final String deviceName;
        final int vendorId;
        final int productId;
        /** USB descriptor serial; "" when unreadable, as Android 10+
         *  hides it until permission is granted. */
        final String serial;
        final boolean permitted;

        Device(String deviceName, int vendorId, int productId, String serial, boolean permitted) {
            this.deviceName = deviceName;
            this.vendorId = vendorId;
            this.productId = productId;
            this.serial = serial != null ? serial : "";
            this.permitted = permitted;
        }

        boolean isStreamDeck() {
            return DeckRegistry.isElgato(vendorId) && DeckRegistry.lookup(productId) != null;
        }
    }

    /** What one device's request came to; {@code wire} is the JS name. */
    enum Outcome {
        /** Permitted before the call: no dialog was shown. */
        ALREADY_GRANTED("already_granted"),
        GRANTED("granted"),
        DENIED("denied"),
        /** The system broadcast did not come back within the timeout. */
        TIMEOUT("timeout"),
        ERROR("error");

        final String wire;
        Outcome(String wire) { this.wire = wire; }
        boolean granted() { return this == ALREADY_GRANTED || this == GRANTED; }
    }

    /** The devices a call targets, or the reason it is refused. */
    static final class Selection {
        final List<Device> targets;
        /** Rejection reason; null when targets is not empty. */
        final String error;

        private Selection(List<Device> targets, String error) {
            this.targets = targets;
            this.error = error;
        }
    }

    private PermissionRequestPlan() {}

    /**
     * Targets of a call. Without {@code deckId} (null or empty), every
     * attached Stream Deck, permitted or not; refused "no_stream_deck"
     * when there is none. With it, the device of the open session that
     * carries this deckId ({@code sessionDevice}, null when none) — its
     * serial comes from a HID report and may differ from the USB one —
     * else the Stream Deck whose USB serial equals it; refused
     * "no_such_deck:&lt;id&gt;" otherwise. A device whose serial is still
     * hidden is reachable only without a deckId.
     */
    static Selection select(List<Device> attached, String deckId, String sessionDevice) {
        List<Device> decks = new ArrayList<>();
        for (Device d : attached) if (d.isStreamDeck()) decks.add(d);
        if (deckId == null || deckId.isEmpty()) {
            if (decks.isEmpty()) return new Selection(Collections.<Device>emptyList(), "no_stream_deck");
            return new Selection(decks, null);
        }
        for (Device d : decks) {
            if (d.deviceName.equals(sessionDevice)) return new Selection(Collections.singletonList(d), null);
        }
        for (Device d : decks) {
            if (deckId.equals(d.serial)) return new Selection(Collections.singletonList(d), null);
        }
        return new Selection(Collections.<Device>emptyList(), "no_such_deck:" + deckId);
    }

    /**
     * Outcome of one device: {@code permittedBefore} wins, since no
     * dialog was shown; else the permission future's value and failure,
     * a PermissionTimeoutException — bare or wrapped by a dependent
     * stage — being a timeout.
     */
    static Outcome outcomeOf(boolean permittedBefore, Boolean granted, Throwable err) {
        if (permittedBefore) return Outcome.ALREADY_GRANTED;
        Throwable cause = err instanceof CompletionException && err.getCause() != null
            ? err.getCause() : err;
        if (cause instanceof PermissionTimeoutException) return Outcome.TIMEOUT;
        if (cause != null) return Outcome.ERROR;
        return Boolean.TRUE.equals(granted) ? Outcome.GRANTED : Outcome.DENIED;
    }

    /** The call is granted when it targeted at least one device and every one is. */
    static boolean allGranted(List<Outcome> outcomes) {
        if (outcomes.isEmpty()) return false;
        for (Outcome o : outcomes) if (!o.granted()) return false;
        return true;
    }
}
