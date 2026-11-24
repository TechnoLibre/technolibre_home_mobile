package ca.erplibre.home.chatpush;

import java.util.Set;

/**
 * A string key-value store. A put or a remove is durable when it returns,
 * so a process kill right after keeps it. The device implementation is
 * SharedPreferences; the JVM tests use a map.
 */
interface KeyValue {

    /** The value, or null when the key is absent. */
    String get(String k);

    void put(String k, String v);

    void remove(String k);

    /** A snapshot of every key. */
    Set<String> keys();
}
