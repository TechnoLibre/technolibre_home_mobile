#include <jni.h>
#include <android/log.h>
#include "whisper.h"
#include <string>
#include <vector>

#define TAG "WhisperJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

extern "C" {

// ---------------------------------------------------------------------------
// initContext(modelPath: String): Long
// ---------------------------------------------------------------------------
JNIEXPORT jlong JNICALL
Java_ca_erplibre_home_WhisperLib_initContext(
        JNIEnv *env, jclass /*cls*/, jstring modelPath)
{
    const char *path = env->GetStringUTFChars(modelPath, nullptr);
    LOGI("Loading whisper model from: %s", path);

    whisper_context_params params = whisper_context_default_params();
    whisper_context *ctx = whisper_init_from_file_with_params(path, params);

    env->ReleaseStringUTFChars(modelPath, path);

    if (!ctx) {
        LOGE("Failed to load whisper model");
        return 0L;
    }
    LOGI("Whisper model loaded successfully");
    return reinterpret_cast<jlong>(ctx);
}

// ---------------------------------------------------------------------------
// freeContext(ctxPtr: Long)
// ---------------------------------------------------------------------------
JNIEXPORT void JNICALL
Java_ca_erplibre_home_WhisperLib_freeContext(
        JNIEnv * /*env*/, jclass /*cls*/, jlong ctxPtr)
{
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);
    if (ctx) {
        whisper_free(ctx);
        LOGI("Whisper context freed");
    }
}

// ---------------------------------------------------------------------------
// transcribeAudio(ctxPtr: Long, audioData: FloatArray, language: String): String
// ---------------------------------------------------------------------------
JNIEXPORT jstring JNICALL
Java_ca_erplibre_home_WhisperLib_transcribeAudio(
        JNIEnv *env, jclass /*cls*/,
        jlong ctxPtr, jfloatArray audioData, jstring languageTag)
{
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);
    if (!ctx) {
        return env->NewStringUTF("[error: no whisper context]");
    }

    const char *lang = env->GetStringUTFChars(languageTag, nullptr);

    jsize len = env->GetArrayLength(audioData);
    jfloat *data = env->GetFloatArrayElements(audioData, nullptr);

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.language          = lang;
    params.translate         = false;
    params.no_context        = true;
    params.single_segment    = false;
    params.print_progress    = false;
    params.print_realtime    = false;
    params.print_timestamps  = false;
    params.n_threads         = 4;

    LOGI("Starting whisper transcription (%d samples, lang=%s)", (int)len, lang);
    int ret = whisper_full(ctx, params, data, (int)len);

    env->ReleaseFloatArrayElements(audioData, data, JNI_ABORT);
    env->ReleaseStringUTFChars(languageTag, lang);

    if (ret != 0) {
        LOGE("whisper_full() failed with code %d", ret);
        return env->NewStringUTF("[error: transcription failed]");
    }

    std::string result;
    int n_segments = whisper_full_n_segments(ctx);
    for (int i = 0; i < n_segments; i++) {
        const char *seg = whisper_full_get_segment_text(ctx, i);
        if (seg) result += seg;
    }

    LOGI("Transcription done: %zu chars, %d segments", result.size(), n_segments);
    return env->NewStringUTF(result.c_str());
}

} // extern "C"
