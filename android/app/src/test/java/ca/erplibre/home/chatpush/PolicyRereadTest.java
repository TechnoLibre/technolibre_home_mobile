package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class PolicyRereadTest {

    @Test
    public void aRereadStopsWithTheStartIdCurrentWhenItWasAsked() {
        PolicyReread r = new PolicyReread();
        List<Integer> stops = new ArrayList<>();
        r.started(2);
        Runnable asked = r.reread(() -> false, id -> stops.add(id));
        // a newer start arrives while the first re-read still blocks on the network
        r.started(3);
        Runnable newer = r.reread(() -> true, id -> stops.add(id));
        asked.run();
        newer.run();
        // stopSelfResult(2) is refused by Android once start 3 exists: the service lives on
        assertEquals(Arrays.asList(2), stops);
    }

    @Test
    public void aRereadThatStillWantsTheServiceDoesNotStopIt() {
        PolicyReread r = new PolicyReread();
        List<Integer> stops = new ArrayList<>();
        r.started(1);
        r.reread(() -> true, id -> stops.add(id)).run();
        assertTrue(stops.isEmpty());
    }

    @Test
    public void aCallbackRereadTakesTheLatestStartAtSubmitTime() {
        PolicyReread r = new PolicyReread();
        List<Integer> stops = new ArrayList<>();
        r.started(1);
        r.started(4);
        Runnable fromCallback = r.reread(() -> false, id -> stops.add(id));
        r.started(5);
        fromCallback.run();
        assertEquals(Arrays.asList(4), stops);
    }
}
