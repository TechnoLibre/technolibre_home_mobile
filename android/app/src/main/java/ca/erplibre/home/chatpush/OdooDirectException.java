package ca.erplibre.home.chatpush;

/** A failed direct Odoo call, classified. The message carries the kind and an HTTP status at most. */
final class OdooDirectException extends Exception {

    /** NOT_FOUND is an HTTP 404 or 410: the route, or what it names, does not exist on that server. */
    enum Kind { SESSION_EXPIRED, NOT_FOUND, UNREACHABLE, HTTP_REFUSED, CLEARTEXT_BLOCKED, PROTOCOL }

    private final Kind kind;

    OdooDirectException(Kind kind, String detail) {
        super(detail == null ? kind.name() : kind.name() + ": " + detail);
        this.kind = kind;
    }

    Kind kind() {
        return kind;
    }
}
