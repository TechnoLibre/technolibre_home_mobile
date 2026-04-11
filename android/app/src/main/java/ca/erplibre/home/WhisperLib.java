package ca.erplibre.home;

/**
 * JNI bridge to libwhisper_jni.so (built from whisper.cpp via CMake + Android NDK).
 */
public class WhisperLib {

    static {
        System.loadLibrary("whisper_jni");
    }

    /**
     * Load a GGML model file and return an opaque context pointer.
     * Returns 0 on failure.
     */
    public static native long initContext(String modelPath);

    /** Release a previously loaded context. */
    public static native void freeContext(long ctxPtr);

    /**
     * Transcribe 16 kHz mono PCM float[] audio.
     *
     * @param ctxPtr   context pointer returned by initContext()
     * @param audioData 16 kHz mono PCM normalised to [-1, 1]
     * @param language  BCP-47 language code, e.g. "fr" or "en"
     * @return transcribed text (may start with "[error: …]" on failure)
     */
    public static native String transcribeAudio(long ctxPtr, float[] audioData, String language);
}
