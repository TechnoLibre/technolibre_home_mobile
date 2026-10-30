package ca.erplibre.home.chatpush;

/**
 * Which pushes of one server the phone shows. NONE shows none; ALL and
 * MENTIONS_DM govern conversations only, record and activity pushes follow
 * the account's inbox switch.
 */
enum PhoneFilter {
    /** Every conversation push Odoo sends. */
    ALL("all"),
    /** Direct chats and groups, and a channel push only when it mentions the user. */
    MENTIONS_DM("mentions_dm"),
    /** No push of this server is shown. */
    NONE("none");

    private final String key;

    PhoneFilter(String key) {
        this.key = key;
    }

    /** The value stored and mirrored for this filter. */
    String key() {
        return key;
    }

    /** The filter stored under k; null or unknown reads as ALL. */
    static PhoneFilter fromKey(String k) {
        for (PhoneFilter f : values()) {
            if (f.key.equals(k)) return f;
        }
        return ALL;
    }
}
