package ca.erplibre.home;

/** Pixel size arithmetic of ChatFilePlugin.toJpeg, free of Android classes for JUnit. */
final class ChatImageSize {

    private ChatImageSize() {}

    /**
     * {width, height} scaled so the long side is at most maxPx, the aspect
     * kept and rounded, never under 1 px. maxPx 0 (or less), or an image
     * already within it, keeps the size.
     */
    static int[] fit(int width, int height, int maxPx) {
        int longSide = Math.max(width, height);
        if (maxPx <= 0 || longSide <= maxPx) return new int[] {width, height};
        double scale = (double) maxPx / longSide;
        int w = width >= height ? maxPx : Math.max(1, (int) Math.round(width * scale));
        int h = height > width ? maxPx : Math.max(1, (int) Math.round(height * scale));
        return new int[] {w, h};
    }

    /**
     * The largest power of two that decodes width x height at no less than
     * the fitted size: BitmapFactory's inSampleSize, which keeps the
     * decoded bitmap small before the exact scale.
     */
    static int sampleSize(int width, int height, int maxPx) {
        int longSide = Math.max(width, height);
        if (maxPx <= 0) return 1;
        int sample = 1;
        while (longSide / (sample * 2) >= maxPx) sample *= 2;
        return sample;
    }
}
