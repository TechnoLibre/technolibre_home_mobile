#!/bin/bash
# Start Android emulator headless and wait for it to be ready
# Usage: ./run-emulator-android.sh [--install path/to/app.apk] [--logcat]

set -e

# --- KVM group activation ---
# User may be in the kvm group in /etc/group but the current session
# was started before the group was added (install-emulator-android.sh ran
# adduser). Re-exec via 'sg kvm' to activate it without logging out.
if ! id -nG | grep -qw kvm; then
    if grep -qP "^kvm:[^:]*:[^:]*:.*\b${USER}\b" /etc/group 2>/dev/null; then
        echo "==> KVM group found in /etc/group but not active in this session."
        echo "    Re-launching with 'sg kvm' to activate it..."
        exec sg kvm -c "\"$0\" $*"
    fi
fi

ANDROID_HOME="${ANDROID_HOME:-$HOME/android}"
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
AVD_NAME="erplibre_test"
BOOT_TIMEOUT=120  # seconds

APK_TO_INSTALL=""
SHOW_LOGCAT=false

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install)
            APK_TO_INSTALL="$2"
            shift 2
            ;;
        --logcat)
            SHOW_LOGCAT=true
            shift
            ;;
        --avd)
            AVD_NAME="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--install path/to/app.apk] [--logcat] [--avd AVD_NAME]"
            echo ""
            echo "Options:"
            echo "  --install FILE   Install APK after boot"
            echo "  --logcat         Stream app logcat after install"
            echo "  --avd NAME       AVD name (default: erplibre_test)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# --- Checks ---
if [ ! -x "$EMULATOR" ]; then
    echo "ERROR: emulator not found at $EMULATOR"
    echo "       Run install-emulator-android.sh first."
    exit 1
fi

if [ ! -x "$ADB" ]; then
    echo "ERROR: adb not found at $ADB"
    exit 1
fi

export ANDROID_HOME
export ANDROID_AVD_HOME="$HOME/.android/avd"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"

# --- Pre-create ini files to suppress harmless first-run warnings ---
mkdir -p "$HOME/.android"
touch "$HOME/.android/emu-update-last-check.ini" 2>/dev/null || true
mkdir -p "$HOME/.android/avd/${AVD_NAME}.avd" 2>/dev/null || true
if [ ! -f "$HOME/.android/avd/${AVD_NAME}.avd/quickbootChoice.ini" ]; then
    echo "saveOnExit = yes" > "$HOME/.android/avd/${AVD_NAME}.avd/quickbootChoice.ini"
fi

# --- Check if emulator already running ---
if "$ADB" devices | grep -q "emulator-"; then
    echo "==> Emulator already running:"
    "$ADB" devices -l
    EMULATOR_SERIAL=$("$ADB" devices | grep "emulator-" | awk '{print $1}' | head -1)
else
    # --- Start emulator ---
    echo "==> Starting AVD '${AVD_NAME}' in headless mode..."
    EMULATOR_LOG="/tmp/emulator-${AVD_NAME}.log"
    "$EMULATOR" \
        -avd "$AVD_NAME" \
        -no-window \
        -no-audio \
        -no-boot-anim \
        -no-snapshot-load \
        -gpu swiftshader_indirect \
        -memory 2048 \
        > "$EMULATOR_LOG" 2>&1 \
        &
    EMULATOR_PID=$!
    echo "    Emulator PID: $EMULATOR_PID (log: $EMULATOR_LOG)"

    # --- Wait for boot ---
    echo ""
    echo "==> Waiting for emulator to boot (timeout: ${BOOT_TIMEOUT}s)..."
    ELAPSED=0
    until "$ADB" shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; do
        sleep 3
        ELAPSED=$((ELAPSED + 3))
        echo -n "."
        if [ $ELAPSED -ge $BOOT_TIMEOUT ]; then
            echo ""
            echo "ERROR: Emulator did not boot within ${BOOT_TIMEOUT}s."
            kill "$EMULATOR_PID" 2>/dev/null || true
            exit 1
        fi
    done
    echo ""
    echo "    Boot complete in ${ELAPSED}s."

    EMULATOR_SERIAL=$("$ADB" devices | grep "emulator-" | awk '{print $1}' | head -1)
fi

echo ""
echo "==> Device ready: $EMULATOR_SERIAL"
echo "    Android version: $("$ADB" -s "$EMULATOR_SERIAL" shell getprop ro.build.version.release 2>/dev/null)"
echo "    API level:       $("$ADB" -s "$EMULATOR_SERIAL" shell getprop ro.build.version.sdk 2>/dev/null)"

# --- Install APK if requested ---
if [ -n "$APK_TO_INSTALL" ]; then
    if [ ! -f "$APK_TO_INSTALL" ]; then
        echo ""
        echo "ERROR: APK not found: $APK_TO_INSTALL"
        exit 1
    fi
    echo ""
    echo "==> Installing APK: $APK_TO_INSTALL"
    "$ADB" -s "$EMULATOR_SERIAL" install -r "$APK_TO_INSTALL"
    echo "    Installation complete."

    # Detect package name from APK
    AAPT="$ANDROID_HOME/build-tools/34.0.0/aapt"
    if [ -x "$AAPT" ]; then
        PKG=$("$AAPT" dump badging "$APK_TO_INSTALL" 2>/dev/null | grep "^package:" | sed "s/.*name='\([^']*\)'.*/\1/")
        echo "    Package: $PKG"

        echo ""
        echo "==> Launching app..."
        LAUNCHER=$("$ADB" -s "$EMULATOR_SERIAL" shell cmd package resolve-activity --brief "$PKG" 2>/dev/null | tail -1)
        "$ADB" -s "$EMULATOR_SERIAL" shell am start -n "$LAUNCHER" 2>/dev/null || \
        "$ADB" -s "$EMULATOR_SERIAL" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 2>/dev/null || true
    fi
fi

# --- Logcat ---
if [ "$SHOW_LOGCAT" = true ]; then
    echo ""
    echo "==> Streaming logcat (Ctrl+C to stop)..."
    "$ADB" -s "$EMULATOR_SERIAL" logcat -v time \
        | grep -E "ERPLibre|erplibre|Capacitor|chromium|WebView|FATAL|AndroidRuntime"
fi

echo ""
echo "==> Emulator is running. Useful commands:"
echo "    $ADB -s $EMULATOR_SERIAL shell"
echo "    $ADB -s $EMULATOR_SERIAL install app.apk"
echo "    $ADB -s $EMULATOR_SERIAL logcat"
echo "    $ADB -s $EMULATOR_SERIAL screencap /sdcard/screen.png && $ADB pull /sdcard/screen.png"
echo "    $ADB -s $EMULATOR_SERIAL emu kill   # stop emulator"
