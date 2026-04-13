#!/bin/bash
# Install Android emulator + system image for headless testing on Ubuntu 24.04
# Requires: Android SDK already installed (run install-android.sh first)
# KVM recommended for performance (/dev/kvm)

set -e

ANDROID_HOME="${ANDROID_HOME:-$HOME/android}"
SDK="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVD="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
AVD_NAME="erplibre_test"
API_LEVEL="34"
ABI="x86_64"
IMAGE="system-images;android-${API_LEVEL};google_apis;${ABI}"

echo "==> Android emulator installer for Ubuntu 24.04"
echo "    ANDROID_HOME=$ANDROID_HOME"
echo ""

# --- Prerequisites ---
echo "==> Step 1: Checking prerequisites..."

if [ ! -x "$SDK" ]; then
    echo "ERROR: sdkmanager not found at $SDK"
    echo "       Run install-android.sh first."
    exit 1
fi

if [ ! -r /dev/kvm ]; then
    echo "==> KVM not accessible — installing kvm support for better performance..."
    sudo apt-get update -q
    sudo apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils
    sudo adduser "$USER" kvm
    echo "    NOTE: Log out and back in for KVM group membership to take effect."
    echo "          Or run: newgrp kvm"
else
    echo "    KVM available — emulator will run at full speed."
fi

# --- Required packages for headless emulator on Ubuntu 24.04 ---
echo ""
echo "==> Step 2: Installing system dependencies..."
sudo apt-get update -q
sudo apt-get install -y \
    libpulse0 \
    libgl1 \
    libx11-6 \
    libxext6 \
    libxrender1 \
    libxtst6 \
    libxi6 \
    libnss3 \
    libxdamage1 \
    libgbm1 \
    libc6 \
    zlib1g

# --- Android SDK packages ---
echo ""
echo "==> Step 3: Installing Android emulator package..."
export ANDROID_HOME
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"

yes | "$SDK" --licenses > /dev/null 2>&1 || true
"$SDK" "emulator"

echo ""
echo "==> Step 4: Installing system image (android-${API_LEVEL} ${ABI})..."
echo "    This download is ~1.5 GB — please wait..."
"$SDK" "$IMAGE"

# --- Create AVD ---
echo ""
echo "==> Step 5: Creating AVD '${AVD_NAME}'..."
if "$AVD" list avd 2>/dev/null | grep -q "Name: ${AVD_NAME}"; then
    echo "    AVD '${AVD_NAME}' already exists — skipping creation."
else
    echo "no" | "$AVD" create avd \
        --name "$AVD_NAME" \
        --package "$IMAGE" \
        --device "pixel_6" \
        --force
    echo "    AVD '${AVD_NAME}' created."
fi

# --- Configure AVD for headless use ---
echo ""
echo "==> Step 6: Configuring AVD for headless/server use..."
AVD_CONFIG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
if [ -f "$AVD_CONFIG" ]; then
    # Disable audio, set sensible RAM/storage for server
    sed -i 's/^hw.audioInput=.*/hw.audioInput=no/'   "$AVD_CONFIG" 2>/dev/null || true
    sed -i 's/^hw.audioOutput=.*/hw.audioOutput=no/' "$AVD_CONFIG" 2>/dev/null || true
    # Set RAM to 2 GB if not already set higher
    if ! grep -q "^hw.ramSize=" "$AVD_CONFIG"; then
        echo "hw.ramSize=2048" >> "$AVD_CONFIG"
    fi
    echo "    AVD config updated."
fi

# --- Verify ---
echo ""
echo "==> Step 7: Verifying installation..."
"$SDK" --list_installed 2>/dev/null | grep -E "emulator|system-images" || true

echo ""
echo "==> Installation complete."
echo ""
echo "Run the emulator with:"
echo "    ./run-emulator-android.sh"
echo ""
echo "Then install the APK with:"
echo "    $ANDROID_HOME/platform-tools/adb install android/app/build/outputs/apk/debug/app-debug.apk"
