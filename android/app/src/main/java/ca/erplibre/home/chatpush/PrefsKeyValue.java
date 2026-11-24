package ca.erplibre.home.chatpush;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;

/** KeyValue over a private SharedPreferences file; every write uses commit(), which is synchronous. */
final class PrefsKeyValue implements KeyValue {

    private final SharedPreferences prefs;

    PrefsKeyValue(Context context, String file) {
        this.prefs = context.getApplicationContext().getSharedPreferences(file, Context.MODE_PRIVATE);
    }

    @Override
    public String get(String k) {
        return prefs.getString(k, null);
    }

    @Override
    public void put(String k, String v) {
        prefs.edit().putString(k, v).commit();
    }

    @Override
    public void remove(String k) {
        prefs.edit().remove(k).commit();
    }

    @Override
    public Set<String> keys() {
        return new HashSet<>(prefs.getAll().keySet());
    }
}
