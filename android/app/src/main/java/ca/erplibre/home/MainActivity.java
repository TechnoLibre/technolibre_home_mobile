package ca.erplibre.home;

import android.os.Bundle;

import com.google.android.gms.cast.framework.CastContext;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    protected void on(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CastContext.getSharedInstance(this);
    }
}
