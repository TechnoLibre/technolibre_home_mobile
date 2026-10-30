package ca.erplibre.home.chatpush;

/** What a chat push does while a browser of the same Odoo user is active, one choice for the phone. */
enum BrowserMode {
    /** Shown at once. */
    RING("ring"),
    /** Held for a few seconds, dropped when the conversation is read meanwhile. */
    WAIT("wait"),
    /** Not sent to the phone while the browser is active, by a server that applies the mode. */
    QUIET("quiet");

    private final String key;

    BrowserMode(String key) {
        this.key = key;
    }

    /** The value stored and mirrored for this mode. */
    String key() {
        return key;
    }

    /** The mode stored under k; null or unknown reads as WAIT. */
    static BrowserMode fromKey(String k) {
        for (BrowserMode m : values()) {
            if (m.key.equals(k)) return m;
        }
        return WAIT;
    }
}
