package ca.erplibre.home.chatpush;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** KeyValue over a map, for the JVM tests. */
final class MapKeyValue implements KeyValue {

    final Map<String, String> map = new HashMap<>();

    @Override
    public String get(String k) {
        return map.get(k);
    }

    @Override
    public void put(String k, String v) {
        map.put(k, v);
    }

    @Override
    public void remove(String k) {
        map.remove(k);
    }

    @Override
    public Set<String> keys() {
        return new HashSet<>(map.keySet());
    }
}
