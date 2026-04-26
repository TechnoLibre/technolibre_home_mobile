package ca.erplibre.home.streamdeck;

import java.util.Collections;
import java.util.List;

/**
 * Immutable description of a Stream Deck model. One instance per supported model,
 * built once and stored in DeckRegistry. Instances are safely shareable across threads.
 */
public final class DeckSpec {
    public enum ImageFormat { JPEG, BMP_BGR_ROT180, BMP_BGR_ROT270 }
    public enum TransportKind { V1, V2 }

    public final String model;            // "mk2", "xl", "plus", "neo", "original_v1", "original_v2", "mini"
    public final int productId;           // 0x0080 etc.
    public final int rows;
    public final int cols;
    public final int keyCount;
    public final int keyImageW;
    public final int keyImageH;
    public final ImageFormat keyImageFormat;
    public final int dialCount;           // 0 except Plus (4)
    public final int lcdW;                // 0 if no LCD
    public final int lcdH;
    public final int infoBarW;            // 0 if no info bars
    public final int infoBarH;
    public final int infoBarCount;        // 0 except Neo (2)
    public final int touchPoints;         // 0 except Neo (2); Plus uses lcd touch
    public final TransportKind transport;
    public final List<String> capabilities; // subset of: keys, dials, lcd, infobars, touchpoints

    private DeckSpec(Builder b) {
        this.model = b.model;
        this.productId = b.productId;
        this.rows = b.rows;
        this.cols = b.cols;
        this.keyCount = b.rows * b.cols;
        this.keyImageW = b.keyImageW;
        this.keyImageH = b.keyImageH;
        this.keyImageFormat = b.keyImageFormat;
        this.dialCount = b.dialCount;
        this.lcdW = b.lcdW;
        this.lcdH = b.lcdH;
        this.infoBarW = b.infoBarW;
        this.infoBarH = b.infoBarH;
        this.infoBarCount = b.infoBarCount;
        this.touchPoints = b.touchPoints;
        this.transport = b.transport;
        this.capabilities = Collections.unmodifiableList(b.capabilities);
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        String model; int productId; int rows; int cols;
        int keyImageW; int keyImageH; ImageFormat keyImageFormat;
        int dialCount; int lcdW; int lcdH; int infoBarW; int infoBarH;
        int infoBarCount; int touchPoints; TransportKind transport;
        java.util.ArrayList<String> capabilities = new java.util.ArrayList<>();

        public Builder model(String v) { this.model = v; return this; }
        public Builder productId(int v) { this.productId = v; return this; }
        public Builder grid(int rows, int cols) { this.rows = rows; this.cols = cols; return this; }
        public Builder keyImage(int w, int h, ImageFormat f) { this.keyImageW = w; this.keyImageH = h; this.keyImageFormat = f; return this; }
        public Builder dials(int n) { this.dialCount = n; return this; }
        public Builder lcd(int w, int h) { this.lcdW = w; this.lcdH = h; return this; }
        public Builder infoBars(int w, int h, int count) { this.infoBarW = w; this.infoBarH = h; this.infoBarCount = count; return this; }
        public Builder touch(int n) { this.touchPoints = n; return this; }
        public Builder transport(TransportKind v) { this.transport = v; return this; }
        public Builder capability(String c) { this.capabilities.add(c); return this; }
        public DeckSpec build() { return new DeckSpec(this); }
    }
}
