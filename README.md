# TradeSimBot - Trading Simulator

TradeSimBot is a real-time paper trading simulator with shared server state, live
market prices, technical-analysis signals, portfolio racing, and historical
backtesting. It does not place real orders and does not manage real money.

## Current Shape

- **5 portfolios:** Conservative, Moderate, Aggressive, YOLO, and KRAL Trend
  (`dma`).
- **41 assets:** 20 crypto assets, 20 stocks, and GOLD.
- **Starting capital:** `$100,000` by default. Override with `DEFAULT_CASH`.
- **Live prices:** Binance WebSocket for crypto, CoinGecko fallback, and
  TwelveData for stocks/GOLD when `TWELVEDATA_API_KEY` is set.
- **Shared state:** persisted to `state.json` with a rolling backup.
- **Backtesting:** available through the UI and `/api/backtest`, using historical
  data from `backtest/data`.

## Active Source Map

- `server.js` - Node.js HTTP/WebSocket server, live engine loop, API routes,
  persistence, price fetching, and backtest endpoint.
- `engine-core.js` - shared asset definitions, indicator functions, signals,
  profile definitions, regime detection, and signal scoring.
- `client.html` - active browser UI served by `server.js` at `/`.
- `backtest/backtest.js` - standalone CLI backtest runner.
- `backtest/basic-tests.js` - basic sanity tests that call the running server's
  `/api/backtest` endpoint.
- `backtest/collect_historical_data.js` - 1-minute Binance historical data
  collector.

Legacy/reference UI files currently kept in the repository:

- `index.html`
- `app.jsx`
- `trading-sim.jsx`

The server currently serves `client.html`; treat the legacy files as reference
material unless they are intentionally revived.

## Run Locally

```bash
npm install
./start.sh
```

Open:

```text
http://localhost:3000
```

The scripts resolve paths relative to their own directory, so they can be run
from any working directory.

## Stop

```bash
./stop.sh
```

## Optional Environment

Create `.env` in the project root when needed:

```env
PORT=3000
NODE_ENV=development
DEFAULT_CASH=100000
TICK_MS=2000
CANDLE_TICKS=30
COMMISSION_RATE=0.001
SLIPPAGE_PCT=0.0005
STATE_SAVE_INTERVAL=10000
TWELVEDATA_API_KEY=your_key_here
ADMIN_TOKEN=change_me
REQUIRE_ADMIN_TOKEN=0
BACKTEST_REQUIRES_ADMIN=1
BACKTEST_WORKER_ENABLED=1
BACKTEST_TIMEOUT_MS=600000
```

When `ADMIN_TOKEN` is not set, state-changing actions such as reset/config
updates are public in local/dev mode. For any internet-exposed instance, set
`ADMIN_TOKEN` and `REQUIRE_ADMIN_TOKEN=1`. `NODE_ENV=production` also makes
`ADMIN_TOKEN` mandatory.

When `ADMIN_TOKEN` is set, backtest POST requests are protected by default. Open
the UI with `?token=...` to run protected actions from the browser:

```text
http://localhost:3000/?token=change_me
```

## Backtesting

With the server running, use the UI Backtest tab or call:

```bash
node backtest/basic-tests.js
```

Data quality checks:

```bash
npm run test:data-quality
```

This checks daily historical CSVs for missing files, invalid OHLC rows,
duplicate dates, missing expected candles, and stale last-update dates. If the
server is running, it also reads `/api/data-quality` to report live feed
freshness for Binance/CoinGecko and TwelveData. Stale data is reported as a
warning; hard file anomalies fail the test.

Standalone CLI backtest:

```bash
node backtest/backtest.js
```

Historical data lives under `backtest/data`. The `backtest/data/1m` directory is
large and ignored by git.

`/api/backtest` runs in a short-lived child process by default
(`BACKTEST_WORKER_ENABLED=1`). This keeps the live price tick loop and WebSocket
updates responsive while heavy daily or 1-minute backtests run. Set
`BACKTEST_WORKER_ENABLED=0` only for debugging the inline fallback.

## Operations Notes

- `state.json`, `state.json.bak`, `logs/`, `.env`, and 1-minute historical data
  are ignored by git.
- `autostart.sh` starts `server.js` in the background and, if available, starts a
  `cloudflared tunnel run trading-sim` process.
- `/api/health` returns system health separately from portfolio risk state, so a
  stopped portfolio does not automatically mean the server itself is unhealthy.
- The project currently has no build pipeline; the active frontend is plain
  browser-loaded React/Babel inside `client.html`.
