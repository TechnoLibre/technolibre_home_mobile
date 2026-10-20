package ca.erplibre.home.streamdeck.usb;

/**
 * Completes a permission future whose system broadcast never came back
 * within the requester's timeout, so a caller can tell a dialog left
 * unanswered from one the user refused. The message is the reason sent
 * to JS.
 */
public final class PermissionTimeoutException extends Exception {
    public PermissionTimeoutException() { super("permission_timeout"); }
}
