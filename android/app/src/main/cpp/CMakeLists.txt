cmake_minimum_required(VERSION 3.22.1)
project(whisper_jni)

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
