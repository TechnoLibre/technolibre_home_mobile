package ca.erplibre.home.chatpush;

/** The native copy of an account's Odoo session. toString() never shows the session id. */
final class NativeSession {

    final String configId;
    final String odooUrl;
    final String database;
    final String sessionId;
    final long savedAt;

    NativeSession(String configId, String odooUrl, String database, String sessionId, long savedAt) {
        this.configId = configId;
        this.odooUrl = odooUrl;
        this.database = database;
        this.sessionId = sessionId;
        this.savedAt = savedAt;
    }

    @Override
    public String toString() {
        return "NativeSession{" + configId + "}";
    }
}
