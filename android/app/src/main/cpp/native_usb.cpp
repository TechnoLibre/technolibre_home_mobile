// native_usb.cpp
//
// Minimal JNI shim around the Linux USBDEVFS ioctls. Used as a last-resort
// reader path for the Stream Deck plugin: when Java's UsbDeviceConnection
// claim/read paths are silently shadow-consumed by the kernel HID driver
// (observed on Lenovo ThinkPhone, Pixel 6, possibly others), we fall back
// here. The trick is USBDEVFS_DISCONNECT, which detaches the in-kernel
// driver from the interface BEFORE we claim it — Java's claimInterface
// (force=true) does not do this; it claims atop whatever the kernel still
// holds, which on these phones means the kernel keeps owning the
// interrupt-IN endpoint and our reads return nothing.
//
// All entry points operate on a file descriptor that the Java side has
// already obtained via UsbDeviceConnection.getFileDescriptor(). The fd is
// dup'd by the connection — closing the connection closes the fd, so
// callers must keep the connection alive while these ioctls run.

#include <jni.h>
#include <linux/usbdevice_fs.h>
#include <sys/ioctl.h>
#include <android/log.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>

#define TAG "NativeUsb"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)

extern "C" {

// Detach any in-kernel driver currently bound to the given USB interface.
// Returns 0 on success, -errno on failure. ENODATA means no driver was
// attached (which is fine — proceed to claim).
JNIEXPORT jint JNICALL
Java_ca_erplibre_home_streamdeck_NativeUsb_nativeDisconnectKernel(
    JNIEnv* /*env*/, jclass /*clazz*/, jint fd, jint interfaceNum) {
    struct usbdevfs_ioctl command;
    command.ifno = interfaceNum;
    command.ioctl_code = USBDEVFS_DISCONNECT;
    command.data = nullptr;
    int ret = ioctl(fd, USBDEVFS_IOCTL, &command);
    if (ret < 0) {
        int e = errno;
        if (e == ENODATA) {
            LOGI("disconnect kernel: no driver attached on iface=%d (ok)", interfaceNum);
            return 0;
        }
        LOGW("disconnect kernel ioctl failed: errno=%d (%s)", e, strerror(e));
        return -e;
    }
    LOGI("kernel driver disconnected from interface %d", interfaceNum);
    return 0;
}

JNIEXPORT jint JNICALL
Java_ca_erplibre_home_streamdeck_NativeUsb_nativeClaimInterface(
    JNIEnv* /*env*/, jclass /*clazz*/, jint fd, jint interfaceNum) {
    int iface = interfaceNum;
    int ret = ioctl(fd, USBDEVFS_CLAIMINTERFACE, &iface);
    if (ret < 0) {
        int e = errno;
        LOGW("claim ioctl failed: errno=%d (%s)", e, strerror(e));
        return -e;
    }
    LOGI("native claimed interface %d", interfaceNum);
    return 0;
}

JNIEXPORT jint JNICALL
Java_ca_erplibre_home_streamdeck_NativeUsb_nativeReleaseInterface(
    JNIEnv* /*env*/, jclass /*clazz*/, jint fd, jint interfaceNum) {
    int iface = interfaceNum;
    int ret = ioctl(fd, USBDEVFS_RELEASEINTERFACE, &iface);
    if (ret < 0) return -errno;
    return 0;
}

// Bulk transfer (kernel maps to interrupt for interrupt endpoints, same
// as Java's bulkTransfer). Returns bytes read on success, -errno on
// failure. -ETIMEDOUT means timeout, treat as benign and retry.
JNIEXPORT jint JNICALL
Java_ca_erplibre_home_streamdeck_NativeUsb_nativeBulkRead(
    JNIEnv* env, jclass /*clazz*/,
    jint fd, jint endpoint, jbyteArray buf, jint timeoutMs) {
    if (buf == nullptr) return -EINVAL;
    jbyte* data = env->GetByteArrayElements(buf, nullptr);
    if (data == nullptr) return -ENOMEM;
    jsize bufLen = env->GetArrayLength(buf);

    struct usbdevfs_bulktransfer xfer;
    xfer.ep      = static_cast<unsigned int>(endpoint);
    xfer.len     = static_cast<unsigned int>(bufLen);
    xfer.timeout = static_cast<unsigned int>(timeoutMs);
    xfer.data    = data;
    int got = ioctl(fd, USBDEVFS_BULK, &xfer);
    int saved_errno = errno;

    env->ReleaseByteArrayElements(buf, data, 0);
    if (got < 0) return -saved_errno;
    return got;
}

}  // extern "C"
