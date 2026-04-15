#!/usr/bin/env bash
set -e

# Install Android SDK on Ubuntu 24.04 (headless/server)

# Step 1: Install Java
echo "==> Step 1: Installing Java 17..."
sudo apt update
sudo apt install -y openjdk-17-jdk
JAVA_HOME_PATH=/usr/lib/jvm/java-17-openjdk-amd64
if ! grep -q "JAVA_HOME=$JAVA_HOME_PATH" ~/.bashrc; then
    echo "export JAVA_HOME=$JAVA_HOME_PATH" >> ~/.bashrc
fi

# Step 2: Download Android Command Line Tools
echo "==> Step 2: Downloading Android Command Line Tools..."
ANDROID_HOME=$HOME/android
mkdir -p "$ANDROID_HOME/cmdline-tools"
cd "$ANDROID_HOME/cmdline-tools"

CMDLINE_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
wget -q --show-progress "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
unzip -q "$CMDLINE_TOOLS_ZIP"
rm "$CMDLINE_TOOLS_ZIP"
mv cmdline-tools latest

# Step 3: Configure environment variables
echo "==> Step 3: Configuring environment variables..."
EXPORT_BLOCK='
# Android SDK
export ANDROID_HOME=$HOME/android
export ANDROID_SDK_ROOT=$HOME/android
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/emulator'

if ! grep -q "ANDROID_HOME=\$HOME/android" ~/.bashrc; then
    echo "$EXPORT_BLOCK" >> ~/.bashrc
fi

export ANDROID_HOME=$HOME/android
export ANDROID_SDK_ROOT=$HOME/android
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/emulator

# Step 4: Install SDK components
echo "==> Step 4: Installing SDK components..."
yes | sdkmanager --licenses
sdkmanager "platform-tools"
sdkmanager "platforms;android-34"
sdkmanager "build-tools;34.0.0"

# Step 5: Install NDK (required for whisper.cpp JNI build)
echo "==> Step 5: Installing Android NDK..."
# Via Android Studio :
#   Tools → SDK Manager → SDK Tools → NDK (Side by side) → cocher → Apply
#
# Via ligne de commande :
sdkmanager "ndk;27.0.12077973"

# Step 6: Clone whisper.cpp (required for on-device audio transcription)
echo "==> Step 6: Cloning whisper.cpp..."
WHISPER_DST="$(dirname "$0")/android/app/src/main/cpp/whisper"
if [ ! -d "$WHISPER_DST" ]; then
    mkdir -p "$(dirname "$WHISPER_DST")"
    git clone --depth=1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DST"
    echo "whisper.cpp cloned to $WHISPER_DST"
else
    echo "whisper.cpp already present at $WHISPER_DST, skipping clone."
fi

# Step 7: Clone sentencepiece (required for MarianMT on-device translation)
echo "==> Step 7: Cloning sentencepiece..."
SPM_DST="$(dirname "$0")/android/app/src/main/cpp/sentencepiece"
if [ ! -d "$SPM_DST" ]; then
    mkdir -p "$(dirname "$SPM_DST")"
    git clone --depth=1 https://github.com/google/sentencepiece.git "$SPM_DST"
    echo "sentencepiece cloned to $SPM_DST"
else
    echo "sentencepiece already present at $SPM_DST, skipping clone."
fi

# Step 8: Verify installation
echo "==> Step 8: Verifying installation..."
sdkmanager --list | grep "Installed packages" -A 50 | grep -v "^---"
echo ""
echo "ANDROID_HOME=$ANDROID_HOME"
echo ""
echo "Android SDK installation complete."
echo "Run 'source ~/.bashrc' to apply environment variables in your current shell."
