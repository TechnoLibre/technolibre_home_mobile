# Install

Read the license

```bash
./install-license.sh
```

Install with NPM dependencies

```bash
sudo ./install.sh
```

Show list of platform, choose the command :

```bash
./cordova-list-platform.sh
```

# Android

Read this for installation Android-studio
https://developer.android.com/studio/install?hl=fr

For Android new project

```bash
./create-android.sh
./build-android.sh
```

Move the app-debug.apk file into the ADV in Android Studio.

```bash
nautilus $(cat "project-path.txt")/platforms/android/app/build/outputs/apk/debug/
```