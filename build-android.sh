#!/usr/bin/env bash

# Build Android app
npx cap sync android
npx cap build android
#npx cap build android --keystorepath debug.keystore --keystorepass android --keystorealias android --keystorealiaspass android --androidreleasetype APK
