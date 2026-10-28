package ca.erplibre.home.chatpush;

import java.security.GeneralSecurityException;
import java.security.interfaces.ECPrivateKey;

/**
 * One account's Web Push subscription on a ntfy server: the topic it is
 * pushed to and the key material of RFC 8291. The private key stays sealed
 * until privateKey() is called.
 */
final class Subscription {

    final String configId;
    final String ntfyUrl;
    final String topic;
    final byte[] publicKey;
    final byte[] authSecret;
    private final String sealedPrivate;
    private final SecretBox box;

    Subscription(String configId, String ntfyUrl, String topic, byte[] publicKey, byte[] authSecret,
            String sealedPrivate, SecretBox box) {
        this.configId = configId;
        this.ntfyUrl = ntfyUrl;
        this.topic = topic;
        this.publicKey = publicKey;
        this.authSecret = authSecret;
        this.sealedPrivate = sealedPrivate;
        this.box = box;
    }

    /** Unseals the P-256 private key; IllegalStateException when the seal no longer opens. */
    ECPrivateKey privateKey() {
        try {
            return WebPushKeys.decodePrivate(box.open(sealedPrivate));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("subscription key unreadable");
        }
    }

    @Override
    public String toString() {
        return "Subscription{" + configId + "}";
    }
}
