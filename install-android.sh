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

# Step 5: Verify installation
echo "==> Step 5: Verifying installation..."
sdkmanager --list | grep "Installed packages" -A 50 | grep -v "^---"
echo ""
echo "ANDROID_HOME=$ANDROID_HOME"
echo ""
echo "Android SDK installation complete."
echo "Run 'source ~/.bashrc' to apply environment variables in your current shell."
