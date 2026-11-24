package ca.erplibre.home.chatpush;

import java.util.Iterator;
import java.util.LinkedHashSet;

/**
 * The last message ids already handled, oldest dropped first. ntfy replays
 * a few messages around a cursor and an unknown cursor replays the whole
 * cache, so every consumer drops what this set has seen. Serialized as
 * ids joined by commas (ntfy ids are alphanumeric).
 */
final class SeenIds {

    private final LinkedHashSet<String> ids = new LinkedHashSet<>();
    private final int capacity;

    SeenIds(String serialized, int capacity) {
        this.capacity = capacity;
        if (serialized != null) {
            for (String id : serialized.split(",")) {
                if (!id.isEmpty()) ids.add(id);
            }
        }
        trim();
    }

    /** Remembers the id; false when it was already there (its age is not refreshed). */
    boolean add(String id) {
        if (!ids.add(id)) return false;
        trim();
        return true;
    }

    String serialize() {
        return String.join(",", ids);
    }

    private void trim() {
        Iterator<String> it = ids.iterator();
        while (ids.size() > capacity && it.hasNext()) {
            it.next();
            it.remove();
        }
    }
}
