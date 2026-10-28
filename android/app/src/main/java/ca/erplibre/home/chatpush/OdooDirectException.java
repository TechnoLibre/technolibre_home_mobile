package ca.erplibre.home.chatpush;

/** A failed direct Odoo call, classified. The message carries the kind and an HTTP status at most. */
final class OdooDirectException extends Exception {

    enum Kind { SESSION_EXPIRED, UNREACHABLE, HTTP_REFUSED, CLEARTEXT_BLOCKED, PROTOCOL }

    private final Kind kind;

    OdooDirectException(Kind kind, String detail) {
        super(detail == null ? kind.name() : kind.name() + ": " + detail);
        this.kind = kind;
    }

    Kind kind() {
        return kind;
    }
}
