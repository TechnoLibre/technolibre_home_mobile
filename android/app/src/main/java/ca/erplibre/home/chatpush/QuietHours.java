package ca.erplibre.home.chatpush;

/**
 * The quiet-hours window of one server, in minutes from local midnight
 * (0..1439): from inclusive, to exclusive, crossing midnight when from is
 * after to. Equal bounds make an empty window, never a whole day.
 * Capacitor-free and Android-free.
 */
final class QuietHours {

    private QuietHours() {}

    static boolean inside(int from, int to, int minuteOfDay) {
        if (from == to) return false;
        if (from < to) return minuteOfDay >= from && minuteOfDay < to;
        return minuteOfDay >= from || minuteOfDay < to;
    }
}
