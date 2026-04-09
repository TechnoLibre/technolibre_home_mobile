package ca.erplibre.home;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.gms.cast.framework.CastContext;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    protected void on(Bundle savedInstanceState) {
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
