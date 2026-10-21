package ca.erplibre.home.streamdeck.usb;

/**
 * Completes a permission future that no answer completed by its deadline,
 * so a caller can tell a request left unanswered from one the user
 * refused. The message is the reason sent to JS: {@link #TIMEOUT} when the
 * permission dialog was shown, {@link #MISSING} when the request only
 * waited for a grant from another path.
 */
public final class PermissionTimeoutException extends Exception {

    /** The dialog shown got no answer in time. */
    public static final String TIMEOUT = "permission_timeout";
    /** No path granted the permission in time, and no dialog was shown. */
    public static final String MISSING = "permission_missing";

    public PermissionTimeoutException() { this(TIMEOUT); }

    public PermissionTimeoutException(String reason) { super(reason); }
}
