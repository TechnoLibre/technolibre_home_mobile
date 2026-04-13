#!/bin/bash
# Take a screenshot of the running web app using Playwright + Firefox (headless)
# Works on a Linux server with no display (DISPLAY not required)
#
# Prerequisites: run-web.sh must be running in another terminal first
#
# Usage:
#   ./screenshot-web.sh                        # screenshot / (home)
#   ./screenshot-web.sh --url /notes           # specific route
#   ./screenshot-web.sh --url / --out home.png # custom output file
#   ./screenshot-web.sh --install              # only install Playwright + Firefox

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="http://localhost:5173"
ROUTE="/"
OUT_DIR="$SCRIPT_DIR/screenshots"
BROWSER="firefox"
INSTALL_ONLY=false
WAIT_MS=2000

while [[ $# -gt 0 ]]; do
    case "$1" in
        --url)      ROUTE="$2";        shift 2 ;;
        --out)      CUSTOM_OUT="$2";   shift 2 ;;
        --port)     BASE_URL="http://localhost:$2"; shift 2 ;;
        --wait)     WAIT_MS="$2";      shift 2 ;;
        --chromium) BROWSER="chromium"; shift ;;
        --install)  INSTALL_ONLY=true;  shift ;;
        --help|-h)
            echo "Usage: $0 [--url ROUTE] [--out FILE] [--port PORT] [--wait MS] [--chromium]"
            echo ""
            echo "  --url ROUTE    Route to screenshot (default: /)"
            echo "  --out FILE     Output PNG path (default: screenshots/<route>.png)"
            echo "  --port PORT    Dev server port (default: 5173)"
            echo "  --wait MS      Wait for JS render in ms (default: 2000)"
            echo "  --chromium     Use Chromium instead of Firefox"
            echo "  --install      Only install Playwright browser, then exit"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

cd "$SCRIPT_DIR"

# --- Install Playwright as local devDep if needed ---
if ! node -e "require('playwright')" 2>/dev/null; then
    echo "==> Installing playwright locally..."
    npm install --save-dev playwright
fi

# --- Install browser binary if needed ---
PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
BROWSER_BIN_FOUND=false
[ -d "$PLAYWRIGHT_CACHE" ] && ls "$PLAYWRIGHT_CACHE/${BROWSER}-"* &>/dev/null && BROWSER_BIN_FOUND=true

if [ "$BROWSER_BIN_FOUND" = false ]; then
    echo "==> Installing Playwright ${BROWSER} binary (~300 MB, first time only)..."
    # System deps for headless Firefox on Ubuntu 24.04
    sudo apt-get install -y \
        libgtk-3-0 libdbus-glib-1-2 libxt6 \
        libasound2t64 2>/dev/null || \
    sudo apt-get install -y \
        libgtk-3-0 libdbus-glib-1-2 libxt6 \
        libasound2 2>/dev/null || true
    npx playwright install "$BROWSER"
    echo "    Done."
fi

$INSTALL_ONLY && { echo "Playwright $BROWSER ready."; exit 0; }

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

echo "==> Screenshotting ${BASE_URL}${ROUTE} with ${BROWSER} (headless)..."

# --- Write temp Playwright script ---
TMP_SCRIPT=$(mktemp /tmp/playwright-XXXXXX.mjs)
trap "rm -f $TMP_SCRIPT" EXIT

cat > "$TMP_SCRIPT" <<EOF
import { ${BROWSER^} } from 'playwright';

const errors = [];

const browser = await ${BROWSER^}.launch({ headless: true });
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
});
const page = await context.newPage();

page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));
page.on('console', m => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
});

await page.goto('${BASE_URL}${ROUTE}', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(${WAIT_MS});
await page.screenshot({ path: '${OUT_FILE}', fullPage: false });

await browser.close();

if (errors.length > 0) {
    console.error('\\n==> JS errors detected:');
    errors.forEach(e => console.error('    ' + e));
    process.exit(1);
} else {
    console.log('    No JS errors.');
}
EOF

node "$TMP_SCRIPT"

echo ""
echo "==> Screenshot saved: ${OUT_FILE}"
echo "    Pull it to your machine with:"
echo "    scp $(hostname):${OUT_FILE} ."
