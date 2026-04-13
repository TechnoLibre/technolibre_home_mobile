#!/bin/bash
# Take a screenshot of the running web app using Selenium + Firefox (headless)
# Stack: Selenium WebDriver (Apache 2.0) + Firefox (MPL 2.0) + geckodriver (MPL 2.0)
# No Microsoft, no Google — W3C WebDriver standard.
#
# Prerequisites: run-web.sh must be running in another terminal first
#
# Usage:
#   ./screenshot-web.sh                        # screenshot / (home)
#   ./screenshot-web.sh --url /notes           # specific route
#   ./screenshot-web.sh --url / --out home.png # custom output file
#   ./screenshot-web.sh --install              # only install dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="http://localhost:5173"
ROUTE="/"
OUT_DIR="$SCRIPT_DIR/screenshots"
INSTALL_ONLY=false
WAIT_MS=2000

while [[ $# -gt 0 ]]; do
    case "$1" in
        --url)     ROUTE="$2";       shift 2 ;;
        --out)     CUSTOM_OUT="$2";  shift 2 ;;
        --port)    BASE_URL="http://localhost:$2"; shift 2 ;;
        --wait)    WAIT_MS="$2";     shift 2 ;;
        --install) INSTALL_ONLY=true; shift ;;
        --help|-h)
            echo "Usage: $0 [--url ROUTE] [--out FILE] [--port PORT] [--wait MS]"
            echo ""
            echo "  --url ROUTE    Route to screenshot (default: /)"
            echo "  --out FILE     Output PNG path (default: screenshots/<route>.png)"
            echo "  --port PORT    Dev server port (default: 5173)"
            echo "  --wait MS      Wait for JS render in ms (default: 2000)"
            echo "  --install      Only install dependencies, then exit"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

cd "$SCRIPT_DIR"

# --- Step 1: Firefox ---
if ! which firefox > /dev/null 2>&1; then
    echo "==> Installing Firefox (Mozilla MPL 2.0)..."
    # Ubuntu 24.04: firefox snap wrapper → real deb via PPA for headless use
    sudo add-apt-repository -y ppa:mozillateam/ppa
    echo 'Package: *
Pin: release o=LP-PPA-mozillateam
Pin-Priority: 1001' | sudo tee /etc/apt/preferences.d/mozilla-firefox > /dev/null
    sudo apt-get update -q
    sudo apt-get install -y firefox
    echo "    Firefox installed: $(firefox --version)"
fi

# --- Step 2: geckodriver (Mozilla MPL 2.0) ---
if ! which geckodriver > /dev/null 2>&1; then
    echo "==> Installing geckodriver (Mozilla MPL 2.0)..."
    GECKO_VER=$(curl -s https://api.github.com/repos/mozilla/geckodriver/releases/latest \
        | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
    GECKO_URL="https://github.com/mozilla/geckodriver/releases/download/v${GECKO_VER}/geckodriver-v${GECKO_VER}-linux64.tar.gz"
    curl -L "$GECKO_URL" | sudo tar -xz -C /usr/local/bin/
    sudo chmod +x /usr/local/bin/geckodriver
    echo "    geckodriver installed: $(geckodriver --version | head -1)"
fi

# --- Step 3: selenium-webdriver npm package (Apache 2.0) ---
if ! node -e "require('selenium-webdriver')" 2>/dev/null; then
    echo "==> Installing selenium-webdriver (Apache 2.0)..."
    npm install --save-dev selenium-webdriver
fi

$INSTALL_ONLY && { echo "All dependencies installed."; exit 0; }

# --- Check server is reachable ---
if ! curl -sf "${BASE_URL}/" > /dev/null 2>&1; then
    echo "ERROR: Dev server not reachable at ${BASE_URL}"
    echo "       Start it first with:  ./run-web.sh"
    exit 1
fi

# --- Build output path ---
SAFE_ROUTE=$(echo "$ROUTE" | sed 's|/|_|g; s|^_||; s|[^a-zA-Z0-9_-]|_|g')
SAFE_ROUTE="${SAFE_ROUTE:-home}"
mkdir -p "$OUT_DIR"
OUT_FILE="${CUSTOM_OUT:-$OUT_DIR/${SAFE_ROUTE}.png}"

echo "==> Screenshotting ${BASE_URL}${ROUTE} with Firefox headless + Selenium..."

# --- Write temp Selenium script ---
TMP_SCRIPT=$(mktemp /tmp/selenium-XXXXXX.mjs)
trap "rm -f $TMP_SCRIPT" EXIT

cat > "$TMP_SCRIPT" <<EOF
import { Builder, By, until, logging } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { writeFileSync } from 'fs';

const options = new firefox.Options()
    .addArguments('--headless')
    .addArguments('--width=390')
    .addArguments('--height=844');

const prefs = new logging.Preferences();
prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);

const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setLoggingPrefs(prefs)
    .build();

try {
    await driver.get('${BASE_URL}${ROUTE}');
    await driver.sleep(${WAIT_MS});

    const screenshot = await driver.takeScreenshot();
    writeFileSync('${OUT_FILE}', Buffer.from(screenshot, 'base64'));
    console.log('    Saved: ${OUT_FILE}');

    const logs = await driver.manage().logs().get(logging.Type.BROWSER);
    const errors = logs.filter(l => l.level.value >= logging.Level.SEVERE.value);
    if (errors.length > 0) {
        console.error('\\n==> JS errors detected:');
        errors.forEach(e => console.error('    ' + e.message));
        process.exit(1);
    } else {
        console.log('    No JS errors.');
    }
} finally {
    await driver.quit();
}
EOF

node "$TMP_SCRIPT"

echo ""
echo "==> Done. Pull to local machine:"
echo "    scp $(hostname):${OUT_FILE} ."
