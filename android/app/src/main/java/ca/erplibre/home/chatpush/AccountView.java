package ca.erplibre.home.chatpush;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** What the native side knows of one server: label, lock-screen choice and mirrored conversations by id. */
final class AccountView {

    final String configId;
    final String label;
    final LockScreenMode lockScreen;
    final Map<Long, ChannelInfo> channels;

    AccountView(String configId, String label, LockScreenMode lockScreen, Map<Long, ChannelInfo> channels) {
        this.configId = configId;
        this.label = label == null ? "" : label;
        this.lockScreen = lockScreen == null ? LockScreenMode.HIDDEN_LOCKED : lockScreen;
        this.channels = channels == null
                ? Collections.<Long, ChannelInfo>emptyMap()
                : Collections.unmodifiableMap(new HashMap<>(channels));
    }
}
