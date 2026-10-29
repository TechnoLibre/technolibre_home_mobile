package ca.erplibre.home.chatpush;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * What the native side knows of one server: label, lock-screen choice,
 * mirrored conversations by id, and the level of module erplibre_mobile_chat
 * a post would use ("1.5"...), "" when none is used.
 */
final class AccountView {

    final String configId;
    final String label;
    final LockScreenMode lockScreen;
    final Map<Long, ChannelInfo> channels;
    final String module;

    AccountView(String configId, String label, LockScreenMode lockScreen, Map<Long, ChannelInfo> channels) {
        this(configId, label, lockScreen, channels, "");
    }

    AccountView(String configId, String label, LockScreenMode lockScreen, Map<Long, ChannelInfo> channels,
            String module) {
        this.configId = configId;
        this.label = label == null ? "" : label;
        this.lockScreen = lockScreen == null ? LockScreenMode.HIDDEN_LOCKED : lockScreen;
        this.channels = channels == null
                ? Collections.<Long, ChannelInfo>emptyMap()
                : Collections.unmodifiableMap(new HashMap<>(channels));
        this.module = module == null ? "" : module;
    }
}
