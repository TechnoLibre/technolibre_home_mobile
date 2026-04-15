package ca.erplibre.home;

/**
 * JNI bridge to the native SentencePiece tokenizer (libmarian_jni.so).
 *
 * If the native library is not compiled (sentencepiece source not cloned),
 * isAvailable() returns false and all other methods are no-ops / return empty.
 *
 * Setup: clone sentencepiece into android/app/src/main/cpp/sentencepiece/
 *   git clone --depth=1 https://github.com/google/sentencepiece \
 *       android/app/src/main/cpp/sentencepiece
 */
public class MarianLib {

    private static final boolean NATIVE_AVAILABLE;

    static {
        boolean ok = false;
        try {
            System.loadLibrary("marian_jni");
            ok = true;
        } catch (UnsatisfiedLinkError e) {
            android.util.Log.w("MarianLib",
                "marian_jni not available — sentencepiece not compiled. " +
                "See android/app/src/main/cpp/CMakeLists.txt for setup instructions.");
        }
        NATIVE_AVAILABLE = ok;
    }

    /** Returns true when the native library was loaded successfully. */
    public static boolean isAvailable() {
        return NATIVE_AVAILABLE;
    }

    /**
     * Load a SentencePiece model (.spm) from disk.
     * @return opaque pointer (pass to encode/decode/freeModel), or 0 on failure.
     */
    public static native long loadModel(String modelPath);

    /** Release a loaded SentencePiece model. ptr must be non-zero. */
    public static native void freeModel(long ptr);

    /**
     * Encode text into SentencePiece token IDs.
     * Returns an empty array on failure.
     */
    public static native int[] encode(long ptr, String text);

    /**
     * Decode SentencePiece token IDs back to text.
     * Returns empty string on failure.
     */
    public static native String decode(long ptr, int[] ids);
}
