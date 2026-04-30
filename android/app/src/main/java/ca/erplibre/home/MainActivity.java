package ca.erplibre.home;

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

import ca.erplibre.home.streamdeck.StreamDeckPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Cooperate with the StreamDeckPlugin wake-on-keypress path:
        // when the activity is relaunched after a deck press during
        // phone sleep, the OS needs explicit consent to display this
        // window over the keyguard and to turn the screen on. Without
        // these flags the wake-lock acquired by the plugin would only
        // light the LCD and leave the lockscreen on top.
        // setShowWhenLocked / setTurnScreenOn are API 27+. minSdk=24,
        // so the older path falls back to FLAG_DISMISS_KEYGUARD +
        // FLAG_TURN_SCREEN_ON on the window which has the same effect.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | android.view.WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }
        registerPlugin(RawHttpPlugin.class);
        registerPlugin(SshPlugin.class);
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
        registerPlugin(OcrPlugin.class);
        registerPlugin(NetworkScanPlugin.class);
        registerPlugin(DeviceStatsPlugin.class);
        registerPlugin(StreamDeckPlugin.class);
        registerPlugin(FaceDetectionPlugin.class);
        registerPlugin(KeepAwakePlugin.class);
        super.onCreate(savedInstanceState);
        CastContext.getSharedInstance(this);
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
