package ca.erplibre.home.chatpush;

/** What a notification shows on the lock screen, one choice per server. */
enum LockScreenMode {
    /** Public line "new message - server" while locked, author and text once unlocked. */
    HIDDEN_LOCKED("hidden_locked"),
    /** Always the generic "new message", even unlocked. */
    NEVER("never"),
    /** Author and text, locked or not. */
    ALWAYS("always");

    final String key;

    LockScreenMode(String key) {
        this.key = key;
    }

    /** The mode stored under key; null or unknown falls back to the most private visible one. */
    static LockScreenMode fromKey(String key) {
        for (LockScreenMode m : values()) {
            if (m.key.equals(key)) return m;
        }
        return HIDDEN_LOCKED;
    }
}
