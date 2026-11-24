package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SeenIdsTest {

    @Test
    public void keepsTheLast500AndRoundTrips() {
        SeenIds ids = new SeenIds("", 500);
        for (int i = 0; i < 600; i++) assertTrue(ids.add("id" + i));
        SeenIds back = new SeenIds(ids.serialize(), 500);
        assertFalse("recent id kept", back.add("id599"));
        assertFalse("oldest kept id", back.add("id100"));
        assertTrue("dropped id is new again", back.add("id99"));
    }

    @Test
    public void duplicateIsReported() {
        SeenIds ids = new SeenIds(null, 5);
        assertTrue(ids.add("a1"));
        assertFalse(ids.add("a1"));
    }

    @Test
    public void smallerCapacityTrimsALongerSerialization() {
        SeenIds ids = new SeenIds("a,b,c,d", 2);
        assertTrue(ids.add("a"));
        assertFalse(ids.add("d"));
    }
}
