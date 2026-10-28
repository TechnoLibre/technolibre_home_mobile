package ca.erplibre.home.chatpush;

/** A Web Push body that cannot be decrypted; the message names the reason only, never key or body bytes. */
final class WebPushException extends Exception {

    enum Reason { TRUNCATED, BAD_HEADER, AUTH_FAILED, BAD_PADDING }

    private final Reason reason;

    WebPushException(Reason reason) {
        super(reason.name());
        this.reason = reason;
    }

    Reason reason() {
        return reason;
    }
}
