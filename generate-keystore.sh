#!/usr/bin/env bash
#keytool -genkey -v -keystore my-release-key.keystore -alias alias_name -keyalg RSA -keysize 2048 -validity 10000

keytool -genkey -v -keystore debug.keystore -storepass android -alias android -keypass android -keyalg RSA -keysize 2048 -validity 10000

# Or with android studio : https://developer.android.com/studio/publish/app-signing
# Or https://stackoverflow.com/questions/3997748/how-can-i-create-a-keystore
# https://github.com/ionic-team/capacitor/issues/6794

# Add this configuration after into capacitor.config.ts
#  android: {
#    buildOptions: {
#      releaseType: 'APK',
#      keystorePath: '/home/username/CustomFolder/myCustomName.jks',
#      keystorePassword: 'verysecret',
#      keystoreAlias: 'custom_alias',
#      keystoreAliasPassword: 'alsosecret'
#    }
#  }