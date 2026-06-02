#!/bin/bash
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$APP_DIR/tradesimbot.pid"
SERVER_PATH="$APP_DIR/server.js"

if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null
    fi
    rm -f "$PID_FILE"
fi

pkill -f "node .*${SERVER_PATH}" 2>/dev/null
pkill -f "cloudflared tunnel run trading-sim" 2>/dev/null
echo "TradeSimBot stopped."
