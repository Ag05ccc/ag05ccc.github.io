#!/bin/bash
pkill -f "node /home/gazi13/trading-sim/server.js" 2>/dev/null
pkill -f "cloudflared tunnel run trading-sim" 2>/dev/null
echo "TradeSimBot stopped."
