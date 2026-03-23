# CryptoTA - Trading Simulator

Live demo: **https://ag05ccc.github.io/**

A real-time trading simulator with 4 portfolio risk profiles racing against each other using 30 technical analysis strategies. $1M virtual capital per portfolio. No real money involved.

## Features

- **4 Portfolio Profiles Racing** - Conservative, Moderate, Aggressive, and YOLO strategies compete simultaneously
- **20 Assets** - Top 10 crypto (BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, DOT, LINK) + top 10 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, JPM, V, WMT)
- **Real Prices** - Live crypto prices from CoinGecko, refreshed every 30 seconds
- **30 TA Strategies** - RSI, MACD, Bollinger Bands, EMA crossovers, Stochastic, ADX, VWAP, candlestick patterns, Fibonacci, trailing stops, and more
- **Chart Timeframes** - 1m, 5m, 15m, 1h, 4h, 1D with timestamps
- **Live Comparison** - Performance chart + leaderboard showing which risk profile wins
- **$1M Starting Capital** per portfolio

## Two Modes

### 1. GitHub Pages (Client-Side)
Visit https://ag05ccc.github.io/ — each visitor runs their own independent simulation.

### 2. Self-Hosted Server (24/7 Shared)
Run on your PC for shared state visible to all visitors:

```bash
# Install Node.js (if not installed)
sudo apt-get update && sudo apt-get install -y nodejs npm

# Start
cd trading-sim
npm install
./start.sh

# Expose to internet
ngrok http 3000
```

Server fetches real prices every 30 seconds, runs trading engine continuously, and broadcasts to all connected clients via WebSocket.

## Tech Stack

- React 18, Recharts (charting), Babel Standalone
- Node.js + WebSocket (server mode)
- CoinGecko API (real crypto prices)
