package ca.erplibre.home.chatpush;

/** A failed direct Odoo call, classified. The message carries the kind and an HTTP status at most. */
final class OdooDirectException extends Exception {

    /**
     * NOT_FOUND is an HTTP 404 or 410, or a JSON-RPC 404: the route, or what it names, does not exist on
     * that server (an auth="public" route answers it to a dead session). REFUSED is a JSON-RPC error other
     * than 100 and 404, or an HTTP 4xx other than 401, 404, 408, 410 and 429: a retry gets the same answer.
     * TRANSIENT is an HTTP 408, 429 or 5xx, or a post answer without a message id: the action may or may
     * not have happened, and a retry is safe. AMBIGUOUS is two messages carrying one marker.
     */
    enum Kind {
        SESSION_EXPIRED, NOT_FOUND, UNREACHABLE, HTTP_REFUSED, CLEARTEXT_BLOCKED, PROTOCOL,
        REFUSED, TRANSIENT, AMBIGUOUS
    }

    private final Kind kind;
    private final boolean rpc;

    OdooDirectException(Kind kind, String detail) {
        this(kind, detail, false);
    }

    /** `rpc` is true when the failure is a JSON-RPC error answered with HTTP 200, false for an HTTP status. */
    OdooDirectException(Kind kind, String detail, boolean rpc) {
        super(detail == null ? kind.name() : kind.name() + ": " + detail);
        this.kind = kind;
        this.rpc = rpc;
    }

    /** True when Odoo answered a JSON-RPC error object rather than an HTTP error status. */
    boolean rpc() {
        return rpc;
    }

    Kind kind() {
        return kind;
    }
}
