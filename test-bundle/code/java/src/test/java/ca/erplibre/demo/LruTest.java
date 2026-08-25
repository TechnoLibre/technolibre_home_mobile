package ca.erplibre.demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class LruTest {

    @Test
    void evicts_the_least_recently_read() {
        Lru<String, Integer> lru = new Lru<>(2);
        lru.put("a", 1);
        lru.put("b", 2);
        lru.get("a");            // « a » redevient le plus récent
        lru.put("c", 3);         // « b » doit partir, pas « a »
        assertTrue(lru.contains("a"));
        assertFalse(lru.contains("b"));
        assertEquals(2, lru.size());
    }

    @Test
    void rejects_an_absurd_capacity() {
        assertThrows(IllegalArgumentException.class, () -> new Lru<>(0));
    }

    @Test
    void a_missing_key_is_empty_not_null() {
        assertTrue(new Lru<String, Integer>(1).get("absent").isEmpty());
    }
}
