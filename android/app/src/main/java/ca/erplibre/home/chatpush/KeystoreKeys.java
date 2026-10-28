package ca.erplibre.home.chatpush;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** AES-256-GCM key held by the Android Keystore under an alias, created on first use. */
final class KeystoreKeys {

    private static final String PROVIDER = "AndroidKeyStore";

    private KeystoreKeys() {}

    static SecretBox.KeyProvider provider(final String alias) {
        return new SecretBox.KeyProvider() {
            @Override
            public SecretKey key() throws GeneralSecurityException {
                synchronized (KeystoreKeys.class) {
                    try {
                        KeyStore ks = KeyStore.getInstance(PROVIDER);
                        ks.load(null);
                        if (ks.containsAlias(alias)) {
                            return (SecretKey) ks.getKey(alias, null);
                        }
                        KeyGenerator g = KeyGenerator.getInstance(
                                KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
                        g.init(new KeyGenParameterSpec.Builder(alias,
                                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                                .setKeySize(256)
                                .build());
                        return g.generateKey();
                    } catch (java.io.IOException e) {
                        throw new GeneralSecurityException("keystore unavailable");
                    }
                }
            }
        };
    }
}
