package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Source check on StreamDeckPlugin, whose PluginCall handling needs a
 * Capacitor bridge to run.
 *
 * Every StreamDeckPlugin method settles its call once, possibly later from
 * the writer thread, which a plain call allows. A kept-alive call is stored
 * by the Bridge in savedCalls, with its base64 payload, until releaseCall:
 * a call kept alive for a single resolve is never freed, and a deck
 * repainted many times per second fills the heap.
 */
public class PluginCallLifetimeTest {

    /** Gradle runs unit tests from the module directory. */
    private static final Path PLUGIN =
        Paths.get("src/main/java/ca/erplibre/home/streamdeck/StreamDeckPlugin.java");

    @Test
    public void no_call_is_kept_alive_for_a_single_resolve() throws IOException {
        String src = new String(Files.readAllBytes(PLUGIN), StandardCharsets.UTF_8);
        assertFalse("StreamDeckPlugin keeps a PluginCall alive",
            src.contains("setKeepAlive(true)"));
    }
}
