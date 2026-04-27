#!/usr/bin/env bash
# Smoke test for the bundle pipeline + edit mode on a connected device/emulator.
#
# What it does (no manual taps required):
#   1. Sync + install the debug APK
#   2. Launch the app
#   3. Capture logcat for ~20 s (filtered to our package)
#   4. Pull the SQLite DB and dump editable_repos
#   5. Pull Cache/repos/ inventory
#
# Anything obvious that's broken (extraction failure, plugin error, migration
# crash) shows up in logcat. The deeper UI flow (clicking Edit, committing,
# baseline-mismatch banner) still has to be verified by hand against
# doc/bundle_extract_test_matrix.md.
#
# Usage:
#   ./scripts/smoke_test_emulator.sh [APP_ID]
#     APP_ID defaults to ca.erplibre.home (override if your launcher id differs)

set -euo pipefail

APP_ID="${1:-ca.erplibre.home}"
LOG_DIR="$(mktemp -d -t erplibre-smoke-XXXX)"

echo "==> Repo root: $(pwd)"
echo "==> App id:    ${APP_ID}"
echo "==> Logs at:   ${LOG_DIR}"

if ! command -v adb >/dev/null 2>&1; then
    echo "ERROR: adb not in PATH." >&2
    exit 1
fi

echo
echo "==> Devices:"
adb devices
DEVICE_COUNT="$(adb devices | grep -E "device$" -c || true)"
if [[ "${DEVICE_COUNT}" -eq 0 ]]; then
    echo "ERROR: no device/emulator connected." >&2
    exit 1
fi

echo
echo "==> 1/5  Building debug APK"
( cd android && ./gradlew :app:assembleDebug -q )

echo
echo "==> 2/5  Installing"
adb install -r android/app/build/outputs/apk/debug/app-debug.apk \
    | tail -n 5

echo
echo "==> 3/5  Launching"
adb shell am start -n "${APP_ID}/.MainActivity" >/dev/null

echo
echo "==> 4/5  Capturing logcat for 20 s"
adb logcat -c
( adb logcat \
    *:I "RepoExtractor:V" "RepoEdit:V" "BundleSource:V" \
    "Capacitor:V" "AndroidRuntime:E" "MigrationService:V" \
    > "${LOG_DIR}/logcat.txt" ) &
LOG_PID=$!
sleep 20
kill "${LOG_PID}" 2>/dev/null || true

echo
echo "==> 5/5  Inspecting on-device state"
DB_REL="databases/erplibre.db"
echo "(database extract is best-effort; the encrypted DB cannot be read off-device" \
     "without the SecureStorage key, but the file's existence + size confirm boot succeeded)"
adb shell "run-as ${APP_ID} ls -la ${DB_REL} 2>/dev/null" \
    > "${LOG_DIR}/db_stat.txt" || true
adb shell "run-as ${APP_ID} ls -la cache/repos 2>/dev/null" \
    > "${LOG_DIR}/cache_inventory.txt" || true

echo
echo "==> Done."
echo "    logcat:           ${LOG_DIR}/logcat.txt"
echo "    db stat:          ${LOG_DIR}/db_stat.txt"
echo "    cache inventory:  ${LOG_DIR}/cache_inventory.txt"
echo
echo "Quick checks:"
grep -E "ERROR|FATAL|crash|Migration v.* failed" "${LOG_DIR}/logcat.txt" \
    | head -n 20 || echo "(no obvious errors in logcat — good sign)"

echo
echo "For the full UI flow (Edit button, commit, reset, baseline drift),"
echo "follow doc/bundle_extract_test_matrix.md by hand."
