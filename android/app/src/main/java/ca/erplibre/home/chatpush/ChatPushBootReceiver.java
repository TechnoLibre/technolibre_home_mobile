package ca.erplibre.home.chatpush;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Re-applies the chat push level after a reboot or an update of the app:
 * the job is persisted on most devices but not after every update, and
 * installing a new APK stops the permanent service without restarting it.
 * A boot broadcast is one of the few moments Android lets a background app
 * start a foreground service.
 */
public class ChatPushBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        boolean relevant = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action);
        if (relevant) ChatPushJob.apply(context);
    }
}
