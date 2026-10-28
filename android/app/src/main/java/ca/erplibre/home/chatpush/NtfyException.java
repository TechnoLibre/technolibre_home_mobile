package ca.erplibre.home.chatpush;

/**
 * A failed ntfy call, classified. The message carries the kind and an HTTP
 * status at most, never a URL, a token or a body.
 */
final class NtfyException extends Exception {

    enum Kind { UNAUTHORIZED, FORBIDDEN, RATE_LIMITED, UNREACHABLE, HTTP_REFUSED, CLEARTEXT_BLOCKED, PROTOCOL }

    private final Kind kind;

    NtfyException(Kind kind, String detail, Throwable cause) {
        super(detail == null ? kind.name() : kind.name() + ": " + detail, cause);
        this.kind = kind;
    }

    NtfyException(Kind kind) {
        this(kind, null, null);
    }

    Kind kind() {
        return kind;
    }

    /** Maps an HTTP status other than 2xx to its kind; 401, 403 and 429 are named, the rest is PROTOCOL. */
    static NtfyException forStatus(int status) {
        Kind k;
        if (status == 401) k = Kind.UNAUTHORIZED;
        else if (status == 403) k = Kind.FORBIDDEN;
        else if (status == 429) k = Kind.RATE_LIMITED;
        else k = Kind.PROTOCOL;
        return new NtfyException(k, "HTTP " + status, null);
    }

    /**
     * Maps a transport failure: a cleartext refusal by the platform, then any
     * connect, DNS, timeout or reset as UNREACHABLE, the rest as PROTOCOL.
     */
    static NtfyException forIo(java.io.IOException e) {
        Kind k;
        if (e instanceof java.net.UnknownServiceException) k = Kind.CLEARTEXT_BLOCKED;
        else if (e instanceof java.net.ConnectException
                || e instanceof java.net.UnknownHostException
                || e instanceof java.net.NoRouteToHostException
                || e instanceof java.net.SocketException
                || e instanceof java.io.InterruptedIOException) k = Kind.UNREACHABLE;
        else k = Kind.PROTOCOL;
        return new NtfyException(k, e.getClass().getSimpleName(), e);
    }
}
