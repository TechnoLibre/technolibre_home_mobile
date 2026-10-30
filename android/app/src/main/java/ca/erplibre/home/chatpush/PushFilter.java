package ca.erplibre.home.chatpush;

/**
 * Whether one server's message push is shown, by the account's phone-side
 * preferences. It only ever drops: Odoo has sent the push either way.
 *
 * NONE drops every message push. A record or activity push (not a discuss
 * channel) follows the inbox switch: shown when the inbox is on, else only
 * when inboxMentions is on and the module 1.6 object says mentioned, so a
 * push without that object is dropped. A conversation push follows the
 * filter: ALL shows it; MENTIONS_DM shows a chat or a group always and a
 * channel only when mentioned. The type is the payload's, else the mirrored
 * conversation's. MENTIONS_DM fails open: without the 1.6 object, or with no
 * type known, the push is shown.
 *
 * Capacitor-free and Android-free. Control pushes never come here.
 */
final class PushFilter {

    private PushFilter() {}

    static boolean allows(AccountView a, PushPayload p) {
        if (a.filter == PhoneFilter.NONE) return false;
        // mentioned is false without the 1.6 object
        if (!p.isChat()) return a.inbox || (a.inboxMentions && p.mentioned);
        if (a.filter == PhoneFilter.ALL || !p.flags) return true;
        return !"channel".equals(typeOf(a, p)) || p.mentioned;
    }

    /** chat, group or channel; "" when neither the payload nor the mirror says. */
    private static String typeOf(AccountView a, PushPayload p) {
        if (!p.channelType.isEmpty()) return p.channelType;
        ChannelInfo info = a.channels.get(p.resId);
        return info == null ? "" : info.type;
    }
}
