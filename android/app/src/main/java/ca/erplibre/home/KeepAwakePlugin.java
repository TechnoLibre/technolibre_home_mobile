package ca.erplibre.home;

import android.app.Activity;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Toggles FLAG_KEEP_SCREEN_ON on the main activity's window. While
 * enabled, Android leaves the screen on indefinitely (and by extension
 * the USB host stack at full power), which is what users want when the
 * phone drives a connected Stream Deck and they don't want it to dim
 * the LCDs whenever the phone screen times out.
 *
 * Implementation note: the flag mutation must run on the UI thread —
 * WindowManager rejects updates from arbitrary threads. Capacitor
 * delivers PluginCall on the main thread by default, but we route
 * through getActivity().runOnUiThread() to stay safe if that ever
 * changes.
 */
@CapacitorPlugin(name = "KeepAwakePlugin")
public class KeepAwakePlugin extends Plugin {

    private volatile boolean enabled = false;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean want = call.getBoolean("enabled");
        if (want == null) {
            call.reject("missing_enabled");
            return;
        }
        applyFlag(want);
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    private void applyFlag(boolean want) {
        Activity act = getActivity();
        if (act == null) return;
        act.runOnUiThread(() -> {
            if (want) {
                act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            enabled = want;
        });
    }
}
