package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class QuietHoursTest {

    @Test
    public void quietHoursCrossMidnight() {
        // 22:00 to 07:00
        assertTrue(QuietHours.inside(1320, 420, 23 * 60));
        assertTrue(QuietHours.inside(1320, 420, 0));
        assertTrue(QuietHours.inside(1320, 420, 5 * 60));
        assertFalse(QuietHours.inside(1320, 420, 12 * 60));
        // 13:00 to 14:00, inside one day
        assertTrue(QuietHours.inside(780, 840, 810));
        assertFalse(QuietHours.inside(780, 840, 0));
        assertFalse(QuietHours.inside(780, 840, 23 * 60));
    }

    @Test
    public void theEdgesAreFromInclusiveToExclusive() {
        assertTrue(QuietHours.inside(1320, 420, 1320));
        assertFalse(QuietHours.inside(1320, 420, 1319));
        assertTrue(QuietHours.inside(1320, 420, 419));
        assertFalse(QuietHours.inside(1320, 420, 420));
        assertTrue(QuietHours.inside(780, 840, 780));
        assertFalse(QuietHours.inside(780, 840, 840));
    }

    @Test
    public void equalBoundsAreNeverInside() {
        assertFalse(QuietHours.inside(600, 600, 600));
        assertFalse(QuietHours.inside(600, 600, 0));
        assertFalse(QuietHours.inside(600, 600, 599));
        assertFalse(QuietHours.inside(600, 600, 1439));
    }
}
