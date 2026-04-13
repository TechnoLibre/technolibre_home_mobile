#!/bin/bash
# Start the Vite dev server for local web testing (no Android required)
# Capacitor native plugins are gracefully absent in browser mode
#
# Usage:
#   ./run-web.sh              # serve on localhost:5173 (default)
#   ./run-web.sh --host       # expose on 0.0.0.0 (accessible from other machines)
#   ./run-web.sh --port 8080  # custom port

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_FLAG=""
PORT="5173"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            HOST_FLAG="--host"
            shift
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--host] [--port PORT]"
            echo ""
            echo "  --host        Expose on 0.0.0.0 (LAN/remote access)"
            echo "  --port PORT   Port number (default: 5173)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"; exit 1 ;;
    esac
done

cd "$SCRIPT_DIR"

# Check node_modules
if [ ! -d node_modules ]; then
    echo "==> node_modules not found — running npm install..."
    npm install
fi

LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || echo "localhost")

echo "==> Starting ERPLibre Home web server..."
echo ""
if [ -n "$HOST_FLAG" ]; then
    echo "    Local:   http://localhost:${PORT}/"
    echo "    Network: http://${LOCAL_IP}:${PORT}/"
else
    echo "    URL: http://localhost:${PORT}/"
    echo "    Tip: use --host to expose on the network"
fi
echo ""
echo "    Note: Capacitor native plugins (SSH, Whisper, OCR, etc.) are"
echo "          unavailable in browser mode — UI and services are testable."
echo ""
echo "    To take a screenshot: ./screenshot-web.sh"
echo "    Press Ctrl+C to stop."
echo ""

npx vite --port "$PORT" $HOST_FLAG
