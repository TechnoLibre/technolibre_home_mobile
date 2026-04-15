cmake_minimum_required(VERSION 3.22.1)
project(whisper_marian_jni)

# ── whisper.cpp build flags ──────────────────────────────────────────────────
set(BUILD_SHARED_LIBS       OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS     OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES  OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE             OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP             OFF CACHE BOOL "" FORCE)
set(GGML_AVX                OFF CACHE BOOL "" FORCE)
set(GGML_AVX2               OFF CACHE BOOL "" FORCE)
set(GGML_F16C               OFF CACHE BOOL "" FORCE)
set(GGML_FMA                OFF CACHE BOOL "" FORCE)
# ─────────────────────────────────────────────────────────────────────────────

# whisper.cpp is cloned by the user at:
#   android/app/src/main/cpp/whisper/
add_subdirectory(
    ${CMAKE_CURRENT_SOURCE_DIR}/whisper
    whisper_build
)

# JNI bridge
add_library(whisper_jni SHARED whisper_jni.cpp)

target_include_directories(whisper_jni PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/whisper/include
    ${CMAKE_CURRENT_SOURCE_DIR}/whisper/ggml/include
)

find_library(log-lib log)

target_link_libraries(whisper_jni
    whisper
    ${log-lib}
)

# ── MarianMT / SentencePiece ─────────────────────────────────────────────────
# Requires sentencepiece cloned at android/app/src/main/cpp/sentencepiece/
#
#   git clone --depth=1 https://github.com/google/sentencepiece \
#       android/app/src/main/cpp/sentencepiece
#
# The marian_jni target is only built when the source is present.
# Without it the app still compiles; MarianLib.isAvailable() returns false.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/sentencepiece/CMakeLists.txt)
    set(SPM_ENABLE_SHARED   OFF CACHE BOOL "" FORCE)
    set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
    set(SPM_NO_THREADLOCAL  ON  CACHE BOOL "" FORCE)

    add_subdirectory(
        ${CMAKE_CURRENT_SOURCE_DIR}/sentencepiece
        sentencepiece_build
    )

    # Fix: DCHECK_GE / DCHECK_LT are undeclared when building for Android because
    # sentencepiece's common.h uses __has_include("absl/log/check.h") which
    # returns false in NDK cross-compilation (sysroot doesn't expose the bundled
    # absl through __has_include).  Force-include our compat shim so the macros
    # are defined as no-ops before any sentencepiece TU sees model_interface.h.
    set(_SPM_COMPAT_FLAG
        "-include${CMAKE_CURRENT_SOURCE_DIR}/sentencepiece_android_compat.h"
    )
    foreach(_spm_target sentencepiece-static sentencepiece_train-static)
        if(TARGET ${_spm_target})
            target_compile_options(${_spm_target} PRIVATE ${_SPM_COMPAT_FLAG})
            # Also expose third_party/ so "absl/log/check.h" can resolve to
            # third_party/absl/log/check.h if absl lacks the absl/ prefix dir.
            target_include_directories(${_spm_target} PRIVATE
                ${CMAKE_CURRENT_SOURCE_DIR}/sentencepiece/third_party
            )
        endif()
    endforeach()

    # Fix: sentencepiece unconditionally builds spm_* CLI executables even on
    # Android.  protobuf-lite/common.cc calls __android_log_write (from -llog)
    # but these executables don't link it.  Add -llog so the linker finds the
    # symbol.  (We don't ship these executables; they're just built as a side
    # effect of add_subdirectory.)
    foreach(_spm_exe spm_train spm_encode spm_decode
                     spm_normalize spm_export_vocab)
        if(TARGET ${_spm_exe})
            # Use plain (no-keyword) signature: sentencepiece/src/CMakeLists.txt
            # already used plain target_link_libraries on these targets and CMake
            # requires all calls for a target to be either all-keyword or all-plain.
            target_link_libraries(${_spm_exe} ${log-lib})
        endif()
    endforeach()

    add_library(marian_jni SHARED marian_jni.cpp)

    target_include_directories(marian_jni PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/sentencepiece/src
    )

    target_link_libraries(marian_jni
        sentencepiece-static
        ${log-lib}
    )
else()
    message(WARNING
        "sentencepiece not found — MarianMT will not be available.\n"
        "Clone it with: git clone --depth=1 "
        "https://github.com/google/sentencepiece "
        "${CMAKE_CURRENT_SOURCE_DIR}/sentencepiece"
    )
endif()

