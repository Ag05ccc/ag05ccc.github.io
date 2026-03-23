# CryptoTA - Trading Simulator

Live demo: **https://ag05ccc.github.io/**

A real-time trading simulator with 30 technical analysis strategies, built with React and Recharts. No real money involved - practice trading with virtual funds.

## Features

- **20 Assets** - Top 10 cryptocurrencies (BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, DOT, LINK) and top 10 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, JPM, V, WMT)
- **Real Starting Prices** - Fetches live prices from CoinGecko on load, then simulates realistic price movements
- **30 TA Strategies** - RSI, MACD, Bollinger Bands, EMA crossovers, Stochastic, ADX, VWAP, candlestick patterns (hammer, engulfing, shooting star), Fibonacci retracements, support/resistance breakouts, trailing stops, and more
- **Live Candlestick Charts** - 5-minute simulated candles with volume bars and indicator overlays
- **Automated Trading Engine** - Activate any combination of strategies and watch them execute trades automatically
- **Portfolio Tracking** - Real-time P&L, holdings, and full trade history

## Tech Stack

- React 18 (via CDN)
- Recharts (charting)
- Babel Standalone (in-browser JSX transpilation)
- No build step required - runs directly on GitHub Pages

## How to Use

1. Visit https://ag05ccc.github.io/
2. Browse crypto and stock assets in the left sidebar
3. Go to the **Strategies** tab to configure and activate trading strategies
4. Click **ACTIVATE ALL** to run all 30 strategies at once
5. Monitor trades in the **Orders** tab and portfolio in the **Portfolio** tab
