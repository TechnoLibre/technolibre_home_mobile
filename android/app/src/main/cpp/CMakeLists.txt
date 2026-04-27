cmake_minimum_required(VERSION 3.22.1)
project(erplibre_native)

option(BUILD_WHISPER "Build whisper.cpp transcription module" ON)

find_library(log-lib log)

# ── native_usb: always built ────────────────────────────────────────────────
# Lightweight JNI shim around the Linux USBDEVFS ioctls used by the Stream
# Deck reader fallback. Bypasses Java's UsbDeviceConnection.claimInterface
# so we can call USBDEVFS_DISCONNECT and detach a kernel HID driver that
# is otherwise shadow-consuming our interrupt-IN reads.
add_library(native_usb SHARED native_usb.cpp)
target_link_libraries(native_usb ${log-lib})

# ── whisper: opt-out via -DBUILD_WHISPER=OFF ───────────────────────────────
if(BUILD_WHISPER)
    set(BUILD_SHARED_LIBS       OFF CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_TESTS     OFF CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_EXAMPLES  OFF CACHE BOOL "" FORCE)
    set(GGML_NATIVE             OFF CACHE BOOL "" FORCE)
    set(GGML_OPENMP             OFF CACHE BOOL "" FORCE)
    set(GGML_AVX                OFF CACHE BOOL "" FORCE)
    set(GGML_AVX2               OFF CACHE BOOL "" FORCE)
    set(GGML_F16C               OFF CACHE BOOL "" FORCE)
    set(GGML_FMA                OFF CACHE BOOL "" FORCE)

    add_subdirectory(
        ${CMAKE_CURRENT_SOURCE_DIR}/whisper
        whisper_build
    )

    add_library(whisper_jni SHARED whisper_jni.cpp)

    target_include_directories(whisper_jni PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/whisper/include
        ${CMAKE_CURRENT_SOURCE_DIR}/whisper/ggml/include
    )

    target_link_libraries(whisper_jni
        whisper
        ${log-lib}
    )
endif()
