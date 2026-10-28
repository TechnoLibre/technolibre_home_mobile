package ca.erplibre.home.chatpush;

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
        if (n.messaging) {
            NotificationCompat.MessagingStyle style = previousStyle(n.tag);
            if (style == null) {
                style = new NotificationCompat.MessagingStyle(
                        new Person.Builder().setName(settings.strings().get("you")).build());
            }
            style.setConversationTitle(n.conversationTitle);
            style.setGroupConversation(!n.conversationTitle.equals(n.author));
            if (repeatsLast(style, n)) {
                // drawn again as it was, without alerting a second time
                b.setOnlyAlertOnce(true);
            } else {
                Person author = new Person.Builder().setName(authorOf(n)).build();
                style.addMessage(new NotificationCompat.MessagingStyle.Message(n.text, when, author));
            }
            b.setStyle(style).setCategory(NotificationCompat.CATEGORY_MESSAGE);
        } else {
            b.setContentTitle(n.conversationTitle);
            if (!n.text.isEmpty()) b.setContentText(n.text);
        }
        switch (NotificationModel.visibility(n, redaction())) {
            case PRIVATE:
                b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
                b.setPublicVersion(new NotificationCompat.Builder(context, n.channelId)
                        .setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setContentTitle(n.publicTitle)
                        .build());
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

    /** The MessagingStyle of the notification drawn under tag, or null. */
    private NotificationCompat.MessagingStyle previousStyle(String tag) {
        for (StatusBarNotification sbn : active()) {
            if (sbn.getId() == ID && tag.equals(sbn.getTag())) {
                return NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.getNotification());
            }
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

    /** When each notification of shownTags was last posted, epoch ms. */
    Map<String, Long> shownAt() {
        Map<String, Long> out = new HashMap<>();
        for (StatusBarNotification sbn : active()) {
            if (sbn.getId() == ID && sbn.getTag() != null) out.put(sbn.getTag(), sbn.getPostTime());
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
