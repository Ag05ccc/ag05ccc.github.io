#!/bin/bash
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$APP_DIR/tradesimbot.pid"
CLOUDFLARED_BIN="$(command -v cloudflared || true)"

if [ -z "$CLOUDFLARED_BIN" ] && [ -x "$HOME/cloudflared" ]; then
    CLOUDFLARED_BIN="$HOME/cloudflared"
fi

sleep 10

if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE")"
    if [ -n "$OLD_PID" ]; then
        kill "$OLD_PID" 2>/dev/null
    fi
    rm -f "$PID_FILE"
fi

pkill -f "node .*${APP_DIR}/server.js" 2>/dev/null
pkill -f "cloudflared tunnel run trading-sim" 2>/dev/null
sleep 2

cd "$APP_DIR" || exit 1
node "$APP_DIR/server.js" > /tmp/tradesimbot-server.log 2>&1 &
echo "$!" > "$PID_FILE"
sleep 3

if [ -n "$CLOUDFLARED_BIN" ]; then
    "$CLOUDFLARED_BIN" tunnel run trading-sim > /tmp/tradesimbot-tunnel.log 2>&1 &
else
    echo "cloudflared not found; tunnel was not started." > /tmp/tradesimbot-tunnel.log
fi

echo "TradeSimBot started."
