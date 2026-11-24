package ca.erplibre.home.chatpush;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the native side knows of one server: label, lock-screen choice,
 * mirrored conversations by id, the level of module erplibre_mobile_chat
 * a post would use ("1.5"...), "" when none is used, and the account's push
 * preferences (AccountPrefs).
 */
final class AccountView {

    /**
     * One server's push preferences: the phone-side chat filter, the inbox
     * switch and its record-mention exception, quiet hours as minutes of the
     * day (from inclusive, to exclusive), and Odoo's general channel setting
     * ("all", "mentions", "no_notif", null while unknown). Read from and
     * written to the account keys "filter", "inbox", "inboxMentions",
     * "quiet": {"on", "from", "to"} and "channelNotifications"; a missing or
     * invalid value reads as its default.
     */
    static final class AccountPrefs {

        private static final int DEFAULT_QUIET_FROM = 22 * 60;
        private static final int DEFAULT_QUIET_TO = 7 * 60;
        private static final int MINUTES_PER_DAY = 24 * 60;

        static final AccountPrefs DEFAULT = new AccountPrefs(PhoneFilter.ALL, true, false, false,
                DEFAULT_QUIET_FROM, DEFAULT_QUIET_TO, null);

        final PhoneFilter filter;
        final boolean inbox;
        final boolean inboxMentions;
        final boolean quietOn;
        final int quietFrom;
        final int quietTo;
        final String channelNotifications;

        /** A null filter reads as ALL, a minute outside the day as its default, an unknown Odoo value as null. */
        AccountPrefs(PhoneFilter filter, boolean inbox, boolean inboxMentions, boolean quietOn, int quietFrom,
                int quietTo, String channelNotifications) {
            this.filter = filter == null ? PhoneFilter.ALL : filter;
            this.inbox = inbox;
            this.inboxMentions = inboxMentions;
            this.quietOn = quietOn;
            this.quietFrom = minute(quietFrom, DEFAULT_QUIET_FROM);
            this.quietTo = minute(quietTo, DEFAULT_QUIET_TO);
            this.channelNotifications = odooValue(channelNotifications);
        }

        /** The prefs carried by an account of the mirror or of the stored copy. */
        static AccountPrefs of(JSONObject account) {
            JSONObject quiet = account.optJSONObject("quiet");
            if (quiet == null) quiet = new JSONObject();
            return new AccountPrefs(PhoneFilter.fromKey(account.optString("filter", "")),
                    account.optBoolean("inbox", DEFAULT.inbox),
                    account.optBoolean("inboxMentions", DEFAULT.inboxMentions),
                    quiet.optBoolean("on", DEFAULT.quietOn),
                    quiet.optInt("from", DEFAULT_QUIET_FROM),
                    quiet.optInt("to", DEFAULT_QUIET_TO),
                    account.isNull("channelNotifications") ? null : account.optString("channelNotifications"));
        }

        /** Adds the keys of() reads to an account's JSON. */
        void writeTo(JSONObject account) throws JSONException {
            account.put("filter", filter.key());
            account.put("inbox", inbox);
            account.put("inboxMentions", inboxMentions);
            JSONObject quiet = new JSONObject();
            quiet.put("on", quietOn);
            quiet.put("from", quietFrom);
            quiet.put("to", quietTo);
            account.put("quiet", quiet);
            account.put("channelNotifications", channelNotifications == null ? JSONObject.NULL : channelNotifications);
        }

        private static int minute(int v, int fallback) {
            return v >= 0 && v < MINUTES_PER_DAY ? v : fallback;
        }

        private static String odooValue(String v) {
            return "all".equals(v) || "mentions".equals(v) || "no_notif".equals(v) ? v : null;
        }
    }

    final String configId;
    final String label;
    final LockScreenMode lockScreen;
    final Map<Long, ChannelInfo> channels;
    final String module;
    final PhoneFilter filter;
    final boolean inbox;
    final boolean inboxMentions;
    final boolean quietOn;
    final int quietFrom;
    final int quietTo;
    /** Odoo's general channel setting: "all", "mentions", "no_notif", or null while unknown. */
    final String channelNotifications;

    AccountView(String configId, String label, LockScreenMode lockScreen, Map<Long, ChannelInfo> channels) {
        this(configId, label, lockScreen, channels, "");
    }

    AccountView(String configId, String label, LockScreenMode lockScreen, Map<Long, ChannelInfo> channels,
            String module) {
        this(configId, label, lockScreen, channels, module, AccountPrefs.DEFAULT);
    }

    AccountView(String configId, String label, LockScreenMode lockScreen, Map<Long, ChannelInfo> channels,
            String module, AccountPrefs p) {
        this.configId = configId;
        this.label = label == null ? "" : label;
        this.lockScreen = lockScreen == null ? LockScreenMode.HIDDEN_LOCKED : lockScreen;
        this.channels = channels == null
                ? Collections.<Long, ChannelInfo>emptyMap()
                : Collections.unmodifiableMap(new HashMap<>(channels));
        this.module = module == null ? "" : module;
        if (p == null) p = AccountPrefs.DEFAULT;
        this.filter = p.filter;
        this.inbox = p.inbox;
        this.inboxMentions = p.inboxMentions;
        this.quietOn = p.quietOn;
        this.quietFrom = p.quietFrom;
        this.quietTo = p.quietTo;
        this.channelNotifications = p.channelNotifications;
    }

    /** The preferences this view was built with. */
    AccountPrefs prefs() {
        return new AccountPrefs(filter, inbox, inboxMentions, quietOn, quietFrom, quietTo, channelNotifications);
    }
}
