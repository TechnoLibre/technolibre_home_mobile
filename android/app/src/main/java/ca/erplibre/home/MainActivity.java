package ca.erplibre.home;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.gms.cast.framework.CastContext;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

import android.util.Log;

import ca.erplibre.home.streamdeck.DeckPowerOptions;
import ca.erplibre.home.streamdeck.StreamDeckPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        applyLockScreenPolicy(getIntent());
        registerPlugin(RawHttpPlugin.class);
        registerPlugin(SshPlugin.class);
        registerPlugin(ChatSocketPlugin.class);
        registerPlugin(ChatFilePlugin.class);
        // Whisper plugin pulls in libwhisper_jni.so / libggml.so. When the
        // dev fast-path BUNDLE_SKIP_WHISPER=1 build was used, those libs
        // are absent — registering the plugin would crash on the static
        // System.loadLibrary inside WhisperLib. Gate it on the build flag.
        if (!BuildConfig.SKIP_WHISPER) {
            try {
                @SuppressWarnings("unchecked")
                Class<? extends Plugin> cls =
                    (Class<? extends Plugin>) Class.forName("ca.erplibre.home.WhisperPlugin");
                registerPlugin(cls);
            } catch (Throwable t) {
                Log.w("MainActivity",
                    "WhisperPlugin not available: " + t.getMessage());
            }
        }
        registerPlugin(MarianPlugin.class);
        registerPlugin(OcrPlugin.class);
        registerPlugin(NetworkScanPlugin.class);
        registerPlugin(DeviceStatsPlugin.class);
        registerPlugin(StreamDeckPlugin.class);
        registerPlugin(FaceDetectionPlugin.class);
        registerPlugin(KeepAwakePlugin.class);
        registerPlugin(SmsGatewayPlugin.class);
        registerPlugin(NoteSyncPlugin.class);
        registerPlugin(ChatPushPlugin.class);
        super.onCreate(savedInstanceState);
        CastContext.getSharedInstance(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask: a USB attach or a wake-on-key-press relaunch reaches
        // the running activity here, before it resumes.
        applyLockScreenPolicy(intent);
    }

    @Override
    public void onStop() {
        super.onStop();
        // Showing over the keyguard lasts for one deck launch: once the
        // screen goes off or the user leaves, the next ordinary wake lands
        // on the lock screen again.
        setOverLockScreen(false);
    }

    /**
     * Show this window over the keyguard and turn the screen on only for a
     * launch caused by the deck (USB attach, or the plugin's wake-on-key-
     * press relaunch) and only when the user turned showOverLockScreen on;
     * see DeckPowerOptions. Any other launch clears both.
     */
    private void applyLockScreenPolicy(Intent intent) {
        boolean show = false;
        if (intent != null) {
            show = DeckPowerOptions.of(this).showOverLockScreenFor(
                intent.getAction(),
                intent.getBooleanExtra(DeckPowerOptions.EXTRA_DECK_WAKE, false));
        }
        setOverLockScreen(show);
    }

    /**
     * setShowWhenLocked / setTurnScreenOn are API 27+. minSdk=24, so the
     * older path uses FLAG_SHOW_WHEN_LOCKED + FLAG_TURN_SCREEN_ON +
     * FLAG_DISMISS_KEYGUARD on the window, which has the same effect.
     */
    private void setOverLockScreen(boolean on) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else {
            int flags = android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | android.view.WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD;
            if (on) getWindow().addFlags(flags);
            else getWindow().clearFlags(flags);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        // The EdgeToEdge plugin v8 auto-installs an IME insets listener in its load()
        // method that shifts the WebView up by the keyboard height. Override it here
        // (after Capacitor plugin init) with a listener that only applies system bar
        // insets, so the keyboard appears as an overlay without moving the layout.
        applyKeyboardOverlayInsetsListener();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Re-apply the override every time the activity becomes active. When the app
        // is launched via a share intent, SendIntentActivity sits on top of
        // MainActivity; when it finishes, only onResume() is called (not onStart()).
        // Without this, the EdgeToEdge IME listener installed during the intent flow
        // can persist and shift the WebView off-screen when the keyboard opens.
        applyKeyboardOverlayInsetsListener();
    }

    private void applyKeyboardOverlayInsetsListener() {
        View webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            Insets systemBarsInsets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            boolean keyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.topMargin = systemBarsInsets.top;
            mlp.leftMargin = systemBarsInsets.left;
            mlp.rightMargin = systemBarsInsets.right;
            // When keyboard is visible it covers the nav bar area — no bottom margin needed.
            mlp.bottomMargin = keyboardVisible ? 0 : systemBarsInsets.bottom;
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
