package ca.erplibre.home.streamdeck;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** Maps Elgato USB product IDs to immutable DeckSpec. Built once at class load. */
public final class DeckRegistry {
    public static final int ELGATO_VENDOR_ID = 0x0fd9;

    private static final Map<Integer, DeckSpec> SPECS;

    static {
        Map<Integer, DeckSpec> m = new HashMap<>();

        m.put(0x0060, DeckSpec.builder()
            .model("original_v1").productId(0x0060)
            .grid(3, 5)
            .keyImage(72, 72, DeckSpec.ImageFormat.BMP_BGR_ROT180)
            .transport(DeckSpec.TransportKind.V1)
            .capability("keys")
            .build());

        m.put(0x0063, DeckSpec.builder()
            .model("mini").productId(0x0063)
            .grid(2, 3)
            .keyImage(80, 80, DeckSpec.ImageFormat.BMP_BGR_ROT270)
            .transport(DeckSpec.TransportKind.V1)
            .capability("keys")
            .build());

        m.put(0x006c, DeckSpec.builder()
            .model("xl").productId(0x006c)
            .grid(4, 8)
            .keyImage(96, 96, DeckSpec.ImageFormat.JPEG)
            .keyImageRotation(180)
            .transport(DeckSpec.TransportKind.V2)
            .capability("keys")
            .build());

        // Stream Deck XL v2 — newer hardware revision, identical dimensions
        // and wire protocol to the original XL.
        m.put(0x008f, DeckSpec.builder()
            .model("xl_v2").productId(0x008f)
            .grid(4, 8)
            .keyImage(96, 96, DeckSpec.ImageFormat.JPEG)
            .keyImageRotation(180)
            .transport(DeckSpec.TransportKind.V2)
            .capability("keys")
            .build());

        m.put(0x006d, DeckSpec.builder()
            .model("original_v2").productId(0x006d)
            .grid(3, 5)
            .keyImage(72, 72, DeckSpec.ImageFormat.JPEG)
            .keyImageRotation(180)
            .transport(DeckSpec.TransportKind.V2)
            .capability("keys")
            .build());

        m.put(0x0080, DeckSpec.builder()
            .model("mk2").productId(0x0080)
            .grid(3, 5)
            .keyImage(72, 72, DeckSpec.ImageFormat.JPEG)
            .keyImageRotation(180)
            .transport(DeckSpec.TransportKind.V2)
            .capability("keys")
            .build());

        m.put(0x0084, DeckSpec.builder()
            .model("plus").productId(0x0084)
            .grid(2, 4)
            .keyImage(120, 120, DeckSpec.ImageFormat.JPEG)
            .dials(4)
            .lcd(800, 100)
            .transport(DeckSpec.TransportKind.V2)
            .capability("keys").capability("dials").capability("lcd")
            .build());

        m.put(0x009a, DeckSpec.builder()
            .model("neo").productId(0x009a)
            .grid(2, 4)
            .keyImage(96, 96, DeckSpec.ImageFormat.JPEG)
            .infoBars(248, 58, 1)
            .touch(2)
            .transport(DeckSpec.TransportKind.V2)
            .capability("keys").capability("infobars").capability("touchpoints")
            .build());

        SPECS = Collections.unmodifiableMap(m);
    }

    private DeckRegistry() {}

    public static DeckSpec lookup(int productId) {
        return SPECS.get(productId);
    }

    public static boolean isElgato(int vendorId) {
        return vendorId == ELGATO_VENDOR_ID;
    }
}
