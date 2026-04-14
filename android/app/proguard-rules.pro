# Add project specific ProGuard rules here.
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Keep line numbers for crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# --- Capacitor ---
# Keep all Capacitor plugins (accessed via reflection)
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public *;
}

# --- App native plugins ---
-keep class ca.erplibre.home.** { *; }

# --- JSch (SSH library) ---
-keep class com.jcraft.jsch.** { *; }
-dontwarn com.jcraft.jsch.**

# --- Google ML Kit (OCR) ---
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# --- ExoPlayer / Cast ---
-dontwarn com.google.android.exoplayer2.**

# --- AndroidX ---
-dontwarn androidx.**
