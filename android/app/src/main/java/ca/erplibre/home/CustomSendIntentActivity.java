package ca.erplibre.home;

import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import app.supernotes.sendIntent.SendIntentActivity;

/**
 * Extends SendIntentActivity to override the EdgeToEdge IME insets listener
 * that ships with the @capawesome/capacitor-android-edge-to-edge-support v8
 * plugin. Without this override, opening the keyboard inside the intent flow
 * causes a double-shift: Android pans the window AND EdgeToEdge adds a bottom
 * margin equal to the keyboard height, pushing all content off-screen.
 *
 * Combined with android:windowSoftInputMode="adjustNothing" in the manifest,
 * the keyboard now appears as a pure overlay — no layout shift at all.
 */
public class CustomSendIntentActivity extends SendIntentActivity {

    @Override
    public void onStart() {
        super.onStart();
        applyKeyboardOverlayInsetsListener();
    }

    @Override
    public void onResume() {
        super.onResume();
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
