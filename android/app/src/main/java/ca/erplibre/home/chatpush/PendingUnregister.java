package ca.erplibre.home.chatpush;

/** A push endpoint to unregister from Odoo at the next run that reaches it, since the epoch-ms it was queued. */
final class PendingUnregister {

    final String configId;
    final String endpoint;
    final long since;

    PendingUnregister(String configId, String endpoint, long since) {
        this.configId = configId;
        this.endpoint = endpoint;
        this.since = since;
    }

    @Override
    public String toString() {
        return "PendingUnregister{" + configId + "}";
    }
}
