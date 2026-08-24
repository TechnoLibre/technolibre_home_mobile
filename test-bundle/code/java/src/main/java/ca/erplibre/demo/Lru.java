package ca.erplibre.demo;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Cache LRU adossé à LinkedHashMap.
 *
 * <p>Le détail qui compte : {@code accessOrder = true} au constructeur. Sans
 * lui, LinkedHashMap ordonne par insertion et le cache évince l'entrée la plus
 * ancienne au lieu de la moins récemment lue — ce qui se voit rarement en test
 * et beaucoup en production.
 */
public final class Lru<K, V> {

    private final int capacity;
    private final Map<K, V> map;

    public Lru(int capacity) {
        if (capacity < 1) {
            throw new IllegalArgumentException("capacité invalide : " + capacity);
        }
        this.capacity = capacity;
        this.map = new LinkedHashMap<>(capacity, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
                return size() > Lru.this.capacity;
            }
        };
    }

    public Optional<V> get(K key) {
        return Optional.ofNullable(map.get(key));
    }

    public void put(K key, V value) {
        map.put(key, value);
    }

    public int size() {
        return map.size();
    }

    public boolean contains(K key) {
        return map.containsKey(key);
    }
}
