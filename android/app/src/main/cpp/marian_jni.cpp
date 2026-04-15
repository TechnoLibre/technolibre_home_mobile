/**
 * JNI bridge between MarianLib.java and the SentencePiece C++ library.
 *
 * Exposes four operations: loadModel, freeModel, encode, decode.
 * The processor pointer is stored as a Java long and cast back here.
 */

#include <jni.h>
#include <android/log.h>
#include <sentencepiece_processor.h>
#include <string>
#include <vector>

#define LOG_TAG "MarianJNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jlong JNICALL
Java_ca_erplibre_home_MarianLib_loadModel(JNIEnv* env, jclass, jstring modelPath) {
    const char* path = env->GetStringUTFChars(modelPath, nullptr);
    auto* proc = new sentencepiece::SentencePieceProcessor();
    const auto status = proc->Load(std::string(path));
    env->ReleaseStringUTFChars(modelPath, path);
    if (!status.ok()) {
        LOGE("Failed to load SPM model: %s", status.ToString().c_str());
        delete proc;
        return 0L;
    }
    return reinterpret_cast<jlong>(proc);
}

JNIEXPORT void JNICALL
Java_ca_erplibre_home_MarianLib_freeModel(JNIEnv* /*env*/, jclass, jlong ptr) {
    if (ptr != 0L) {
        delete reinterpret_cast<sentencepiece::SentencePieceProcessor*>(ptr);
    }
}

JNIEXPORT jintArray JNICALL
Java_ca_erplibre_home_MarianLib_encode(JNIEnv* env, jclass, jlong ptr, jstring text) {
    if (ptr == 0L) return env->NewIntArray(0);

    auto* proc = reinterpret_cast<sentencepiece::SentencePieceProcessor*>(ptr);
    const char* input = env->GetStringUTFChars(text, nullptr);
    std::vector<int> ids;
    proc->Encode(std::string(input), &ids);
    env->ReleaseStringUTFChars(text, input);

    jintArray result = env->NewIntArray(static_cast<jsize>(ids.size()));
    if (!ids.empty()) {
        env->SetIntArrayRegion(result, 0, static_cast<jsize>(ids.size()),
                               reinterpret_cast<const jint*>(ids.data()));
    }
    return result;
}

JNIEXPORT jstring JNICALL
Java_ca_erplibre_home_MarianLib_decode(JNIEnv* env, jclass, jlong ptr, jintArray ids) {
    if (ptr == 0L) return env->NewStringUTF("");

    auto* proc = reinterpret_cast<sentencepiece::SentencePieceProcessor*>(ptr);
    const jsize len = env->GetArrayLength(ids);
    jint* buf = env->GetIntArrayElements(ids, nullptr);
    const std::vector<int> idVec(buf, buf + len);
    env->ReleaseIntArrayElements(ids, buf, JNI_ABORT);

    std::string output;
    proc->Decode(idVec, &output);
    return env->NewStringUTF(output.c_str());
}

} // extern "C"
