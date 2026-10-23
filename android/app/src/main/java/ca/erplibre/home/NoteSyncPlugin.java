package ca.erplibre.home;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pont entre la synchronisation de l'application et {@link NoteSyncJob}.
 *
 * <p>{@code publish} enregistre ce qui attend (notes à envoyer, conflits), si
 * l'application est au premier plan, et les textes de la notification dans la
 * langue choisie ; il planifie le travail et, au premier plan, retire la
 * notification. Rien d'autre ne passe : ni note, ni identifiant.
 */
@CapacitorPlugin(name = "NoteSyncPlugin")
public class NoteSyncPlugin extends Plugin {

    @PluginMethod
    public void publish(PluginCall call) {
        Context context = getContext();
        boolean foreground = Boolean.TRUE.equals(call.getBoolean("foreground", false));
        SharedPreferences.Editor editor = context
                .getSharedPreferences(NoteSyncJob.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putInt(NoteSyncJob.KEY_PENDING, Math.max(0, call.getInt("pending", 0)))
                .putInt(NoteSyncJob.KEY_CONFLICTS, Math.max(0, call.getInt("conflicts", 0)))
                .putBoolean(NoteSyncJob.KEY_FOREGROUND, foreground);
        String title = call.getString("title");
        String body = call.getString("body");
        if (title != null) editor.putString(NoteSyncJob.KEY_TITLE, title);
        if (body != null) editor.putString(NoteSyncJob.KEY_BODY, body);
        editor.apply();
        NoteSyncJob.schedule(context);
        if (foreground) NoteSyncJob.clear(context);
        call.resolve(new JSObject());
    }
}
