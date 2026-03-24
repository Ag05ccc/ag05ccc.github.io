#!/bin/bash
sleep 10

pkill -f "node /home/gazi13/trading-sim/server.js" 2>/dev/null
pkill -f "cloudflared tunnel run trading-sim" 2>/dev/null
sleep 2

cd /home/gazi13/trading-sim
node server.js > /tmp/tradesimbot-server.log 2>&1 &
sleep 3
/home/gazi13/cloudflared tunnel run trading-sim > /tmp/tradesimbot-tunnel.log 2>&1 &

echo "TradeSimBot started."
