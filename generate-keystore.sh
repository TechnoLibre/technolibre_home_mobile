#!/usr/bin/env bash
# Generate a release keystore for signing APKs.
# NEVER commit the keystore or passwords to version control.
#
# Usage:
#   ./generate-keystore.sh
#
# After generation, set these environment variables (e.g. in .env or CI secrets):
#   KEYSTORE_PASSWORD=<your-password>
#   KEYSTORE_ALIAS=erplibre
#   KEYSTORE_ALIAS_PASSWORD=<your-alias-password>
#
# References:
#   https://developer.android.com/studio/publish/app-signing
#   https://github.com/ionic-team/capacitor/issues/6794

set -euo pipefail

KEYSTORE_FILE="release.keystore"

if [ -f "$KEYSTORE_FILE" ]; then
    echo "ERROR: $KEYSTORE_FILE already exists. Remove it first if you want to regenerate."
    exit 1
fi

echo "Generating release keystore: $KEYSTORE_FILE"
echo "You will be prompted for passwords — use strong, unique passwords."
echo ""

keytool -genkey -v \
    -keystore "$KEYSTORE_FILE" \
    -alias erplibre \
    -keyalg RSA \
    -keysize 4096 \
    -validity 10000

echo ""
echo "Keystore generated: $KEYSTORE_FILE"
echo "IMPORTANT: Store passwords securely (password manager, CI secrets)."
echo "NEVER commit this file to git."