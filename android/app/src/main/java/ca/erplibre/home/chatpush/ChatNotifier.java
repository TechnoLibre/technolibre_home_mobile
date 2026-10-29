package ca.erplibre.home.chatpush;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * Draws what PushEngine decides, through the NotificationManager. Every
 * notification is posted under its model tag and the one id ID, so the
 * tags of this class are told apart from the app's other notifications.
 *
 * Channels are per server: "chat.&lt;h&gt;" (high importance) and
 * "inbox.&lt;h&gt;" (default) inside group "server.&lt;h&gt;" named by the
 * account label, plus the shared low-importance "status". syncChannels
 * aligns them with the mirrored accounts; deleting a server's group
 * deletes its channels and their notifications.
 *
 * The Notifier methods run with the engine's monitor held: they only talk
 * to Android and read the mirrored strings, never call the engine.
 */
final class ChatNotifier implements PushEngine.Notifier {

    static final int ID = 0x43485054;

    /** long[]: the message ids of a chat notification's stack, in order, 0 for a message without id. */
    static final String EXTRA_MESSAGE_IDS = "erplibre.message_ids";

    private final Context context;
    private final NotificationManager manager;
    private final PushSettingsStore settings;
    private volatile Consumer<HealthSnapshot> statusSink;

    ChatNotifier(Context context, PushSettingsStore settings) {
        this.context = context.getApplicationContext();
        this.manager = this.context.getSystemService(NotificationManager.class);
        this.settings = settings;
    }

    /**
     * Creates or renames the channels of every account and the status
     * channel, and deletes the groups and channels of servers no longer
     * mirrored. Importance is fixed at creation: Android keeps what the user
     * set afterwards.
     */
    void syncChannels(List<AccountView> accounts, PushStrings s) {
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        Set<String> groups = new HashSet<>();
        Set<String> channels = new HashSet<>();
        for (AccountView a : accounts) {
            String group = NotificationModel.groupId(a.configId);
            groups.add(group);
            manager.createNotificationChannelGroup(new NotificationChannelGroup(group,
                    a.label.isEmpty() ? a.configId : a.label));
            channels.add(createChannel(NotificationModel.chatChannelId(a.configId), s.get("channel_chat"),
                    NotificationManager.IMPORTANCE_HIGH, group));
            channels.add(createChannel(NotificationModel.inboxChannelId(a.configId), s.get("channel_inbox"),
                    NotificationManager.IMPORTANCE_DEFAULT, group));
        }
        createChannel(NotificationModel.STATUS_CHANNEL, s.get("channel_status"), NotificationManager.IMPORTANCE_LOW,
                null);
        for (NotificationChannel c : manager.getNotificationChannels()) {
            String id = c.getId();
            if ((id.startsWith("chat.") || id.startsWith("inbox.")) && !channels.contains(id)) {
                manager.deleteNotificationChannel(id);
            }
        }
        for (NotificationChannelGroup g : manager.getNotificationChannelGroups()) {
            if (g.getId().startsWith("server.") && !groups.contains(g.getId())) {
                manager.deleteNotificationChannelGroup(g.getId());
            }
        }
    }

    private String createChannel(String id, String name, int importance, String group) {
        NotificationChannel c = new NotificationChannel(id, name, importance);
        if (group != null) c.setGroup(group);
        manager.createNotificationChannel(c);
        return id;
    }

    /**
     * Posts n under its tag. A conversation is drawn as MessagingStyle: the
     * style of the notification of the same tag still shown is taken back
     * and the new message appended, so the stack survives a process death;
     * a replay of the last message is not appended twice. A silent n
     * updates without sound, vibration or heads-up.
     *
     * A chat notification, drawn as a conversation or not (« Jamais
     * affiché »), keeps its stack's message ids under EXTRA_MESSAGE_IDS
     * (stack order, 0 for a message without id), the previous array
     * extended. The array is the only record of the ids: Android does not
     * keep a MessagingStyle message's extras. A private notification always
     * carries its public version, so a re-post can choose between PRIVATE
     * and SECRET again.
     */
    @Override
    public void show(NotificationModel.Shown n) {
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(n.channelId) == null) {
            syncChannels(settings.accounts(), settings.strings());
        }
        long when = n.at > 0 ? n.at : System.currentTimeMillis();
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, n.channelId)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(ChatPushOpen.intent(context, n.openUrl))
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(when);
        if (n.groupId != null) b.setGroup(n.groupId);
        boolean chat = n.tag.startsWith("chat:");
        StatusBarNotification prev = chat || n.messaging ? drawn(n.tag) : null;
        long[] prevIds = prev == null ? null : prev.getNotification().extras.getLongArray(EXTRA_MESSAGE_IDS);
        long[] ids;
        if (n.messaging) {
            NotificationCompat.MessagingStyle style = prev == null ? null
                    : NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(prev.getNotification());
            if (style == null) {
                style = new NotificationCompat.MessagingStyle(
                        new Person.Builder().setName(settings.strings().get("you")).build());
            }
            style.setConversationTitle(n.conversationTitle);
            style.setGroupConversation(!n.conversationTitle.equals(n.author));
            ids = aligned(prevIds, style.getMessages().size());
            if (repeatsLast(style, n)) {
                // drawn again as it was, without alerting a second time
                b.setOnlyAlertOnce(true);
            } else {
                Person author = new Person.Builder().setName(authorOf(n)).build();
                style.addMessage(new NotificationCompat.MessagingStyle.Message(n.text, when, author));
                ids = extended(ids, n.messageId);
            }
            b.setStyle(style).setCategory(NotificationCompat.CATEGORY_MESSAGE);
        } else {
            b.setContentTitle(n.conversationTitle);
            if (!n.text.isEmpty()) b.setContentText(n.text);
            boolean replay = n.messageId > 0 && prevIds != null && prevIds.length > 0
                    && prevIds[prevIds.length - 1] == n.messageId;
            ids = replay ? prevIds : extended(prevIds, n.messageId);
        }
        if (chat) b.getExtras().putLongArray(EXTRA_MESSAGE_IDS, ids);
        if (n.privateVisibility) {
            b.setPublicVersion(new NotificationCompat.Builder(context, n.channelId)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(n.publicTitle)
                    .build());
        }
        switch (NotificationModel.visibility(n, redaction())) {
            case PRIVATE:
                b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
                break;
            case SECRET:
                b.setVisibility(NotificationCompat.VISIBILITY_SECRET);
                break;
            default:
                b.setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
                break;
        }
        if (NotificationModel.STATUS_CHANNEL.equals(n.channelId)) {
            b.setPriority(NotificationCompat.PRIORITY_LOW);
        } else if (n.channelId.startsWith("chat.")) {
            b.setPriority(NotificationCompat.PRIORITY_HIGH);
        }
        if (n.silent) b.setOnlyAlertOnce(true).setSilent(true);
        manager.notify(n.tag, ID, b.build());
    }

    /**
     * Trims the conversation tagged tag after a « read » push: the messages
     * whose id is above lastMessageId stay, the others (those without id
     * included) go. None left cancels the notification; an unchanged stack
     * is left alone; else it is re-posted silently from itself, its text
     * unchanged otherwise (a « Jamais affiché » one stays generic), its
     * lock-screen visibility decided again.
     */
    @Override
    public void trimRead(String tag, long lastMessageId) {
        if (manager == null) return;
        StatusBarNotification sbn = drawn(tag);
        if (sbn == null) return;
        Notification old = sbn.getNotification();
        long[] ids = old.extras.getLongArray(EXTRA_MESSAGE_IDS);
        NotificationCompat.MessagingStyle style =
                NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(old);
        // a conversation's ids follow its drawn messages; a « Jamais affiché » one has only the array
        long[] stack = style != null ? aligned(ids, style.getMessages().size()) : ids == null ? new long[0] : ids;
        long[] kept = keptIds(stack, lastMessageId);
        if (kept.length == 0) {
            cancel(tag);
            return;
        }
        if (kept.length == stack.length) return;
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, old);
        if (style != null) {
            List<NotificationCompat.MessagingStyle.Message> messages = style.getMessages();
            NotificationCompat.MessagingStyle trimmed = new NotificationCompat.MessagingStyle(style.getUser());
            trimmed.setConversationTitle(style.getConversationTitle());
            trimmed.setGroupConversation(style.isGroupConversation());
            for (int i = 0; i < messages.size(); i++) {
                if (NotificationModel.keptAfterRead(stack[i], lastMessageId)) trimmed.addMessage(messages.get(i));
            }
            b.setStyle(trimmed);
        }
        b.getExtras().putLongArray(EXTRA_MESSAGE_IDS, kept);
        if (old.visibility != Notification.VISIBILITY_PUBLIC) {
            boolean shownPublic = old.publicVersion != null
                    && redaction() == NotificationModel.Redaction.HIDDEN;
            b.setVisibility(shownPublic ? NotificationCompat.VISIBILITY_PRIVATE : NotificationCompat.VISIBILITY_SECRET);
        }
        b.setOnlyAlertOnce(true).setSilent(true);
        manager.notify(tag, ID, b.build());
    }

    /** Most messages a stack keeps, as MessagingStyle does: its ids array stays aligned on them. */
    static final int MAX_STACK = NotificationCompat.MessagingStyle.MAXIMUM_RETAINED_MESSAGES;

    /**
     * The ids of the last count messages of a stack from its ids array: the
     * array's last count entries, 0 for each message drawn without one.
     */
    static long[] aligned(long[] ids, int count) {
        long[] out = new long[count];
        int have = ids == null ? 0 : ids.length;
        for (int i = 0; i < count; i++) {
            int j = have - count + i;
            out[i] = j >= 0 ? ids[j] : 0;
        }
        return out;
    }

    /** ids with id appended, its oldest entries dropped beyond MAX_STACK. */
    static long[] extended(long[] ids, long id) {
        int have = ids == null ? 0 : ids.length;
        int keep = Math.min(have, MAX_STACK - 1);
        long[] out = new long[keep + 1];
        if (keep > 0) System.arraycopy(ids, have - keep, out, 0, keep);
        out[keep] = id;
        return out;
    }

    /** The entries of ids that stay after a « read » push up to lastMessageId, in order. */
    static long[] keptIds(long[] ids, long lastMessageId) {
        int n = 0;
        long[] out = new long[ids.length];
        for (long id : ids) {
            if (NotificationModel.keptAfterRead(id, lastMessageId)) out[n++] = id;
        }
        return java.util.Arrays.copyOf(out, n);
    }

    /**
     * The lock-screen redaction of the user's settings, read at each post
     * (the user may change it at any time); a setting that cannot be read
     * counts as unknown.
     */
    private NotificationModel.Redaction redaction() {
        return NotificationModel.redactionOf(secureInt("lock_screen_show_notifications"),
                secureInt("lock_screen_allow_private_notifications"));
    }

    private Integer secureInt(String name) {
        try {
            return Settings.Secure.getInt(context.getContentResolver(), name);
        } catch (Settings.SettingNotFoundException | RuntimeException e) {
            return null;
        }
    }

    private static boolean repeatsLast(NotificationCompat.MessagingStyle style, NotificationModel.Shown n) {
        List<NotificationCompat.MessagingStyle.Message> messages = style.getMessages();
        if (messages.isEmpty()) return false;
        NotificationCompat.MessagingStyle.Message last = messages.get(messages.size() - 1);
        Person p = last.getPerson();
        return repeats(last.getText(), p == null ? null : p.getName(), last.getTimestamp(), n);
    }

    /** The notification drawn under tag, or null. */
    private StatusBarNotification drawn(String tag) {
        for (StatusBarNotification sbn : active()) {
            if (sbn.getId() == ID && tag.equals(sbn.getTag())) return sbn;
        }
        return null;
    }

    /**
     * Whether n is the message last appended to the stack (same text, author
     * and send time): a message replayed after a death between the drawing
     * and the saving of its id. A message without a send time is never one.
     */
    static boolean repeats(CharSequence lastText, CharSequence lastAuthor, long lastAt, NotificationModel.Shown n) {
        if (n.at <= 0 || lastAt != n.at || lastText == null || lastAuthor == null) return false;
        return lastText.toString().equals(n.text) && lastAuthor.toString().equals(authorOf(n));
    }

    private static String authorOf(NotificationModel.Shown n) {
        return n.author.isEmpty() ? n.conversationTitle : n.author;
    }

    @Override
    public void cancel(String tag) {
        if (manager != null) manager.cancel(tag, ID);
    }

    /** Cancels every tag "&lt;kind&gt;:&lt;configId&gt;" or "&lt;kind&gt;:&lt;configId&gt;:...". */
    @Override
    public void cancelAll(String configId) {
        for (String tag : shownTags()) {
            int colon = tag.indexOf(':');
            if (colon < 0) continue;
            String rest = tag.substring(colon + 1);
            if (rest.equals(configId) || rest.startsWith(configId + ":")) cancel(tag);
        }
    }

    @Override
    public Set<String> shownTags() {
        Set<String> out = new HashSet<>();
        for (StatusBarNotification sbn : active()) {
            if (sbn.getId() == ID && sbn.getTag() != null) out.add(sbn.getTag());
        }
        return out;
    }

    @Override
    public Map<String, Long> shownAt() {
        Map<String, Long> out = new HashMap<>();
        for (StatusBarNotification sbn : active()) {
            if (sbn.getId() == ID && sbn.getTag() != null) out.put(sbn.getTag(), sbn.getPostTime());
        }
        return out;
    }

    /** The when of each notification of shownTags: the send time show() drew it with. */
    @Override
    public Map<String, Long> shownSentAt() {
        Map<String, Long> out = new HashMap<>();
        for (StatusBarNotification sbn : active()) {
            if (sbn.getId() == ID && sbn.getTag() != null) out.put(sbn.getTag(), sbn.getNotification().when);
        }
        return out;
    }

    /**
     * Sets who receives the engine's state; null drops it. The sink runs with
     * the engine's monitor held, as status() does.
     */
    void onStatus(Consumer<HealthSnapshot> sink) {
        statusSink = sink;
    }

    /** The permanent notification line belongs to the permanent service: the state goes to its sink, if any. */
    @Override
    public void status(HealthSnapshot h) {
        Consumer<HealthSnapshot> sink = statusSink;
        if (sink != null) sink.accept(h);
    }

    /** Whether the user lets the app post notifications at all. */
    boolean allowed() {
        return manager != null && manager.areNotificationsEnabled();
    }

    private StatusBarNotification[] active() {
        if (manager == null) return new StatusBarNotification[0];
        try {
            return manager.getActiveNotifications();
        } catch (RuntimeException e) {
            // the notification service can be unreachable while the system restarts it
            return new StatusBarNotification[0];
        }
    }
}
