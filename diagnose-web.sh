#!/bin/bash
# Diagnose the running web app via Selenium DOM queries.
# Outputs compact JSON — Claude reads this instead of component source files.
#
# Usage:
#   ./diagnose-web.sh            # full diagnosis
#   ./diagnose-web.sh --route /notes
#   ./diagnose-web.sh --screenshot   # add screenshots to output

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="http://localhost:5173"
ROUTE=""
WITH_SCREENSHOT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --route)      ROUTE="$2"; shift 2 ;;
        --port)       BASE_URL="http://localhost:$2"; shift 2 ;;
        --screenshot) WITH_SCREENSHOT=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

cd "$SCRIPT_DIR"

if ! curl -sf "${BASE_URL}/" > /dev/null 2>&1; then
    echo '{"error":"Dev server not reachable. Run: ./run-web.sh"}'
    exit 1
fi

ROUTES_TO_CHECK=("/" "/notes" "/applications" "/servers" "/options")
if [ -n "$ROUTE" ]; then
    ROUTES_TO_CHECK=("$ROUTE")
fi

OUT_DIR="$SCRIPT_DIR/screenshots"
mkdir -p "$OUT_DIR"

TMP_SCRIPT=$(mktemp /tmp/diagnose-XXXXXX.mjs)
trap "rm -f $TMP_SCRIPT" EXIT

# Build JS array of routes
ROUTES_JS="["
for r in "${ROUTES_TO_CHECK[@]}"; do
    ROUTES_JS+="\"$r\","
done
ROUTES_JS="${ROUTES_JS%,}]"

cat > "$TMP_SCRIPT" <<EOF
import { Builder, By, until, logging } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { writeFileSync } from 'fs';

const ROUTES = ${ROUTES_JS};
const BASE = '${BASE_URL}';
const WITH_SCREENSHOT = ${WITH_SCREENSHOT};
const OUT_DIR = '${OUT_DIR}';

const options = new firefox.Options()
    .addArguments('--headless', '--width=390', '--height=844');

const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .build();

const report = { base: BASE, timestamp: new Date().toISOString(), routes: [] };

for (const route of ROUTES) {
    const result = { route, status: 'ok', errors: [], elements: {}, title: '' };
    try {
        await driver.get(BASE + route);
        await driver.sleep(2000);

        result.title = await driver.getTitle();

        // Collect JS console errors via window.onerror injection
        const jsErrors = await driver.executeScript(\`
            return window.__selenium_errors__ || [];
        \`);
        if (jsErrors.length) result.errors.push(...jsErrors);

        // Check key DOM elements present
        const checks = [
            ['#home-component',      'home'],
            ['#note-list-component', 'note_list'],
            ['#note-component',      'note'],
            ['#servers-component',   'servers'],
            ['#options-component',   'options'],
            ['#applications-component', 'applications'],
            ['.navbar',              'navbar'],
            ['.spinner, .loading',   'loading'],
            ['.error-message',       'error_visible'],
        ];
        for (const [sel, key] of checks) {
            const els = await driver.findElements(By.css(sel));
            if (els.length) result.elements[key] = true;
        }

        // Extract visible text of main headings (compact)
        const headings = await driver.findElements(By.css('h1, h2, [class*="title"]'));
        const headingTexts = [];
        for (const h of headings.slice(0, 3)) {
            const t = (await h.getText()).trim();
            if (t) headingTexts.push(t);
        }
        if (headingTexts.length) result.headings = headingTexts;

        // Check for Owl render errors
        const owlError = await driver.findElements(By.css('.o_error_dialog, [class*="owl-error"]'));
        if (owlError.length) {
            result.errors.push('Owl render error dialog visible');
            result.status = 'error';
        }

        if (result.errors.length) result.status = 'error';

        if (WITH_SCREENSHOT) {
            const safe = route.replace(/\//g, '_').replace(/^_/, '') || 'home';
            const path = \`\${OUT_DIR}/\${safe}.png\`;
            const data = await driver.takeScreenshot();
            writeFileSync(path, Buffer.from(data, 'base64'));
            result.screenshot = path;
        }
    } catch (e) {
        result.status = 'crash';
        result.errors.push(e.message.split('\\n')[0]);
    }
    report.routes.push(result);
}

await driver.quit();

// Summary line for quick reading
const ok = report.routes.filter(r => r.status === 'ok').length;
const err = report.routes.filter(r => r.status !== 'ok').length;
report.summary = \`\${ok} ok, \${err} errors\`;

console.log(JSON.stringify(report, null, 2));
process.exit(err > 0 ? 1 : 0);
EOF

node "$TMP_SCRIPT"
