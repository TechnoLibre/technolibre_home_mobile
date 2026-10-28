package ca.erplibre.home.chatpush;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The unread total of one account, counted as the app's JS does
 * (chatService.unreadTotal and chatUnread.totalUnread) from the result of
 * POST /mail/data: a chat or group counts its unread messages, a channel
 * only the ones that mention the user, a muted conversation (its own
 * mute_until_dt or the account-wide one still ahead) counts nothing, and
 * the inbox counter is added once, minus the mentions the channels count
 * themselves, never below 0.
 */
final class UnreadSummary {

    final int total;
    /** Counted conversations whose own unread count is 0 (muted or not). */
    final Set<Long> readChannelIds;

    private UnreadSummary(int total, Set<Long> readChannelIds) {
        this.total = total;
        this.readChannelIds = Collections.unmodifiableSet(readChannelIds);
    }

    /** of() for a /mail/data whose Store names its self partner. */
    static UnreadSummary of(JSONObject mailData, String globalMuteUntil, long nowMs) {
        return of(mailData, -1, globalMuteUntil, nowMs);
    }

    /**
     * @param mailData the "result" of /mail/data
     * @param sessionSelf the self partner as the session info gives it, -1
     *     unknown; Odoo 18's /mail/data names it neither in its Store nor
     *     in its channels (selfMember), and the self member rows are found
     *     by it. A Store "self" wins over it.
     * @param globalMuteUntil Odoo "YYYY-MM-DD HH:MM:SS" UTC, or null
     * @param nowMs epoch ms the mutes are compared with
     */
    static UnreadSummary of(JSONObject mailData, long sessionSelf, String globalMuteUntil, long nowMs) {
        JSONObject res = mailData == null ? new JSONObject() : mailData;
        JSONObject store = res.optJSONObject("Store");
        if (store == null) store = new JSONObject();

        long selfPartner = idOf(store.opt("self"));
        if (selfPartner < 0) selfPartner = sessionSelf;
        int inboxCounter = 0;
        JSONObject inbox = store.optJSONObject("inbox");
        if (inbox != null) inboxCounter = inbox.optInt("counter", 0);

        Map<Long, JSONObject> members = new HashMap<>();
        JSONArray memberRows = res.optJSONArray("discuss.channel.member");
        if (memberRows != null) {
            for (int i = 0; i < memberRows.length(); i++) {
                JSONObject m = memberRows.optJSONObject(i);
                if (m != null && m.has("id")) members.put(m.optLong("id"), m);
            }
        }
        // The self member's row by channel id, whichever way the result links it
        Map<Long, JSONObject> selfByChannel = new HashMap<>();
        for (JSONObject m : members.values()) {
            if (m.optBoolean("_DELETE", false)) continue;
            JSONObject thread = m.optJSONObject("thread");
            long channelId = thread != null && "discuss.channel".equals(thread.optString("model"))
                    ? thread.optLong("id", -1) : -1;
            if (channelId >= 0 && selfPartner >= 0 && idOf(m.opt("persona")) == selfPartner) {
                selfByChannel.put(channelId, m);
            }
        }

        int mentions = 0;
        int counted = 0;
        Set<Long> read = new HashSet<>();
        JSONArray channels = res.optJSONArray("discuss.channel");
        for (int i = 0; channels != null && i < channels.length(); i++) {
            JSONObject c = channels.optJSONObject(i);
            if (c == null || !c.has("id") || c.optBoolean("_DELETE", false)) continue;
            long id = c.optLong("id");
            // Every cached channel's mentions leave the inbox counter, shown or not (chatService.unreadTotal)
            int needaction = c.optInt("message_needaction_counter", 0);
            mentions += needaction;
            JSONObject self = selfByChannel.get(id);
            Object sm = c.opt("selfMember");
            boolean isMember = self != null;
            if (sm instanceof JSONObject) {
                self = (JSONObject) sm;
                isMember = true;
            } else if (sm instanceof Number) {
                JSONObject row = members.get(((Number) sm).longValue());
                if (row != null) self = row;
                isMember = true;
            } else if (sm != null && sm != JSONObject.NULL && Boolean.TRUE.equals(sm)) {
                isMember = true;
            } else if (c.has("selfMember") && (sm == JSONObject.NULL || Boolean.FALSE.equals(sm))) {
                isMember = false;
                self = null;
            }
            String type = c.optString("channel_type", "");
            // shown(): a member, and a direct message only while pinned
            if (!isMember || ("chat".equals(type) && !c.optBoolean("is_pinned", false))) continue;

            int unread = self == null ? 0 : self.optInt("message_unread_counter", 0);
            int own = "channel".equals(type) ? needaction : unread;
            if (own == 0) read.add(id);
            boolean muted = ahead(c.isNull("mute_until_dt") ? null : c.optString("mute_until_dt", null), nowMs)
                    || ahead(globalMuteUntil, nowMs);
            if (!muted) counted += own;
        }
        return new UnreadSummary(Math.max(0, inboxCounter - mentions) + counted, read);
    }

    private static long idOf(Object v) {
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            if (o.opt("id") instanceof Number) return o.optLong("id");
        }
        return -1;
    }

    /** Whether the Odoo UTC date is set, parses, and is ahead of now (year 9999 is "muted forever"). */
    private static boolean ahead(String odooDt, long nowMs) {
        if (odooDt == null || odooDt.isEmpty() || "false".equals(odooDt)) return false;
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            f.setLenient(false);
            Date d = f.parse(odooDt);
            return d != null && d.getTime() > nowMs;
        } catch (ParseException e) {
            return false;
        }
    }
}
