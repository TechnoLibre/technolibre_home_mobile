package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class WriteFailureReporterTest {

    @Test
    public void first_failure_is_reported() {
        WriteFailureReporter r = new WriteFailureReporter();
        assertTrue(r.shouldReport("key:0", "format_mismatch:bmp_model_requires_png"));
    }

    @Test
    public void same_failure_repeated_is_reported_once() {
        // A streamer offers the same bad frame for a key every tick.
        WriteFailureReporter r = new WriteFailureReporter();
        assertTrue(r.shouldReport("key:0", "image_decode_failed"));
        for (int i = 0; i < 100; i++) assertFalse(r.shouldReport("key:0", "image_decode_failed"));
    }

    @Test
    public void a_different_failure_is_reported() {
        WriteFailureReporter r = new WriteFailureReporter();
        assertTrue(r.shouldReport("key:0", "image_decode_failed"));
        assertTrue(r.shouldReport("key:0", "format_mismatch:bmp_model_requires_png"));
        assertTrue(r.shouldReport("key:0", "image_decode_failed"));
    }

    @Test
    public void a_success_rearms_the_same_failure() {
        WriteFailureReporter r = new WriteFailureReporter();
        assertTrue(r.shouldReport("key:0", "image_decode_failed"));
        r.succeeded("key:0");
        assertTrue(r.shouldReport("key:0", "image_decode_failed"));
    }

    @Test
    public void each_key_is_reported_on_its_own() {
        WriteFailureReporter r = new WriteFailureReporter();
        assertTrue(r.shouldReport("key:0", "image_decode_failed"));
        assertTrue(r.shouldReport("key:1", "image_decode_failed"));
    }

    @Test
    public void a_success_on_another_key_does_not_rearm() {
        // One bad key among good ones must not be reported every frame.
        WriteFailureReporter r = new WriteFailureReporter();
        assertTrue(r.shouldReport("key:3", "image_decode_failed"));
        for (int i = 0; i < 100; i++) {
            r.succeeded("key:0");
            assertFalse(r.shouldReport("key:3", "image_decode_failed"));
        }
    }
}
