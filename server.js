const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');

// Load .env file
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, v] = line.split('=');
    if (k && v) process.env[k.trim()] = v.trim();
  });
}

const PORT = 3000;
const TICK_MS = 2000;
const CANDLE_TICKS = 30; // 30 ticks x 2s = 60 seconds = 1 minute candles
const PRICE_FETCH_INTERVAL = 30000;
const DEFAULT_CASH = 100000;
const COMMISSION_RATE = 0.001; // 0.1% commission per trade
const SLIPPAGE_PCT = 0.0005; // 0.05% default slippage
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || '';
const TWELVEDATA_INTERVAL = 600000; // 1 batch every 10 minutes (~600 credits/day, under 800 limit)
// Cooldown per profile (ms) - increased based on backtest (1h data = all negative)
// Fewer trades = less commission drag = better returns
// Cooldowns very high — commission was killing all returns
// Daily candle backtest = 1 bar = 1 day, so cooldownBars matter more than ms for backtest
const COOLDOWNS = {
  conservative: 3600000, // 60 minutes (live)
  moderate: 1800000,     // 30 minutes
  aggressive: 900000,    // 15 minutes
  yolo: 600000,          // 10 minutes
};
const STATE_FILE = path.resolve(__dirname, 'state.json');
const STATE_SAVE_INTERVAL = 10000; // Save state every 10 seconds

// ─── ASSET DEFINITIONS ───
const COINS = {
  // Crypto (20) - real-time via Binance WebSocket + CoinGecko fallback
  BTC: { name: "Bitcoin", cgId: "bitcoin", type: "crypto" },
  ETH: { name: "Ethereum", cgId: "ethereum", type: "crypto" },
  SOL: { name: "Solana", cgId: "solana", type: "crypto" },
  BNB: { name: "BNB", cgId: "binancecoin", type: "crypto" },
  XRP: { name: "Ripple", cgId: "ripple", type: "crypto" },
  ADA: { name: "Cardano", cgId: "cardano", type: "crypto" },
  AVAX: { name: "Avalanche", cgId: "avalanche-2", type: "crypto" },
  DOGE: { name: "Dogecoin", cgId: "dogecoin", type: "crypto" },
  DOT: { name: "Polkadot", cgId: "polkadot", type: "crypto" },
  LINK: { name: "Chainlink", cgId: "chainlink", type: "crypto" },
  MATIC: { name: "Polygon", cgId: "matic-network", type: "crypto" },
  UNI: { name: "Uniswap", cgId: "uniswap", type: "crypto" },
  ATOM: { name: "Cosmos", cgId: "cosmos", type: "crypto" },
  LTC: { name: "Litecoin", cgId: "litecoin", type: "crypto" },
  NEAR: { name: "NEAR", cgId: "near", type: "crypto" },
  APT: { name: "Aptos", cgId: "aptos", type: "crypto" },
  ARB: { name: "Arbitrum", cgId: "arbitrum", type: "crypto" },
  OP: { name: "Optimism", cgId: "optimism", type: "crypto" },
  SUI: { name: "Sui", cgId: "sui", type: "crypto" },
  FIL: { name: "Filecoin", cgId: "filecoin", type: "crypto" },
  // Commodity - real-time via Twelve Data (XAU/USD)
  GOLD: { name: "Gold", type: "commodity", tdSymbol: "XAU/USD" },
  // Stocks (20) - real-time via Twelve Data API
  AAPL: { name: "Apple", type: "stock", tdSymbol: "AAPL" },
  MSFT: { name: "Microsoft", type: "stock", tdSymbol: "MSFT" },
  GOOGL: { name: "Alphabet", type: "stock", tdSymbol: "GOOGL" },
  AMZN: { name: "Amazon", type: "stock", tdSymbol: "AMZN" },
  NVDA: { name: "NVIDIA", type: "stock", tdSymbol: "NVDA" },
  META: { name: "Meta", type: "stock", tdSymbol: "META" },
  TSLA: { name: "Tesla", type: "stock", tdSymbol: "TSLA" },
  JPM: { name: "JPMorgan", type: "stock", tdSymbol: "JPM" },
  V: { name: "Visa", type: "stock", tdSymbol: "V" },
  WMT: { name: "Walmart", type: "stock", tdSymbol: "WMT" },
  NFLX: { name: "Netflix", type: "stock", tdSymbol: "NFLX" },
  AMD: { name: "AMD", type: "stock", tdSymbol: "AMD" },
  CRM: { name: "Salesforce", type: "stock", tdSymbol: "CRM" },
  ORCL: { name: "Oracle", type: "stock", tdSymbol: "ORCL" },
  INTC: { name: "Intel", type: "stock", tdSymbol: "INTC" },
  DIS: { name: "Disney", type: "stock", tdSymbol: "DIS" },
  BA: { name: "Boeing", type: "stock", tdSymbol: "BA" },
  PYPL: { name: "PayPal", type: "stock", tdSymbol: "PYPL" },
  UBER: { name: "Uber", type: "stock", tdSymbol: "UBER" },
  COIN: { name: "Coinbase", type: "stock", tdSymbol: "COIN" },
};

// ─── TA FUNCTIONS ───
function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}
function emaArray(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const res = [];
  let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  res.push(e);
  for (let i = period; i < data.length; i++) { e = data[i] * k + e * (1 - k); res.push(e); }
  return res;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const e12 = emaArray(closes, 12);
  const e26 = emaArray(closes, 26);
  const minLen = Math.min(e12.length, e26.length);
  const macdLine = [];
  for (let i = 0; i < minLen; i++) macdLine.push(e12[e12.length - minLen + i] - e26[e26.length - minLen + i]);
  const signal = macdLine.length >= 9 ? ema(macdLine, 9) : 0;
  const macd = macdLine[macdLine.length - 1] || 0;
  return { macd, signal, hist: macd - signal };
}
function calcBB(closes, period = 20) {
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + 2 * std, mid, lower: mid - 2 * std };
}
function calcStoch(highs, lows, closes, period = 14) {
  if (closes.length < period) return { k: 50, d: 50 };
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  const k = h === l ? 50 : ((closes[closes.length - 1] - l) / (h - l)) * 100;
  return { k, d: k };
}
function calcADX(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return 20;
  let sumDX = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const dm = highs[i] - highs[i - 1] > lows[i - 1] - lows[i] ? Math.max(highs[i] - highs[i - 1], 0) : 0;
    sumDX += tr > 0 ? (dm / tr) * 100 : 0;
  }
  return sumDX / period;
}

// ─── SIGNAL DEFINITIONS ───
// Each signal evaluates to a label (truthy) or null (no signal)
// Signals are scored: buy signals = +1, sell signals = -1
// Trade executes when net score meets profile threshold
// Weights optimized via backtest on 20 cryptos (2017-2026)
// Key changes: Breakout reduced (was over-dominant), sell signals boosted,
// EMA50 bounce requires confirmation (handled in evalSignal)
const SIGNALS = [
  // Buy signals - weights calibrated by backtest win contribution
  { id: "rsi_ob", label: "RSI Oversold", side: "buy", category: "mean-reversion", weight: 1.0 },
  { id: "macd_cross_b", label: "MACD Cross Buy", side: "buy", category: "trend", weight: 1.5 },
  { id: "bb_lower", label: "BB Lower", side: "buy", category: "mean-reversion", weight: 1.0 },
  { id: "ema_golden", label: "Golden Cross", side: "buy", category: "trend", weight: 2.0 },
  { id: "ema50_bounce", label: "EMA50 Bounce", side: "buy", category: "trend", weight: 0.5 },  // Reduced: over-triggered in 1min
  { id: "stoch_ob", label: "Stoch Oversold", side: "buy", category: "mean-reversion", weight: 0.8 },
  { id: "vol_spike_b", label: "Vol Spike Buy", side: "buy", category: "momentum", weight: 1.2 },
  { id: "hammer", label: "Hammer", side: "buy", category: "pattern", weight: 0.8 },  // Reduced: too frequent
  { id: "engulf_b", label: "Bull Engulfing", side: "buy", category: "pattern", weight: 1.5 },
  { id: "vwap_buy", label: "Below VWAP", side: "buy", category: "neutral", weight: 0.5 },  // Neutral: VWAP is reference, not mean-reversion
  { id: "adx_trend_b", label: "ADX Trend Buy", side: "buy", category: "trend", weight: 1.0 },
  { id: "fib_buy", label: "Fib 61.8%", side: "buy", category: "mean-reversion", weight: 0.8 },
  { id: "dip_rsi_macd", label: "RSI+MACD Buy", side: "buy", category: "combo", weight: 2.5 },  // Best combo signal
  { id: "breakout_high", label: "Breakout", side: "buy", category: "momentum", weight: 0.8 },  // Reduced from 1.5: was 3713 trades
  { id: "ema200_trend", label: "EMA200 Trend", side: "buy", category: "trend", weight: 1.5 },
  // Sell signals - weights boosted to fix buy/sell imbalance
  { id: "rsi_os", label: "RSI Overbought", side: "sell", category: "mean-reversion", weight: 1.2 },
  { id: "macd_cross_s", label: "MACD Cross Sell", side: "sell", category: "trend", weight: 1.8 },  // Boosted
  { id: "bb_upper", label: "BB Upper", side: "sell", category: "mean-reversion", weight: 1.2 },
  { id: "ema_death", label: "Death Cross", side: "sell", category: "trend", weight: 2.5 },  // Boosted
  { id: "stoch_os", label: "Stoch Overbought", side: "sell", category: "mean-reversion", weight: 1.2 },
  { id: "vol_spike_s", label: "Vol Spike Sell", side: "sell", category: "momentum", weight: 1.5 },  // Boosted
  { id: "shooting_star", label: "Shooting Star", side: "sell", category: "pattern", weight: 1.2 },
  { id: "engulf_s", label: "Bear Engulfing", side: "sell", category: "pattern", weight: 2.0 },  // Boosted
  { id: "vwap_sell", label: "Above VWAP", side: "sell", category: "neutral", weight: 0.8 },  // Neutral: VWAP is reference
  { id: "dip_rsi_macd_s", label: "RSI+MACD Sell", side: "sell", category: "combo", weight: 2.5 },
  { id: "breakdown", label: "Breakdown", side: "sell", category: "momentum", weight: 1.8 },  // Boosted
  { id: "ema200_break", label: "EMA200 Break", side: "sell", category: "trend", weight: 1.5 },
  // Risk management (always independent - bypass scoring)
  { id: "tp_pct", label: "Take Profit", side: "sell", category: "risk", weight: 0 },
  { id: "sl_pct", label: "Stop Loss", side: "sell", category: "risk", weight: 0 },
  { id: "trailing", label: "Trailing Stop", side: "sell", category: "risk", weight: 0 },
];

// For backward compat with old code
var STRATS = SIGNALS;

// ─── MARKET REGIME DETECTION ───
// trending: ADX > 25, good for crossover/breakout
// ranging: ADX < 20, good for mean-reversion (RSI, BB)
// volatile: high stddev, reduce position sizes
function detectRegime(sd) {
  if (!sd || sd.candles.length < 20) return { type: 'warming up', adx: 20, volatility: 0 };
  var adx = sd.adx || 20;
  // Calculate recent volatility (stddev of last 20 closes / mean)
  var closes = sd.candles.slice(-20).map(function(c) { return c.c; });
  var mean = closes.reduce(function(a, b) { return a + b; }, 0) / closes.length;
  var stddev = Math.sqrt(closes.reduce(function(a, b) { return a + Math.pow(b - mean, 2); }, 0) / closes.length);
  var volPct = mean > 0 ? (stddev / mean) * 100 : 0;

  var type = 'mixed';
  if (adx >= 25) type = 'trending';
  else if (adx <= 18) type = 'ranging';

  return { type: type, adx: adx, volatility: volPct };
}

// ─── SIGNAL EVALUATOR ───
// Returns label string if signal fires, null otherwise
function evalSignal(sigId, val, sd, pos, peakPrice) {
  if (!sd || sd.candles.length < 5) return null;
  var candles = sd.candles;
  var lastCandle = candles[candles.length - 1];
  var prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  switch (sigId) {
    case "rsi_ob": if (sd.rsi <= val) return 'RSI ' + sd.rsi.toFixed(0); break;
    case "rsi_os": if (pos && pos.qty > 0 && sd.rsi >= val) return 'RSI ' + sd.rsi.toFixed(0); break;
    case "macd_cross_b": if (sd.macd.hist > 0 && sd.prevMacdHist <= 0) return 'MACD↑'; break;
    case "macd_cross_s": if (pos && pos.qty > 0 && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return 'MACD↓'; break;
    case "bb_lower": if (sd.bb.lower > 0 && sd.cur <= sd.bb.lower * (1 - val / 100)) return 'BB lower'; break;
    case "bb_upper": if (pos && pos.qty > 0 && sd.bb.upper > 0 && sd.cur >= sd.bb.upper * (1 + val / 100)) return 'BB upper'; break;
    case "ema_golden": if (sd.ema9 > sd.ema21 && candles.length > 21) { var prevE9 = ema(candles.slice(0, -1).map(function(c){return c.c;}), 9); if (prevE9 && prevE9 <= sd.ema21) return 'Golden cross'; } break;
    case "ema_death": if (pos && pos.qty > 0 && sd.ema9 < sd.ema21 && candles.length > 21) { var prevE9b = ema(candles.slice(0, -1).map(function(c){return c.c;}), 9); if (prevE9b && prevE9b >= sd.ema21) return 'Death cross'; } break;
    case "ema50_bounce": if (sd.ema50 > 0 && prevCandle) { var dist = ((sd.cur - sd.ema50) / sd.ema50) * 100; if (dist >= 0 && dist <= val && lastCandle.c > lastCandle.o && prevCandle.c < prevCandle.o) return 'EMA50 bounce'; } break;
    case "stoch_ob": if (sd.stoch.k <= val) return 'Stoch K=' + sd.stoch.k.toFixed(0); break;
    case "stoch_os": if (pos && pos.qty > 0 && sd.stoch.k >= val) return 'Stoch K=' + sd.stoch.k.toFixed(0); break;
    case "vol_spike_b": if (candles.length >= 10) { var avgV = candles.slice(-10).reduce(function(a,c2){return a+c2.v;},0)/10; if (lastCandle.v > avgV * val && lastCandle.c > lastCandle.o) return 'Vol ' + (lastCandle.v/avgV).toFixed(1) + 'x'; } break;
    case "vol_spike_s": if (pos && pos.qty > 0 && candles.length >= 10) { var avgV2 = candles.slice(-10).reduce(function(a,c2){return a+c2.v;},0)/10; if (lastCandle.v > avgV2 * val && lastCandle.c < lastCandle.o) return 'Vol sell'; } break;
    case "hammer": if (prevCandle && lastCandle) { var body = Math.abs(lastCandle.c - lastCandle.o); var lw = Math.min(lastCandle.o, lastCandle.c) - lastCandle.l; if (lw > body * 2 && lastCandle.c > lastCandle.o) return 'Hammer'; } break;
    case "shooting_star": if (pos && pos.qty > 0 && lastCandle) { var body2 = Math.abs(lastCandle.c - lastCandle.o); var uw = lastCandle.h - Math.max(lastCandle.o, lastCandle.c); if (uw > body2 * 2 && lastCandle.c < lastCandle.o) return 'Shooting star'; } break;
    case "engulf_b": if (prevCandle && lastCandle && prevCandle.c < prevCandle.o && lastCandle.c > lastCandle.o && lastCandle.c > prevCandle.o && lastCandle.o < prevCandle.c) return 'Bull engulf'; break;
    case "engulf_s": if (pos && pos.qty > 0 && prevCandle && lastCandle && prevCandle.c > prevCandle.o && lastCandle.c < lastCandle.o && lastCandle.c < prevCandle.o && lastCandle.o > prevCandle.c) return 'Bear engulf'; break;
    case "vwap_buy": if (sd.vwap > 0) { var vd = ((sd.vwap - sd.cur) / sd.vwap) * 100; if (vd >= val) return 'Below VWAP'; } break;
    case "vwap_sell": if (pos && pos.qty > 0 && sd.vwap > 0) { var vd2 = ((sd.cur - sd.vwap) / sd.vwap) * 100; if (vd2 >= val) return 'Above VWAP'; } break;
    case "adx_trend_b": if (sd.adx >= val && sd.cur > sd.ema21) return 'ADX ' + sd.adx.toFixed(0); break;
    case "fib_buy": if (candles.length >= 20) { var hi = Math.max.apply(null, candles.slice(-20).map(function(c2){return c2.h;})); var lo = Math.min.apply(null, candles.slice(-20).map(function(c2){return c2.l;})); var fib = hi - (hi - lo) * val; if (sd.cur <= fib && sd.cur > lo) return 'Fib'; } break;
    case "dip_rsi_macd": if (sd.rsi < val && sd.macd.hist > 0 && sd.prevMacdHist <= 0) return 'RSI+MACD↑'; break;
    case "dip_rsi_macd_s": if (pos && pos.qty > 0 && sd.rsi > val && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return 'RSI+MACD↓'; break;
    case "breakout_high": { var n = Math.floor(val); if (candles.length >= n) { var bhi = Math.max.apply(null, candles.slice(-n - 1, -1).map(function(c2){return c2.h;})); if (sd.cur > bhi) return 'Breakout'; } break; }
    case "breakdown": if (pos && pos.qty > 0 && candles.length >= Math.floor(val)) { var blo = Math.min.apply(null, candles.slice(-Math.floor(val) - 1, -1).map(function(c2){return c2.l;})); if (sd.cur < blo) return 'Breakdown'; } break;
    case "tp_pct": if (pos && pos.qty > 0) {
      var pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100;
      // Dynamic TP: in trending market, let profits run (3x TP target)
      // In ranging market, take profits early (1x TP target)
      var tpMult = 1.0;
      if (sd.adx >= 25) tpMult = 3.0;  // trending: 3x TP (e.g., 2% -> 6%)
      else if (sd.adx >= 18) tpMult = 2.0; // mixed: 2x TP
      // else ranging: 1x TP (original value)
      if (pl >= val * tpMult) return 'TP +' + pl.toFixed(1) + '%';
    } break;
    case "sl_pct": if (pos && pos.qty > 0) { var pl2 = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl2 <= -val) return 'SL ' + pl2.toFixed(1) + '%'; } break;
    case "trailing": if (pos && pos.qty > 0 && peakPrice) { var dr = ((peakPrice - sd.cur) / peakPrice) * 100; if (dr >= val) return 'Trail -' + dr.toFixed(1) + '%'; } break;
    case "ema200_trend": if (sd.ema200 > 0 && sd.cur > sd.ema200 && candles.length > 200) { var pc = (candles[candles.length - 2] || {}).c; if (pc && pc <= sd.ema200) return 'Above EMA200'; } break;
    case "ema200_break": if (pos && pos.qty > 0 && sd.ema200 > 0 && sd.cur < sd.ema200 && candles.length > 200) { var pc2 = (candles[candles.length - 2] || {}).c; if (pc2 && pc2 >= sd.ema200) return 'Below EMA200'; } break;
  }
  return null;
}

// ─── PORTFOLIO PROFILES ───
// buyThreshold: minimum weighted score to trigger buy (higher = more confirmation needed)
// sellThreshold: minimum weighted score to trigger sell
// cashPct: % of available cash per trade
// Risk signals (TP/SL/Trailing) always execute immediately (bypass scoring)
// Profiles optimized via backtest on 20 cryptos (2017-2026)
// Key changes: sell thresholds lowered (was 1.0 everywhere - too high for sells to fire),
// TP/SL recalibrated for commission-adjusted R:R, cooldowns increased
// OPTIMIZED v3: Dynamic TP, loose trailing (let trends run), fewer trades
// Previous issue: TP too tight (2-5%) + too many trades = commission kills returns
// Fix: TP 5-15% base (3x in trends), trailing 3-8%, higher buy thresholds
var PROFILES = [
  { id: "conservative", name: "Conservative", color: "#3b82f6", icon: "🛡️",
    desc: "Few high-conviction trades, tight risk control",
    assets: Object.keys(COINS), cashPct: 0.15, buyThreshold: 4.5, sellThreshold: 1.0,
    overrides: {
      rsi_ob: 22, rsi_os: 78, stoch_ob: 15, stoch_os: 85,
      tp_pct: 5.0, sl_pct: 2.0, trailing: 3.0,  // Wide trailing lets trends run
      bb_lower: 0.05, bb_upper: 0.02, vol_spike_b: 2.5, vol_spike_s: 1.5,
      breakout_high: 25, breakdown: 15, dip_rsi_macd: 28, dip_rsi_macd_s: 72,
      vwap_sell: 0.03, vwap_buy: 0.05,
      slippage: 0.0003,
    } },
  { id: "moderate", name: "Moderate", color: "#22c55e", icon: "⚖️",
    desc: "Balanced approach, trend-following bias",
    assets: Object.keys(COINS), cashPct: 0.20, buyThreshold: 4.0, sellThreshold: 1.0,
    overrides: {
      rsi_ob: 28, rsi_os: 72, stoch_ob: 20, stoch_os: 80,
      tp_pct: 8.0, sl_pct: 3.0, trailing: 4.0,  // Let winners run longer
      bb_lower: 0.08, bb_upper: 0.05, vol_spike_b: 2.0, vol_spike_s: 1.2,
      breakout_high: 18, breakdown: 10, dip_rsi_macd: 32, dip_rsi_macd_s: 68,
      vwap_sell: 0.05, vwap_buy: 0.08,
      slippage: 0.0005,
    } },
  { id: "aggressive", name: "Aggressive", color: "#f59e0b", icon: "🔥",
    desc: "Trend-following, wider stops, bigger moves",
    assets: Object.keys(COINS), cashPct: 0.25, buyThreshold: 3.5, sellThreshold: 1.0,
    overrides: {
      rsi_ob: 32, rsi_os: 68, stoch_ob: 25, stoch_os: 75,
      tp_pct: 12.0, sl_pct: 4.0, trailing: 5.0,  // Catch big moves
      bb_lower: 0.15, bb_upper: 0.1, vol_spike_b: 1.5, vol_spike_s: 1.0,
      breakout_high: 12, breakdown: 8, dip_rsi_macd: 38, dip_rsi_macd_s: 62,
      ema50_bounce: 0.5, vwap_buy: 0.1, vwap_sell: 0.08, adx_trend_b: 22,
      slippage: 0.0007,
    } },
  { id: "yolo", name: "YOLO", color: "#ef4444", icon: "🚀",
    desc: "Maximum trend capture, high volatility tolerance",
    assets: Object.keys(COINS), cashPct: 0.30, buyThreshold: 3.0, sellThreshold: 0.8,
    overrides: {
      rsi_ob: 38, rsi_os: 62, stoch_ob: 30, stoch_os: 70,
      tp_pct: 15.0, sl_pct: 5.0, trailing: 8.0,  // Very wide: catch full trends
      bb_lower: 0.3, bb_upper: 0.15, vol_spike_b: 1.2, vol_spike_s: 0.8,
      breakout_high: 8, breakdown: 5, dip_rsi_macd: 42, dip_rsi_macd_s: 58,
      ema50_bounce: 1.0, vwap_buy: 0.05, vwap_sell: 0.03, adx_trend_b: 18,
      slippage: 0.001,
    } },
];

// ─── SERVER STATE ───
let marketData = {};  // { BTC: { cur, candles, building, rsi, macd, ... }, ... }
let portfolios = [];
let tickCount = 0;
let lastPrices = {}; // last fetched real prices

// Initialize market data
Object.entries(COINS).forEach(([sym, c]) => {
  const price = c.price || 0;
  marketData[sym] = {
    cur: price, candles: [],
    building: { o: price, h: price, l: price, c: price, v: 0, tickCount: 0 },
    rsi: 50, macd: { macd: 0, signal: 0, hist: 0 }, bb: { upper: 0, mid: 0, lower: 0 },
    ema9: 0, ema21: 0, ema50: 0, ema200: 0,
    stoch: { k: 50, d: 50 }, adx: 20, vwap: price, prevMacdHist: 0,
  };
  lastPrices[sym] = price;
});

// Initialize portfolios
function buildStrategies(profile) {
  const strats = [];
  STRATS.forEach(st => {
    profile.assets.forEach(sym => {
      const val = profile.overrides[st.id] !== undefined ? profile.overrides[st.id] : 30;
      strats.push({ id: `${profile.id}_${st.id}_${sym}`, type: st.id, symbol: sym, value: val, cashPct: profile.cashPct, active: true });
    });
  });
  return strats;
}

portfolios = PROFILES.map(p => ({
  id: p.id, name: p.name, color: p.color, icon: p.icon, desc: p.desc,
  cash: DEFAULT_CASH, startCash: DEFAULT_CASH, holdings: {}, orders: [],
  actives: buildStrategies(p), peaks: {},
  history: [{ t: 0, value: DEFAULT_CASH }],
  tradeCount: 0, wins: 0, losses: 0,
}));

// ─── DMA TREND FOLLOWER PORTFOLIO (independent module) ───
portfolios.push({
  id: 'dma', name: 'KRAL Trend', color: '#8b5cf6', icon: '\u{1F451}', desc: 'BTC only - EMA200 band strategy: buy at -1%/-2%, sell at +1%/+2%',
  cash: DEFAULT_CASH, startCash: DEFAULT_CASH, holdings: {}, orders: [],
  actives: [], peaks: {},
  history: [{ t: 0, value: DEFAULT_CASH }],
  tradeCount: 0, wins: 0, losses: 0, totalCommission: 0,
});

// ─── STATE PERSISTENCE ───
function saveState() {
  try {
    var savedMarket = {};
    Object.keys(marketData).forEach(function(sym) {
      var sd = marketData[sym];
      savedMarket[sym] = {
        candles: sd.candles.slice(-200), cur: sd.cur,
        rsi: sd.rsi, macd: sd.macd, bb: sd.bb,
        ema9: sd.ema9, ema21: sd.ema21, ema50: sd.ema50, ema200: sd.ema200,
        stoch: sd.stoch, adx: sd.adx, vwap: sd.vwap, prevMacdHist: sd.prevMacdHist,
      };
    });
    var state = {
      portfolios: portfolios.map(function(pf) {
        return {
          id: pf.id, cash: pf.cash, startCash: pf.startCash,
          holdings: pf.holdings, orders: pf.orders.slice(0, 100),
          peaks: pf.peaks, history: pf.history.slice(-500),
          tradeCount: pf.tradeCount, wins: pf.wins, losses: pf.losses,
          totalCommission: pf.totalCommission || 0,
        };
      }),
      marketData: savedMarket,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log('[' + new Date().toLocaleTimeString() + '] State saved (' + Object.keys(savedMarket).length + ' assets, ' + portfolios.length + ' portfolios)');
  } catch (e) {
    console.log('Failed to save state:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    if (!state.portfolios || !state.marketData) return false;

    // Restore portfolios
    state.portfolios.forEach(saved => {
      const pf = portfolios.find(p => p.id === saved.id);
      if (!pf) return;
      pf.cash = saved.cash;
      pf.startCash = saved.startCash;
      pf.holdings = saved.holdings || {};
      // Backward compat: ensure all holdings have lots array
      Object.keys(pf.holdings).forEach(function(sym) {
        var h = pf.holdings[sym];
        if (h && h.qty > 0 && !h.lots) {
          h.lots = [{ qty: h.qty, cost: h.avgCost, date: new Date().toISOString() }];
        }
      });
      pf.orders = saved.orders || [];
      pf.peaks = saved.peaks || {};
      pf.history = saved.history || [{ t: 0, value: DEFAULT_CASH }];
      pf.tradeCount = saved.tradeCount || 0;
      pf.wins = saved.wins || 0;
      pf.losses = saved.losses || 0;
      pf.totalCommission = saved.totalCommission || 0;
    });

    // Restore market data (candles + indicators)
    Object.entries(state.marketData).forEach(([sym, saved]) => {
      if (!marketData[sym]) return;
      marketData[sym].candles = saved.candles || [];
      marketData[sym].cur = saved.cur || marketData[sym].cur;
      marketData[sym].rsi = saved.rsi || 50;
      marketData[sym].macd = saved.macd || { macd: 0, signal: 0, hist: 0 };
      marketData[sym].bb = saved.bb || { upper: 0, mid: 0, lower: 0 };
      marketData[sym].ema9 = saved.ema9 || 0;
      marketData[sym].ema21 = saved.ema21 || 0;
      marketData[sym].ema50 = saved.ema50 || 0;
      marketData[sym].ema200 = saved.ema200 || 0;
      marketData[sym].stoch = saved.stoch || { k: 50, d: 50 };
      marketData[sym].adx = saved.adx || 20;
      marketData[sym].vwap = saved.vwap || saved.cur || 0;
      marketData[sym].prevMacdHist = saved.prevMacdHist || 0;
    });

    console.log('[' + new Date().toLocaleTimeString() + '] Restored state from ' + state.savedAt);
    state.portfolios.forEach(p => {
      const hVal = Object.entries(p.holdings).reduce((s, [sym, h]) => s + ((h && h.qty) || 0) * (lastPrices[sym] || (marketData[sym] && marketData[sym].cur) || 0), 0);
      console.log('  ' + p.id + ': $' + (p.cash + hVal).toFixed(0) + ' (' + p.tradeCount + ' trades)');
    });
    return true;
  } catch (e) {
    console.log('Failed to load state:', e.message);
    return false;
  }
}

// ─── FETCH REAL PRICES ───
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TradeSimBot/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── BINANCE WEBSOCKET (real-time crypto) ───
const BINANCE_SYMBOLS = {
  BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt', BNB: 'bnbusdt',
  XRP: 'xrpusdt', ADA: 'adausdt', AVAX: 'avaxusdt', DOGE: 'dogeusdt',
  DOT: 'dotusdt', LINK: 'linkusdt', MATIC: 'maticusdt', UNI: 'uniusdt',
  ATOM: 'atomusdt', LTC: 'ltcusdt', NEAR: 'nearusdt', APT: 'aptusdt',
  ARB: 'arbusdt', OP: 'opusdt', SUI: 'suiusdt', FIL: 'filusdt',
};

let binanceWs = null;
let binanceReconnectTimer = null;

function connectBinance() {
  const streams = Object.values(BINANCE_SYMBOLS).map(s => s + '@trade').join('/');
  const url = 'wss://stream.binance.com:9443/ws/' + streams;

  try {
    binanceWs = new WebSocket(url);
  } catch(e) {
    console.log('Binance WS create failed:', e.message);
    scheduleBinanceReconnect();
    return;
  }

  binanceWs.on('open', () => {
    console.log('[' + new Date().toLocaleTimeString() + '] Binance WebSocket connected - real-time crypto prices active');
  });

  binanceWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.e === 'trade' && msg.s && msg.p) {
        const symbol = msg.s.toUpperCase(); // e.g. "BTCUSDT"
        // Find our symbol key
        for (var sym in BINANCE_SYMBOLS) {
          if (BINANCE_SYMBOLS[sym] === symbol.toLowerCase()) {
            lastPrices[sym] = parseFloat(msg.p);
            // Track real volume
            if (marketData[sym] && msg.q) {
              marketData[sym].building.v += parseFloat(msg.q);
            }
            break;
          }
        }
      }
    } catch(e) {}
  });

  binanceWs.on('close', () => {
    console.log('Binance WS disconnected, reconnecting...');
    scheduleBinanceReconnect();
  });

  binanceWs.on('error', (err) => {
    console.log('Binance WS error:', err.message);
    try { binanceWs.close(); } catch(e) {}
  });
}

function scheduleBinanceReconnect() {
  if (binanceReconnectTimer) clearTimeout(binanceReconnectTimer);
  binanceReconnectTimer = setTimeout(connectBinance, 5000);
}

// ─── COINGECKO FALLBACK (if Binance fails) ───
async function fetchCoinGeckoPrices() {
  try {
    var cgIds = Object.entries(COINS).filter(function(e) { return e[1].cgId; }).map(function(e) { return e[1].cgId; }).join(',');
    var prices = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=' + cgIds + '&vs_currencies=usd');
    var updated = 0;
    Object.entries(COINS).forEach(function(entry) {
      var sym = entry[0], c = entry[1];
      if (c.cgId && prices[c.cgId] && prices[c.cgId].usd) {
        // Only use CoinGecko if Binance hasn't updated this price recently
        if (!lastPrices[sym] || lastPrices[sym] === c.price) {
          lastPrices[sym] = prices[c.cgId].usd;
          updated++;
        }
      }
    });
    if (updated > 0) console.log('[' + new Date().toLocaleTimeString() + '] CoinGecko fallback updated ' + updated + ' prices');
  } catch(e) {
    console.log('CoinGecko fetch failed:', e.message);
  }
}

// ─── TWELVE DATA (Stocks + Gold) ───
// 8 credits/min limit, each symbol = 1 credit
// Split 21 symbols into 3 batches of 7-8, rotate 1 batch per minute
const tdSymbols = Object.entries(COINS)
  .filter(([_, c]) => c.tdSymbol)
  .map(([sym, c]) => ({ sym, tdSymbol: c.tdSymbol }));
const TD_BATCHES = [];
for (let i = 0; i < tdSymbols.length; i += 7) {
  TD_BATCHES.push(tdSymbols.slice(i, i + 7));
}
let tdBatchIndex = 0;

async function fetchTwelveDataBatch() {
  if (!TWELVEDATA_KEY || TD_BATCHES.length === 0) return;
  // US market hours: Mon-Fri 14:30-21:00 UTC (skip weekends + off-hours to save credits)
  var now = new Date();
  var utcH = now.getUTCHours(), utcM = now.getUTCMinutes(), day = now.getUTCDay();
  var marketOpen = day >= 1 && day <= 5 && (utcH > 14 || (utcH === 14 && utcM >= 30)) && utcH < 21;
  // During market hours: fetch every interval. Off-hours: fetch only GOLD batch (index 0) every 3rd cycle
  if (!marketOpen) {
    if (tdBatchIndex % 3 !== 0) { tdBatchIndex++; return; } // Only GOLD batch off-hours
  }
  var batchIdx = marketOpen ? (tdBatchIndex % TD_BATCHES.length) : 0; // Off-hours: only first batch (includes GOLD)
  var batch = TD_BATCHES[batchIdx];
  tdBatchIndex++;
  const symbols = batch.map(b => b.tdSymbol).join(',');
  try {
    const data = await fetchJSON('https://api.twelvedata.com/price?symbol=' + symbols + '&apikey=' + TWELVEDATA_KEY);
    let updated = 0;
    batch.forEach(b => {
      const entry = data[b.tdSymbol] || data;
      if (entry && entry.price && !entry.code) {
        lastPrices[b.sym] = parseFloat(entry.price);
        updated++;
      }
    });
    if (updated > 0) console.log('[' + new Date().toLocaleTimeString() + '] TwelveData batch ' + (tdBatchIndex) + ': updated ' + updated + ' prices (' + batch.map(b => b.sym).join(',') + ')');
  } catch(e) {
    console.log('TwelveData fetch failed:', e.message);
  }
}

// Rotate batches: 1 batch per minute, full cycle every 3 minutes
setInterval(fetchTwelveDataBatch, TWELVEDATA_INTERVAL);

async function fetchRealPrices() {
  await fetchCoinGeckoPrices();
  // Fetch first batch of stocks/gold immediately
  await fetchTwelveDataBatch();
  console.log('[' + new Date().toLocaleTimeString() + '] Prices loaded: BTC=$' + lastPrices.BTC + ' ETH=$' + lastPrices.ETH + ' AAPL=$' + (lastPrices.AAPL || '?') + ' GOLD=$' + (lastPrices.GOLD || '?'));
}

// ─── PRICE TICK ───
function priceTick() {
  tickCount++;
  const now = Date.now();

  Object.keys(COINS).forEach(sym => {
    const sd = marketData[sym];
    // All prices come from real sources (Binance/CoinGecko for crypto, TwelveData for stocks/gold)
    var np = lastPrices[sym] || sd.cur;
    if (!np || np <= 0) return; // Skip if no real price yet
    if (np !== sd.cur || !lastPriceUpdate[sym]) lastPriceUpdate[sym] = now;
    sd.cur = np;

    const b = sd.building;
    b.h = Math.max(b.h, np);
    b.l = Math.min(b.l, np);
    b.c = np;
    b.v += 1; // Volume increments per tick, real volume not available
    b.tickCount++;

    if (b.tickCount >= CANDLE_TICKS) {
      sd.candles.push({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: now });
      if (sd.candles.length > 500) sd.candles = sd.candles.slice(-500);

      const closes = sd.candles.map(c => c.c);
      const highs = sd.candles.map(c => c.h);
      const lows = sd.candles.map(c => c.l);

      sd.rsi = calcRSI(closes);
      sd.macd = calcMACD(closes);
      sd.bb = calcBB(closes);
      sd.ema9 = ema(closes, 9) || np;
      sd.ema21 = ema(closes, 21) || np;
      sd.ema50 = ema(closes, 50) || np;
      sd.ema200 = ema(closes, 200) || np;
      sd.stoch = calcStoch(highs, lows, closes);
      sd.adx = calcADX(highs, lows, closes);
      sd.vwap = closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : np;
      sd.prevMacdHist = sd.macd && sd.macd.hist || 0;

      sd.building = { o: np, h: np, l: np, c: np, v: 0, tickCount: 0 };

      // Run strategies on candle close
      runStrategies();
    }
  });
}

// ─── PRE-TRADE RISK ENGINE ───
var MAX_POSITIONS = { conservative: 8, moderate: 15, aggressive: 25, yolo: 41 };

function preTradeRiskCheck(pf, side, symbol, qty, price, profile) {
  var totalHVal = Object.entries(pf.holdings).reduce(function(s, entry) {
    return s + ((entry[1] && entry[1].qty) || 0) * ((marketData[entry[0]] || {}).cur || 0);
  }, 0);
  var totalValue = pf.cash + totalHVal;
  if (totalValue <= 0) totalValue = pf.startCash;
  var tradeValue = qty * price;

  // 1. Max single trade size: no trade > 30% of total portfolio value
  if (tradeValue > totalValue * 0.30) {
    return { allowed: false, reason: 'Trade size ' + (tradeValue / totalValue * 100).toFixed(0) + '% exceeds 30% max' };
  }

  // 2. Max position concentration: no single asset > 40% of portfolio (for buys)
  if (side === 'buy') {
    var existing = (pf.holdings[symbol] && pf.holdings[symbol].qty) || 0;
    var posValue = (existing * price) + tradeValue;
    if (posValue > totalValue * 0.40) {
      return { allowed: false, reason: symbol + ' concentration ' + (posValue / totalValue * 100).toFixed(0) + '% exceeds 40% max' };
    }
  }

  // 3. Daily loss limit: if today's realized losses > 5% of startCash, stop trading
  var today = new Date().toISOString().slice(0, 10);
  var ds = dailyStats[pf.id];
  if (ds && ds.date === today && ds.loss >= pf.startCash * 0.05) {
    return { allowed: false, reason: 'Daily loss limit reached ($' + ds.loss.toFixed(0) + ')' };
  }

  // 4. Max open positions
  if (side === 'buy') {
    var openPositions = Object.keys(pf.holdings).filter(function(s) {
      var h = pf.holdings[s];
      return h && h.qty > 0;
    }).length;
    var maxPos = MAX_POSITIONS[pf.id] || 15;
    // Only count as new position if we don't already hold it
    var isNew = !pf.holdings[symbol] || pf.holdings[symbol].qty <= 0;
    if (isNew && openPositions >= maxPos) {
      return { allowed: false, reason: 'Max positions (' + maxPos + ') reached' };
    }
  }

  // 5. Minimum cash reserve: always keep 2% cash (for buys)
  if (side === 'buy') {
    var minReserve = pf.startCash * 0.02;
    if (pf.cash - tradeValue < minReserve) {
      return { allowed: false, reason: 'Would breach 2% cash reserve' };
    }
  }

  return { allowed: true, reason: '' };
}

// ─── STRATEGY STATE MACHINE ───
// States: RUNNING, DEGRADED, STOPPED
var portfolioStates = {};  // { "conservative": "RUNNING", ... }
var degradedSymbols = {};  // { "BTC": true } - symbols with stale data
var lastPriceUpdate = {};  // { "BTC": timestamp } - last time price was updated

function checkDataFreshness() {
  var now = Date.now();
  var staleThreshold = 5 * 60 * 1000; // 5 minutes
  var staleSyms = {};

  Object.keys(COINS).forEach(function(sym) {
    if (lastPriceUpdate[sym] && (now - lastPriceUpdate[sym]) > staleThreshold) {
      staleSyms[sym] = true;
    }
  });

  degradedSymbols = staleSyms;

  // Update portfolio states based on staleness
  portfolios.forEach(function(pf) {
    // Don't override STOPPED state (manual resume required)
    if (portfolioStates[pf.id] === 'STOPPED') return;

    var profile = PROFILES.find(function(p) { return p.id === pf.id; });
    if (!profile) return;

    var hasStale = profile.assets.some(function(sym) { return staleSyms[sym]; });
    portfolioStates[pf.id] = hasStale ? 'DEGRADED' : 'RUNNING';
  });
}

function resumePortfolio(id) {
  portfolioStates[id] = 'RUNNING';
  // Reset circuit breaker flag
  if (lastScores[id]) lastScores[id]._circuitBreaker = false;
  console.log('[' + new Date().toLocaleTimeString() + '] Portfolio resumed: ' + id);
  return true;
}

// ─── SCORING-BASED STRATEGY ENGINE ───
var tradeCooldowns = {};
var lastScores = {};

// Daily tracking: { "portfolioId": { date: "2026-03-24", trades: 0, loss: 0 } }
var dailyStats = {};
var DAILY_MAX_TRADES = { conservative: 10, moderate: 20, aggressive: 50, yolo: 100 };
var DAILY_MAX_LOSS_PCT = 0.05; // 5% max daily loss
var CIRCUIT_BREAKER_PCT = 0.20; // Stop at 20% total drawdown
var CATEGORY_CAP = 3.0; // Max score contribution per category

// ─── MULTI-TIMEFRAME: build 15min candles from 1min ───
function get15mTrend(sd) {
  if (!sd || sd.candles.length < 30) return 0; // 0 = neutral
  // Group last 60 candles into 15-candle (15min) bars
  var candles15 = [];
  var src = sd.candles.slice(-60);
  for (var i = 0; i < src.length; i += 15) {
    var slice = src.slice(i, i + 15);
    if (slice.length < 5) continue;
    candles15.push({
      o: slice[0].o,
      h: Math.max.apply(null, slice.map(function(c){return c.h;})),
      l: Math.min.apply(null, slice.map(function(c){return c.l;})),
      c: slice[slice.length - 1].c,
    });
  }
  if (candles15.length < 2) return 0;
  var closes15 = candles15.map(function(c){return c.c;});
  var e9 = ema(closes15, Math.min(9, closes15.length));
  var e21 = ema(closes15, Math.min(21, closes15.length));
  if (!e9 || !e21) return 0;
  if (e9 > e21) return 1;  // 15min uptrend
  if (e9 < e21) return -1; // 15min downtrend
  return 0;
}

// ─── BLACK SWAN FILTER ───
// Black swan: 3%+ drop in 5 candles triggers freeze
// Recovery: must see 3 consecutive stable candles (< 0.5% drop each) after crash ends
var blackSwanCooldown = {}; // { "BTC": cooldownUntilCandleCount }

function isBlackSwan(sd, sym) {
  if (!sd || sd.candles.length < 8) return false;
  var recent5 = sd.candles.slice(-5);
  var firstOpen = recent5[0].o;
  var lastClose = recent5[recent5.length - 1].c;
  var dropPct = ((firstOpen - lastClose) / firstOpen) * 100;

  if (dropPct >= 3) {
    // Active crash - set cooldown to current candle count + 3
    blackSwanCooldown[sym] = sd.candles.length + 3;
    return true;
  }

  // Check if still in cooldown (crash ended but waiting for stability)
  if (blackSwanCooldown[sym] && sd.candles.length < blackSwanCooldown[sym]) {
    return true; // Still in post-crash cooldown
  }

  // Cooldown expired - check last 3 candles are stable
  if (blackSwanCooldown[sym] && sd.candles.length >= blackSwanCooldown[sym]) {
    var last3 = sd.candles.slice(-3);
    var allStable = last3.every(function(c) {
      return Math.abs((c.c - c.o) / c.o) * 100 < 0.5;
    });
    if (allStable) {
      delete blackSwanCooldown[sym]; // Clear cooldown
      return false;
    }
    return true; // Still volatile, extend freeze
  }

  return false;
}

// FIFO P&L calculation using lots
function calcFifoPnl(pos, sellQty, sellPrice) {
  if (!pos || !pos.lots || pos.lots.length === 0) {
    // Fallback: use avgCost if no lots
    return (sellPrice - (pos && pos.avgCost || sellPrice)) * sellQty;
  }
  var remaining = sellQty;
  var totalPnl = 0;
  for (var i = 0; i < pos.lots.length && remaining > 0; i++) {
    var lot = pos.lots[i];
    var used = Math.min(lot.qty, remaining);
    totalPnl += (sellPrice - lot.cost) * used;
    remaining -= used;
  }
  return totalPnl;
}

// Consume lots FIFO style (modifies array in place, returns remaining lots)
function consumeLotsFifo(lots, sellQty) {
  if (!lots) return [];
  var remaining = sellQty;
  var newLots = [];
  for (var i = 0; i < lots.length; i++) {
    if (remaining <= 0) {
      newLots.push(lots[i]);
      continue;
    }
    if (lots[i].qty <= remaining) {
      remaining -= lots[i].qty;
      // lot fully consumed
    } else {
      newLots.push({ qty: +(lots[i].qty - remaining).toFixed(6), cost: lots[i].cost, date: lots[i].date });
      remaining = 0;
    }
  }
  return newLots;
}

function runStrategies() {
  var now = Date.now();
  var today = new Date().toISOString().slice(0, 10);

  // Check data freshness for state machine
  checkDataFreshness();

  portfolios.forEach(function(pf) {
    var profile = PROFILES.find(function(p) { return p.id === pf.id; });
    if (!profile) return;

    // Initialize portfolio state if needed
    if (!portfolioStates[pf.id]) portfolioStates[pf.id] = 'RUNNING';

    // ─── STRATEGY STATE MACHINE ───
    if (portfolioStates[pf.id] === 'STOPPED') {
      if (!lastScores[pf.id]) lastScores[pf.id] = {};
      lastScores[pf.id]._circuitBreaker = true;
      return; // Manual resume required
    }

    var buyThreshold = profile.buyThreshold || 3;
    var sellThreshold = profile.sellThreshold || 2;
    var cashPct = profile.cashPct || 0.10;

    // ─── CIRCUIT BREAKER: stop trading if drawdown > 20% ───
    var hVal = Object.entries(pf.holdings).reduce(function(s, entry) {
      return s + ((entry[1] && entry[1].qty) || 0) * ((marketData[entry[0]] || {}).cur || 0);
    }, 0);
    var totalValue = pf.cash + hVal;
    var drawdownPct = (pf.startCash - totalValue) / pf.startCash;
    var liveCbThreshold = { conservative: 0.10, moderate: 0.15, aggressive: 0.20, yolo: 0.30 }[pf.id] || 0.20;
    if (drawdownPct >= liveCbThreshold) {
      if (!lastScores[pf.id]) lastScores[pf.id] = {};
      lastScores[pf.id]._circuitBreaker = true;
      portfolioStates[pf.id] = 'STOPPED';
      console.log('[' + new Date().toLocaleTimeString() + '] CIRCUIT BREAKER: ' + pf.id + ' -> STOPPED (drawdown ' + (drawdownPct * 100).toFixed(1) + '%)');
      return; // Stop all trading for this portfolio
    }

    // ─── DAILY LIMITS ───
    if (!dailyStats[pf.id] || dailyStats[pf.id].date !== today) {
      dailyStats[pf.id] = { date: today, trades: 0, loss: 0 };
    }
    var ds = dailyStats[pf.id];
    var maxDailyTrades = DAILY_MAX_TRADES[pf.id] || 50;
    if (ds.trades >= maxDailyTrades) return;
    if (ds.loss >= pf.startCash * DAILY_MAX_LOSS_PCT) return; // 5% daily loss limit

    // For each asset this profile trades
    profile.assets.forEach(function(sym) {
      var sd = marketData[sym];
      if (!sd || sd.candles.length < 5) return;
      var pos = pf.holdings[sym];
      var peakPrice = pf.peaks[sym];

      // Check cooldown per symbol
      var coolKey = pf.id + '_' + sym;
      var cooldownMs = COOLDOWNS[pf.id] || 300000;
      if (tradeCooldowns[coolKey] && (now - tradeCooldowns[coolKey]) < cooldownMs) return;

      // Detect market regime
      var regime = detectRegime(sd);

      // Multi-timeframe: 15min trend direction
      var trend15m = get15mTrend(sd);

      // Black swan check (with post-crash cooldown)
      var blackSwan = isBlackSwan(sd, sym);

      // Portfolio exposure limit: block new buys when holdings exceed threshold
      var holdingValue = Object.entries(pf.holdings).reduce(function(s, entry) {
        return s + ((entry[1] && entry[1].qty) || 0) * ((marketData[entry[0]] || {}).cur || 0);
      }, 0);
      var exposurePct = totalValue > 0 ? holdingValue / totalValue : 0;
      var maxExposure = { conservative: 0.75, moderate: 0.85, aggressive: 0.92, yolo: 0.98 }[pf.id] || 0.80;
      var exposureLimited = exposurePct >= maxExposure;

      // Regime-based weight multipliers with:
      // 1. Profile-specific multiplier intensity (Conservative aggressive, YOLO mild)
      // 2. Linear interpolation in transition zone (ADX 18-25)
      // 3. Ranging downtrend protection
      var profileRegime = {
        conservative: { trendHigh: 2.0, trendLow: 0.3, mrHigh: 2.0, mrLow: 0.3 },
        moderate:     { trendHigh: 1.5, trendLow: 0.5, mrHigh: 1.5, mrLow: 0.5 },
        aggressive:   { trendHigh: 1.3, trendLow: 0.6, mrHigh: 1.3, mrLow: 0.6 },
        yolo:         { trendHigh: 1.2, trendLow: 0.8, mrHigh: 1.2, mrLow: 0.8 },
      };
      var pr = profileRegime[pf.id] || profileRegime.moderate;
      var adxVal = regime.adx || 20;

      // Linear interpolation for smooth transition
      // ADX <= 18: full ranging multipliers
      // ADX >= 25: full trending multipliers
      // 18 < ADX < 25: linear blend between ranging and trending
      var trendMult, meanRevMult;
      if (adxVal >= 25) {
        trendMult = pr.trendHigh;   // trend signals boosted
        meanRevMult = pr.mrLow;     // mean-rev suppressed
      } else if (adxVal <= 18) {
        trendMult = pr.trendLow;    // trend signals suppressed
        meanRevMult = pr.mrHigh;    // mean-rev boosted
      } else {
        // Linear interpolation: ADX 18-25 => t goes 0.0 to 1.0
        var t = (adxVal - 18) / 7;  // 0 at ADX=18, 1 at ADX=25
        trendMult = pr.trendLow + t * (pr.trendHigh - pr.trendLow);
        meanRevMult = pr.mrHigh + t * (pr.mrLow - pr.mrHigh);
      }

      // Ranging downtrend protection: if ranging but price below EMA21, suppress mean-rev buys
      var rangingDowntrend = adxVal <= 18 && sd.ema21 > 0 && sd.cur < sd.ema21;
      if (rangingDowntrend) meanRevMult = pr.mrLow; // Don't buy dips in a downtrend

      var regimeMultipliers = {
        'trend': trendMult, 'momentum': trendMult,
        'mean-reversion': meanRevMult,
        'neutral': 1.0, 'pattern': 1.0, 'combo': 1.2, 'risk': 0,
      };

      // Score all signals with CATEGORY CAP
      var buyScore = 0, sellScore = 0;
      var buyReasons = [], sellReasons = [];
      var riskSellTriggered = null;
      var buyCatScores = {}; // { "mean-reversion": 2.5, "trend": 1.5 }
      var sellCatScores = {};

      SIGNALS.forEach(function(sig) {
        var val = (profile.overrides && profile.overrides[sig.id] !== undefined) ? profile.overrides[sig.id] : 30;

        // Asset-type adjustment for TP/SL/trailing
        if (sig.category === 'risk') {
          var assetType = (COINS[sym] && COINS[sym].type) || 'crypto';
          if (assetType === 'stock') val = val * 0.7;
          else if (assetType === 'commodity') val = val * 0.5;
        }

        var result = evalSignal(sig.id, val, sd, pos, peakPrice);
        if (!result) return;

        // Risk signals bypass scoring
        if (sig.category === 'risk') {
          if (pos && pos.qty > 0) riskSellTriggered = result;
          return;
        }

        var regimeMult = regimeMultipliers[sig.category] || 1.0;
        var weightedScore = sig.weight * regimeMult;

        if (sig.side === 'buy') {
          // Apply category cap
          var catKey = sig.category;
          buyCatScores[catKey] = (buyCatScores[catKey] || 0) + weightedScore;
          if (buyCatScores[catKey] <= CATEGORY_CAP) {
            buyScore += weightedScore;
          }
          buyReasons.push(result);
        } else {
          var catKey2 = sig.category;
          sellCatScores[catKey2] = (sellCatScores[catKey2] || 0) + weightedScore;
          if (sellCatScores[catKey2] <= CATEGORY_CAP) {
            sellScore += weightedScore;
          }
          sellReasons.push(result);
        }
      });

      // ─── MULTI-TIMEFRAME GATE ───
      // If 15min trend is down, penalize buys
      // NEVER penalize sells — we always want to be able to exit positions
      if (trend15m === -1) buyScore = buyScore * 0.3;
      // If 15min trend is up, give a small buy boost instead of blocking sells
      if (trend15m === 1) buyScore = buyScore * 1.2;

      // ─── BLACK SWAN FILTER ───
      // Block all buys during crash
      if (blackSwan) {
        buyScore = 0;
        buyReasons.push('BLACK SWAN BLOCKED');
      }

      // ─── EXPOSURE LIMIT ───
      // Block buys when portfolio is over-exposed to holdings
      if (exposureLimited) {
        buyScore = 0;
        // Auto-rebalance: boost sell score when over-exposed
        sellScore += 1.5;
        sellReasons.push('Over-exposed');
      }

      // Store scores for UI
      if (!lastScores[pf.id]) lastScores[pf.id] = {};
      lastScores[pf.id][sym] = {
        buy: +buyScore.toFixed(1), sell: +sellScore.toFixed(1),
        regime: regime.type + (rangingDowntrend ? '↓' : ''), volatility: +regime.volatility.toFixed(2),
        trend15m: trend15m, blackSwan: blackSwan,
        exposure: +(exposurePct * 100).toFixed(0), exposureLimited: exposureLimited,
        buyReasons: buyReasons, sellReasons: sellReasons,
      };
      lastScores[pf.id]._circuitBreaker = false;

      // Reduce position size in high volatility
      var volAdjust = regime.volatility > 3 ? 0.5 : (regime.volatility > 2 ? 0.75 : 1.0);

      var price = sd.cur;
      if (price <= 0) return;
      var slippagePct = (profile.overrides && profile.overrides.slippage !== undefined) ? profile.overrides.slippage : SLIPPAGE_PCT;
      var minCashReserve = pf.startCash * 0.02;
      var availableCash = Math.max(0, pf.cash - minCashReserve);

      // ─── DEGRADED STATE: skip symbols with stale data ───
      if (portfolioStates[pf.id] === 'DEGRADED' && degradedSymbols[sym]) return;

      // --- RISK SELL (TP/SL/Trailing) — always execute immediately ---
      if (riskSellTriggered && pos && pos.qty > 0) {
        var riskFillPrice = price * (1 - slippagePct); // slippage: sell fills lower
        var riskQty = pos.qty;
        var riskTotal = riskFillPrice * riskQty;
        var riskComm = riskTotal * COMMISSION_RATE;
        pf.cash += riskTotal - riskComm;
        pf.totalCommission = (pf.totalCommission || 0) + riskComm;
        var riskPnl = calcFifoPnl(pos, riskQty, riskFillPrice);
        if (riskPnl > 0) pf.wins++; else { pf.losses++; ds.loss += Math.abs(riskPnl); }
        delete pf.holdings[sym];
        tradeCooldowns[coolKey] = now;
        pf.tradeCount++; ds.trades++;
        console.log('[' + new Date().toLocaleTimeString() + '] TRADE ' + pf.id + ' SELL(risk) ' + sym + ' qty=' + riskQty.toFixed(4) + ' $' + riskTotal.toFixed(0) + ' pnl=$' + riskPnl.toFixed(0) + ' reason=' + riskSellTriggered);
        pf.orders = [{
          sym: sym, side: 'sell', qty: riskQty, total: +(riskTotal).toFixed(2), price: riskFillPrice,
          signalPrice: price, slippage: slippagePct,
          commission: riskComm.toFixed(2), time: new Date().toISOString(),
          strat: 'Risk Mgmt', why: riskSellTriggered,
          score: '-' + sellScore.toFixed(1), regime: regime.type, trend15m: trend15m,
          pnl: +riskPnl.toFixed(2), pnlPct: +((riskPnl / (pos.avgCost * riskQty)) * 100).toFixed(2),
          avgCost: +pos.avgCost.toFixed(2),
          exposure: +(exposurePct * 100).toFixed(0), volatility: +regime.volatility.toFixed(2),
          rsi: +sd.rsi.toFixed(1), macdHist: +sd.macd.hist.toFixed(4), adx: +sd.adx.toFixed(1),
          cashAfter: +pf.cash.toFixed(0), candleCount: sd.candles.length,
          blackSwan: blackSwan,
        }].concat(pf.orders).slice(0, 200);
        return;
      }

      // --- SCORING-BASED BUY ---
      // Exposure limit: conservative/moderate cap at 80%, aggressive 90%, yolo 95%
      var maxExposure = profile.id === 'yolo' ? 0.95 : profile.id === 'aggressive' ? 0.90 : 0.80;
      if (buyScore >= buyThreshold && buyScore > sellScore && exposurePct < maxExposure) {
        if (availableCash < 100) return;
        // Max position count limit
        var openPositionCount = Object.keys(pf.holdings).filter(function(k) { return pf.holdings[k] && pf.holdings[k].qty > 0; }).length;
        var maxPositions = { conservative: 3, moderate: 5, aggressive: 8, yolo: 12 }[pf.id] || 5;
        if (openPositionCount >= maxPositions) return;
        var buyFillPrice = price * (1 + slippagePct); // slippage: buy fills higher
        // Size based on total portfolio value, not just cash — keeps trades large even when mostly in holdings
        var tradeValue = Math.min(availableCash * cashPct, availableCash * 0.95);
        // Max per-position capital
        var maxPerPosition = { conservative: 0.15, moderate: 0.12, aggressive: 0.10, yolo: 0.08 }[pf.id] || 0.10;
        tradeValue = Math.min(tradeValue, pf.startCash * maxPerPosition);
        var tq = +(tradeValue / buyFillPrice).toFixed(6);
        if (tq <= 0) return;
        var total = buyFillPrice * tq;
        var commission = total * COMMISSION_RATE;
        if (total + commission > availableCash) return;

        // Commission-aware trade gate: expected profit must exceed 2x trade cost
        var expectedTpPct = (profile.overrides && profile.overrides.tp_pct) || 5;
        var expectedProfit = total * (expectedTpPct / 100);
        var tradeCost = total * COMMISSION_RATE * 2; // buy + sell commission
        if (expectedProfit < tradeCost * 2) return; // skip: not enough profit potential

        // Pre-trade risk check
        var buyRisk = preTradeRiskCheck(pf, 'buy', sym, tq, buyFillPrice, profile);
        if (!buyRisk.allowed) {
          console.log('[' + new Date().toLocaleTimeString() + '] RISK REJECTED ' + pf.id + ' BUY ' + sym + ': ' + buyRisk.reason);
          return;
        }

        pf.cash -= total + commission;
        pf.totalCommission = (pf.totalCommission || 0) + commission;
        var old = pf.holdings[sym] || { qty: 0, avgCost: 0, lots: [] };
        if (!old.lots) old.lots = old.qty > 0 ? [{ qty: old.qty, cost: old.avgCost, date: new Date().toISOString() }] : [];
        var nq = +(old.qty + tq).toFixed(6);
        var newLots = old.lots.concat([{ qty: tq, cost: buyFillPrice, date: new Date().toISOString() }]);
        pf.holdings[sym] = { qty: nq, avgCost: nq > 0 ? (old.avgCost * old.qty + total) / nq : buyFillPrice, lots: newLots };
        pf.peaks[sym] = price;
        // Bracket order targets
        var tpPct = (profile.overrides && profile.overrides.tp_pct !== undefined) ? profile.overrides.tp_pct : 2.0;
        var slPct = (profile.overrides && profile.overrides.sl_pct !== undefined) ? profile.overrides.sl_pct : 1.0;
        var bracketTP = +(buyFillPrice * (1 + tpPct / 100)).toFixed(2);
        var bracketSL = +(buyFillPrice * (1 - slPct / 100)).toFixed(2);
        tradeCooldowns[coolKey] = now;
        pf.tradeCount++; ds.trades++;
        console.log('[' + new Date().toLocaleTimeString() + '] TRADE ' + pf.id + ' BUY ' + sym + ' qty=' + tq.toFixed(4) + ' $' + total.toFixed(0) + ' score=+' + buyScore.toFixed(1) + ' regime=' + regime.type + ' [' + buyReasons.join(', ') + '] TP=$' + bracketTP + ' SL=$' + bracketSL);
        var prevHolding = (pf.holdings[sym] && pf.holdings[sym].qty) || 0;
        pf.orders = [{
          sym: sym, side: 'buy', qty: tq, total: +(total).toFixed(2), price: buyFillPrice,
          signalPrice: price, slippage: slippagePct,
          bracketTP: bracketTP, bracketSL: bracketSL,
          commission: commission.toFixed(2), time: new Date().toISOString(),
          strat: buyReasons.length + ' signals', why: buyReasons.join(', '),
          score: '+' + buyScore.toFixed(1), regime: regime.type, trend15m: trend15m,
          pnl: 0, pnlPct: 0,
          avgCost: +((pf.holdings[sym] || {}).avgCost || price).toFixed(2),
          holdingBefore: +prevHolding.toFixed(6),
          exposure: +(exposurePct * 100).toFixed(0), volatility: +regime.volatility.toFixed(2),
          rsi: +sd.rsi.toFixed(1), macdHist: +sd.macd.hist.toFixed(4), adx: +sd.adx.toFixed(1),
          cashBefore: +(pf.cash + total + commission).toFixed(0), cashAfter: +pf.cash.toFixed(0),
          candleCount: sd.candles.length, blackSwan: blackSwan,
        }].concat(pf.orders).slice(0, 200);
      }

      // --- SCORING-BASED SELL ---
      else if (sellScore >= sellThreshold && pos && pos.qty > 0) {
        var sellFillPrice = price * (1 - slippagePct); // slippage: sell fills lower
        var sq = pos.qty;
        var sellTotal = sellFillPrice * sq;
        var sellComm = sellTotal * COMMISSION_RATE;

        // Pre-trade risk check
        var sellRisk = preTradeRiskCheck(pf, 'sell', sym, sq, sellFillPrice, profile);
        if (!sellRisk.allowed) {
          console.log('[' + new Date().toLocaleTimeString() + '] RISK REJECTED ' + pf.id + ' SELL ' + sym + ': ' + sellRisk.reason);
          return;
        }

        pf.cash += sellTotal - sellComm;
        pf.totalCommission = (pf.totalCommission || 0) + sellComm;
        var sellPnl = calcFifoPnl(pos, sq, sellFillPrice);
        if (sellPnl > 0) pf.wins++; else { pf.losses++; ds.loss += Math.abs(sellPnl); }
        delete pf.holdings[sym];
        tradeCooldowns[coolKey] = now;
        pf.tradeCount++; ds.trades++;
        console.log('[' + new Date().toLocaleTimeString() + '] TRADE ' + pf.id + ' SELL ' + sym + ' qty=' + sq.toFixed(4) + ' $' + sellTotal.toFixed(0) + ' pnl=$' + sellPnl.toFixed(0) + ' score=-' + sellScore.toFixed(1) + ' regime=' + regime.type + ' [' + sellReasons.join(', ') + ']');
        pf.orders = [{
          sym: sym, side: 'sell', qty: sq, total: +(sellTotal).toFixed(2), price: sellFillPrice,
          signalPrice: price, slippage: slippagePct,
          commission: sellComm.toFixed(2), time: new Date().toISOString(),
          strat: sellReasons.length + ' signals', why: sellReasons.join(', '),
          score: '-' + sellScore.toFixed(1), regime: regime.type, trend15m: trend15m,
          pnl: +sellPnl.toFixed(2), pnlPct: +((sellPnl / (pos.avgCost * sq)) * 100).toFixed(2),
          avgCost: +pos.avgCost.toFixed(2),
          holdingBefore: +pos.qty.toFixed(6),
          exposure: +(exposurePct * 100).toFixed(0), volatility: +regime.volatility.toFixed(2),
          rsi: +sd.rsi.toFixed(1), macdHist: +sd.macd.hist.toFixed(4), adx: +sd.adx.toFixed(1),
          cashBefore: +(pf.cash - sellTotal + sellComm).toFixed(0), cashAfter: +pf.cash.toFixed(0),
          candleCount: sd.candles.length, blackSwan: blackSwan,
        }].concat(pf.orders).slice(0, 200);
      }
    });

    // Update peaks
    Object.keys(pf.holdings).forEach(function(sym) {
      var c = (marketData[sym] || {}).cur;
      if (c && (!pf.peaks[sym] || c > pf.peaks[sym])) pf.peaks[sym] = c;
    });

    // Record history
    var hVal = Object.entries(pf.holdings).reduce(function(s, entry) {
      var sym = entry[0], h = entry[1];
      return s + ((h && h.qty) || 0) * ((marketData[sym] || {}).cur || 0);
    }, 0);
    pf.history.push({ t: pf.history.length, value: pf.cash + hVal });
    if (pf.history.length > 1000) pf.history = pf.history.slice(-1000);
  });

  // ─── DMA TREND FOLLOWER (independent module) ───
  // Strategy: BTC only, EMA200 on 5-minute candles
  // Buy $50K when price is 1% below EMA200, another $50K at 2% below (100% invested)
  // Sell $50K when price is 1% above EMA200, another $50K at 2% above (100% cash)
  var dmaPf = portfolios.find(function(p) { return p.id === 'dma'; });
  if (dmaPf) {
    var sym = 'BTC';
    var sd = marketData[sym];
    if (sd && sd.candles.length >= 200) {
      var closes = sd.candles.map(function(c) { return c.c; });
      var ema200 = ema(closes, 200);
      if (ema200 && ema200 > 0) {
        var price = sd.cur;
        var pos = dmaPf.holdings[sym];
        var posQty = (pos && pos.qty) || 0;
        var halfCapital = dmaPf.startCash * 0.50; // $50K tranches
        var COMM = 0.001;

        // Calculate distance from EMA200 as percentage
        var distPct = ((price - ema200) / ema200) * 100; // negative = below, positive = above

        // Track which levels have been triggered (prevent re-buying/selling same level)
        if (!dmaPf._dmaState) dmaPf._dmaState = { bought1: false, bought2: false, sold1: false, sold2: false };
        var state = dmaPf._dmaState;

        // ─── BUY LOGIC ───
        // Level 1: Price 1% below EMA200 → buy $50K (first tranche)
        if (distPct <= -0.5 && !state.bought1 && dmaPf.cash >= halfCapital) {
          var buyVal = Math.min(halfCapital, dmaPf.cash * 0.98);
          var qty = buyVal / price;
          var comm = buyVal * COMM;
          dmaPf.cash -= buyVal + comm;
          if (!dmaPf.holdings[sym]) dmaPf.holdings[sym] = { qty: 0, avgCost: 0, lots: [] };
          var h = dmaPf.holdings[sym];
          h.avgCost = h.qty > 0 ? ((h.avgCost * h.qty) + (price * qty)) / (h.qty + qty) : price;
          h.qty += qty;
          if (!h.lots) h.lots = [];
          h.lots.push({ qty: qty, cost: price, date: new Date().toISOString() });
          dmaPf.totalCommission = (dmaPf.totalCommission || 0) + comm;
          dmaPf.tradeCount++;
          dmaPf.orders = [{ sym: sym, side: 'buy', qty: +qty.toFixed(6), price: price, total: +buyVal.toFixed(2), time: new Date().toISOString(), strat: 'EMA200', why: 'Price ' + distPct.toFixed(2) + '% below EMA200 (1st tranche $50K)', commission: comm.toFixed(2) }].concat(dmaPf.orders).slice(0, 200);
          state.bought1 = true;
          state.sold1 = false; // Reset sell flags when buying
          state.sold2 = false;
          console.log('[' + new Date().toLocaleTimeString() + '] DMA BUY1 BTC @$' + price.toFixed(0) + ' EMA200=$' + ema200.toFixed(0) + ' dist=' + distPct.toFixed(2) + '% qty=' + qty.toFixed(4));
        }
        // Level 2: Price 2% below EMA200 → buy another $50K (fully invested)
        if (distPct <= -1.0 && state.bought1 && !state.bought2 && dmaPf.cash >= halfCapital * 0.5) {
          var buyVal = Math.min(halfCapital, dmaPf.cash * 0.98);
          var qty = buyVal / price;
          var comm = buyVal * COMM;
          dmaPf.cash -= buyVal + comm;
          if (!dmaPf.holdings[sym]) dmaPf.holdings[sym] = { qty: 0, avgCost: 0, lots: [] };
          var h = dmaPf.holdings[sym];
          h.avgCost = h.qty > 0 ? ((h.avgCost * h.qty) + (price * qty)) / (h.qty + qty) : price;
          h.qty += qty;
          if (!h.lots) h.lots = [];
          h.lots.push({ qty: qty, cost: price, date: new Date().toISOString() });
          dmaPf.totalCommission = (dmaPf.totalCommission || 0) + comm;
          dmaPf.tradeCount++;
          dmaPf.orders = [{ sym: sym, side: 'buy', qty: +qty.toFixed(6), price: price, total: +buyVal.toFixed(2), time: new Date().toISOString(), strat: 'EMA200', why: 'Price ' + distPct.toFixed(2) + '% below EMA200 (2nd tranche $50K - FULL)', commission: comm.toFixed(2) }].concat(dmaPf.orders).slice(0, 200);
          state.bought2 = true;
          console.log('[' + new Date().toLocaleTimeString() + '] DMA BUY2 BTC @$' + price.toFixed(0) + ' EMA200=$' + ema200.toFixed(0) + ' dist=' + distPct.toFixed(2) + '% qty=' + qty.toFixed(4) + ' FULLY INVESTED');
        }

        // ─── SELL LOGIC ───
        // Level 1: Price 1% above EMA200 → sell $50K worth (first tranche)
        if (distPct >= 0.5 && !state.sold1 && posQty > 0) {
          var sellQty = Math.min(halfCapital / price, posQty); // Sell $50K worth
          if (sellQty > posQty) sellQty = posQty;
          var sellVal = sellQty * price;
          var comm = sellVal * COMM;
          dmaPf.cash += sellVal - comm;
          var pnl = (price - pos.avgCost) * sellQty;
          if (pnl > 0) dmaPf.wins = (dmaPf.wins || 0) + 1; else dmaPf.losses = (dmaPf.losses || 0) + 1;
          dmaPf.totalCommission = (dmaPf.totalCommission || 0) + comm;
          dmaPf.tradeCount++;
          dmaPf.orders = [{ sym: sym, side: 'sell', qty: +sellQty.toFixed(6), price: price, total: +sellVal.toFixed(2), pnl: +pnl.toFixed(2), time: new Date().toISOString(), strat: 'EMA200', why: 'Price ' + distPct.toFixed(2) + '% above EMA200 (1st sell $50K)', commission: comm.toFixed(2) }].concat(dmaPf.orders).slice(0, 200);
          pos.qty -= sellQty;
          if (pos.qty <= 0.000001) delete dmaPf.holdings[sym];
          state.sold1 = true;
          state.bought1 = false; // Reset buy flags when selling
          state.bought2 = false;
          console.log('[' + new Date().toLocaleTimeString() + '] DMA SELL1 BTC @$' + price.toFixed(0) + ' EMA200=$' + ema200.toFixed(0) + ' dist=' + distPct.toFixed(2) + '% pnl=$' + pnl.toFixed(0));
        }
        // Level 2: Price 2% above EMA200 → sell remaining (100% cash)
        if (distPct >= 1.0 && state.sold1 && !state.sold2 && dmaPf.holdings[sym] && dmaPf.holdings[sym].qty > 0) {
          var remainPos = dmaPf.holdings[sym];
          var sellQty = remainPos.qty;
          var sellVal = sellQty * price;
          var comm = sellVal * COMM;
          dmaPf.cash += sellVal - comm;
          var pnl = (price - remainPos.avgCost) * sellQty;
          if (pnl > 0) dmaPf.wins = (dmaPf.wins || 0) + 1; else dmaPf.losses = (dmaPf.losses || 0) + 1;
          dmaPf.totalCommission = (dmaPf.totalCommission || 0) + comm;
          dmaPf.tradeCount++;
          dmaPf.orders = [{ sym: sym, side: 'sell', qty: +sellQty.toFixed(6), price: price, total: +sellVal.toFixed(2), pnl: +pnl.toFixed(2), time: new Date().toISOString(), strat: 'EMA200', why: 'Price ' + distPct.toFixed(2) + '% above EMA200 (2nd sell - 100% CASH)', commission: comm.toFixed(2) }].concat(dmaPf.orders).slice(0, 200);
          delete dmaPf.holdings[sym];
          state.sold2 = true;
          console.log('[' + new Date().toLocaleTimeString() + '] DMA SELL2 BTC @$' + price.toFixed(0) + ' EMA200=$' + ema200.toFixed(0) + ' dist=' + distPct.toFixed(2) + '% pnl=$' + pnl.toFixed(0) + ' 100% CASH');
        }
      }
    }

    // Record DMA history
    var dmaHVal = Object.entries(dmaPf.holdings).reduce(function(s, entry) {
      var sym = entry[0], h = entry[1];
      return s + ((h && h.qty) || 0) * ((marketData[sym] || {}).cur || 0);
    }, 0);
    dmaPf.history.push({ t: dmaPf.history.length, value: dmaPf.cash + dmaHVal });
    if (dmaPf.history.length > 1000) dmaPf.history = dmaPf.history.slice(-1000);
  }
}

// ─── RESET PORTFOLIO ───
function resetPortfolio(id) {
  var profile = PROFILES.find(function(p) { return p.id === id; });
  // Allow reset for DMA portfolio too (no PROFILES entry)
  if (!profile && id !== 'dma') return false;
  var pf = portfolios.find(function(p) { return p.id === id; });
  if (!pf) return false;
  pf.cash = DEFAULT_CASH;
  pf.startCash = DEFAULT_CASH;
  pf.holdings = {};
  pf.orders = [];
  pf.peaks = {};
  pf.history = [{ t: 0, value: DEFAULT_CASH }];
  pf.tradeCount = 0;
  pf.wins = 0;
  pf.losses = 0;
  pf.totalCommission = 0;
  console.log('[' + new Date().toLocaleTimeString() + '] Reset portfolio: ' + id);
  saveState();
  return true;
}

// ─── BUILD CLIENT STATE ───
function getState() {
  const prices = {};
  Object.keys(COINS).forEach(sym => {
    const sd = marketData[sym];
    prices[sym] = {
      cur: sd.cur, type: COINS[sym].type, name: COINS[sym].name,
      candles: sd.candles.slice(-200),
      rsi: sd.rsi, macd: sd.macd, bb: sd.bb,
      ema9: sd.ema9, ema21: sd.ema21, ema50: sd.ema50, ema200: sd.ema200,
      stoch: sd.stoch, adx: sd.adx, vwap: sd.vwap, prevMacdHist: sd.prevMacdHist,
    };
  });

  const pfs = portfolios.map(pf => {
    const hVal = Object.entries(pf.holdings).reduce((s, [sym, h]) => s + ((h && h.qty) || 0) * ((marketData[sym] || {}).cur || 0), 0);
    return {
      id: pf.id, name: pf.name, color: pf.color, icon: pf.icon, desc: pf.desc,
      cash: pf.cash, startCash: pf.startCash, holdings: pf.holdings,
      orders: pf.orders.slice(0, 50),
      history: pf.history.slice(-300),
      tradeCount: pf.tradeCount, wins: pf.wins, losses: pf.losses,
      totalCommission: pf.totalCommission || 0,
      totalValue: pf.cash + hVal, hVal, pnl: pf.cash + hVal - pf.startCash,
      state: portfolioStates[pf.id] || 'RUNNING',
    };
  });

  // Include scoring info and profile configs for UI
  var profileConfigs = PROFILES.map(function(p) {
    return { id: p.id, buyThreshold: p.buyThreshold, sellThreshold: p.sellThreshold, cashPct: p.cashPct, assets: p.assets, overrides: p.overrides };
  });
  // Add DMA profile config for UI
  profileConfigs.push({ id: 'dma', buyThreshold: 0, sellThreshold: 0, cashPct: 0.15, assets: Object.keys(COINS), overrides: {} });

  return { prices: prices, portfolios: pfs, scores: lastScores, profiles: profileConfigs, signals: SIGNALS.map(function(s) { return { id: s.id, label: s.label, side: s.side, category: s.category, weight: s.weight }; }), tick: tickCount, serverTime: new Date().toISOString() };
}

// ─── HTTP SERVER ───
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'client.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading client.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getState()));
  } else if (req.url && req.url.indexOf('/api/reset/') === 0) {
    var resetId = req.url.replace('/api/reset/', '');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: resetPortfolio(resetId) }));
  } else if (req.url && req.url.match && req.url.match(/^\/api\/portfolio\/[^/]+\/export\/(csv|json)$/)) {
    // Portfolio export endpoints
    var urlParts = req.url.split('/');
    var exportPfId = urlParts[3];
    var exportFormat = urlParts[5];
    var exportPf = portfolios.find(function(p) { return p.id === exportPfId; });
    if (!exportPf) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Portfolio not found' }));
    } else if (exportFormat === 'json') {
      var hVal = Object.entries(exportPf.holdings).reduce(function(s, entry) {
        return s + ((entry[1] && entry[1].qty) || 0) * ((marketData[entry[0]] || {}).cur || 0);
      }, 0);
      var exportData = {
        id: exportPf.id, name: exportPf.name,
        cash: exportPf.cash, startCash: exportPf.startCash,
        totalValue: exportPf.cash + hVal,
        pnl: exportPf.cash + hVal - exportPf.startCash,
        tradeCount: exportPf.tradeCount, wins: exportPf.wins, losses: exportPf.losses,
        totalCommission: exportPf.totalCommission || 0,
        holdings: exportPf.holdings,
        orders: exportPf.orders,
        history: exportPf.history,
        exportedAt: new Date().toISOString(),
      };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="portfolio-' + exportPfId + '-' + new Date().toISOString().slice(0,10) + '.json"',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(exportData, null, 2));
    } else {
      // CSV export
      var csvOut = 'section,symbol,side,time,qty,price,total,avgCost,pnl,pnlPct,commission,strategy,reason,score,regime\n';
      // Holdings section
      Object.entries(exportPf.holdings).forEach(function(entry) {
        var sym = entry[0], h = entry[1];
        if (!h || h.qty <= 0) return;
        var curPrice = (marketData[sym] || {}).cur || 0;
        var val = h.qty * curPrice;
        var uPnl = (curPrice - h.avgCost) * h.qty;
        csvOut += ['holding', sym, '', '', h.qty.toFixed(6), curPrice.toFixed(2), val.toFixed(2), h.avgCost.toFixed(2), uPnl.toFixed(2), ((uPnl / (h.avgCost * h.qty)) * 100).toFixed(2), '', '', '', '', ''].join(',') + '\n';
        // Lots
        if (h.lots) {
          h.lots.forEach(function(lot) {
            var lotPnl = (curPrice - lot.cost) * lot.qty;
            csvOut += ['lot', sym, 'buy', lot.date || '', lot.qty.toFixed(6), lot.cost.toFixed(2), (lot.qty * lot.cost).toFixed(2), '', lotPnl.toFixed(2), ((lotPnl / (lot.cost * lot.qty)) * 100).toFixed(2), '', '', '', '', ''].join(',') + '\n';
          });
        }
      });
      // Trades section
      (exportPf.orders || []).forEach(function(o) {
        csvOut += ['trade', o.sym || '', o.side || '', o.time || '', (o.qty || 0).toFixed(6), (o.price || 0).toFixed(2), (o.total || 0).toFixed(2), o.avgCost || 0, o.pnl || 0, o.pnlPct || 0, o.commission || 0, '"' + (o.strat || '').replace(/"/g, '""') + '"', '"' + (o.why || '').replace(/"/g, '""') + '"', o.score || '', o.regime || ''].join(',') + '\n';
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="portfolio-' + exportPfId + '-' + new Date().toISOString().slice(0,10) + '.csv"',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(csvOut);
    }
  } else if (req.url === '/api/logs') {
    // Download all trade logs as CSV
    var csv = 'time,portfolio,symbol,side,qty,price,total,commission,pnl,pnlPct,avgCost,strategy,reason,score,regime,trend15m,exposure,volatility,rsi,macdHist,adx,cashBefore,cashAfter,holdingBefore,candleCount,blackSwan\n';
    portfolios.forEach(function(pf) {
      (pf.orders || []).forEach(function(o) {
        csv += [
          o.time || '', pf.id, o.sym || '', o.side || '', (o.qty || 0).toFixed(6),
          (o.price || 0).toFixed(2), (o.total || 0).toFixed(2), o.commission || '0',
          o.pnl || 0, o.pnlPct || 0, o.avgCost || 0,
          '"' + (o.strat || '').replace(/"/g, '""') + '"',
          '"' + (o.why || '').replace(/"/g, '""') + '"',
          o.score || '', o.regime || '', o.trend15m || '',
          o.exposure || '', o.volatility || '', o.rsi || '', o.macdHist || '', o.adx || '',
          o.cashBefore || '', o.cashAfter || '', o.holdingBefore || '',
          o.candleCount || '', o.blackSwan ? 'true' : 'false'
        ].join(',') + '\n';
      });
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="tradesimbot-logs-' + new Date().toISOString().slice(0,10) + '.csv"',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(csv);
  } else if (req.url === '/api/logs/json') {
    // Download all logs as JSON
    var logs = {};
    portfolios.forEach(function(pf) {
      logs[pf.id] = {
        name: pf.name, cash: pf.cash, startCash: pf.startCash,
        tradeCount: pf.tradeCount, wins: pf.wins, losses: pf.losses,
        totalCommission: pf.totalCommission || 0,
        holdings: pf.holdings, orders: pf.orders, history: pf.history,
      };
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="tradesimbot-logs-' + new Date().toISOString().slice(0,10) + '.json"',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(logs, null, 2));
  } else if (req.url === '/api/backtest/assets') {
    // Return available historical data files with date ranges
    var dataDir = path.join(__dirname, 'backtest', 'data');
    var assets = [];
    try {
      var files = fs.readdirSync(dataDir).filter(function(f) { return f.endsWith('_daily.csv'); });
      files.forEach(function(f) {
        try {
          var symbol = f.replace('_daily.csv', '');
          var content = fs.readFileSync(path.join(dataDir, f), 'utf8');
          var lines = content.split('\n').filter(function(l) { return l.trim().length > 0; });
          // Skip header URL line and column header line
          var dataLines = lines.slice(2);
          if (dataLines.length < 2) return;
          // CSV is sorted descending (newest first), so last data line is oldest
          var newest = dataLines[0].split(',')[1] || '';
          var oldest = dataLines[dataLines.length - 1].split(',')[1] || '';
          assets.push({ symbol: symbol, file: f, rows: dataLines.length, startDate: oldest.trim(), endDate: newest.trim() });
        } catch(e2) {}
      });
    } catch(e) {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(assets));
  } else if (req.method === 'POST' && req.url === '/api/backtest') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var params = JSON.parse(body);
        var profileId = params.profile || 'moderate';
        var symbols = params.symbols || [];
        var startDate = params.startDate || '2020-01-01';
        var startCash = params.startCash || 100000;

        var timeframe = params.timeframe || '1d';
        var isDmaBacktest = profileId === 'dma';
        var profile = PROFILES.find(function(p) { return p.id === profileId; });
        if (!profile && !isDmaBacktest) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unknown profile' })); return; }
        if (isDmaBacktest) {
          profile = { id: 'dma', buyThreshold: 0, sellThreshold: 0, cashPct: 0.15, assets: Object.keys(COINS), overrides: { slippage: 0.0005 } };
        }
        if (symbols.length === 0) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No symbols selected' })); return; }

        var dataDir = path.join(__dirname, 'backtest', 'data');
        var allCandles = {}; // { BTC: [ {date, open, high, low, close, volume}, ... ] }
        var allDates = {};
        var skippedSymbols = [];

        if (timeframe === '1m') {
          // ─── LOAD 1-MINUTE JSONL DATA ───
          var startTimestamp = new Date(startDate + 'T00:00:00Z').getTime();
          // 2 years of 1m data cutoff for very large files
          var twoYearsMs = 2 * 365.25 * 24 * 60 * 60 * 1000;

          symbols.forEach(function(sym) {
            var jsonlPath = path.join(dataDir, '1m', sym + '.jsonl');
            if (!fs.existsSync(jsonlPath)) {
              skippedSymbols.push(sym);
              return;
            }
            var stat = fs.statSync(jsonlPath);
            var content = fs.readFileSync(jsonlPath, 'utf8');
            var lines = content.split('\n');
            var candles = [];
            // If file > 500MB, compute cutoff to only keep last 2 years
            var sizeCutoffTs = 0;
            if (stat.size > 500 * 1024 * 1024) {
              // Find the last timestamp to compute 2-year window
              for (var li = lines.length - 1; li >= 0; li--) {
                var trimmed = lines[li].trim();
                if (trimmed.length === 0) continue;
                try { var lastObj = JSON.parse(trimmed); sizeCutoffTs = lastObj.t - twoYearsMs; } catch(e2) {}
                break;
              }
            }
            var effectiveStartTs = Math.max(startTimestamp, sizeCutoffTs);

            for (var li = 0; li < lines.length; li++) {
              var line = lines[li].trim();
              if (line.length === 0) continue;
              try {
                var obj = JSON.parse(line);
                if (obj.t < effectiveStartTs) continue;
                var candleDate = new Date(obj.t).toISOString().slice(0, 16);
                candles.push({
                  date: candleDate,
                  timestamp: obj.t,
                  open: obj.o || 0,
                  high: obj.h || 0,
                  low: obj.l || 0,
                  close: obj.c || 0,
                  volume: obj.v || 0,
                });
              } catch(e3) { /* skip malformed lines */ }
            }
            // Already sorted by timestamp in JSONL
            if (candles.length > 0) allCandles[sym] = candles;
          });

          // For 1m data: build a unified timestamp sequence across all symbols
          // Use the symbol with the most candles as the "clock"
          var clockSym = null;
          var maxLen = 0;
          Object.keys(allCandles).forEach(function(sym) {
            if (allCandles[sym].length > maxLen) { maxLen = allCandles[sym].length; clockSym = sym; }
          });
          if (!clockSym || maxLen < 200) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not enough 1m data (need 200+ candles). Skipped: ' + skippedSymbols.join(', ') })); return; }

          // Use clock symbol timestamps as sorted dates equivalent
          var sortedDates = allCandles[clockSym].map(function(c) { return c.timestamp; });

        } else {
          // ─── LOAD DAILY CSV DATA (original logic) ───
          symbols.forEach(function(sym) {
            var csvPath = path.join(dataDir, sym + '_daily.csv');
            if (!fs.existsSync(csvPath)) return;
            var content = fs.readFileSync(csvPath, 'utf8');
            var lines = content.split('\n').filter(function(l) { return l.trim().length > 0; });
            var dataLines = lines.slice(2); // skip header URL + column headers
            var candles = [];
            dataLines.forEach(function(line) {
              var parts = line.split(',');
              if (parts.length < 7) return;
              var date = (parts[1] || '').trim();
              if (date < startDate) return;
              candles.push({
                date: date,
                open: parseFloat(parts[3]) || 0,
                high: parseFloat(parts[4]) || 0,
                low: parseFloat(parts[5]) || 0,
                close: parseFloat(parts[6]) || 0,
                volume: parseFloat(parts[7]) || 0,
              });
              allDates[date] = true;
            });
            // Sort ascending by date
            candles.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
            if (candles.length > 0) allCandles[sym] = candles;
          });

          var sortedDates = Object.keys(allDates).sort();
          if (sortedDates.length < 30) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not enough data (need 30+ days)' })); return; }
        }

        // Build cumulative candle history per symbol for TA calculation
        var symHistory = {}; // { BTC: { closes:[], highs:[], lows:[], candles:[] } }
        var symDateIndex = {}; // { BTC: { "2022-01-01": 0, ... } } or { BTC: { timestamp: 0, ... } }
        symbols.forEach(function(sym) {
          if (!allCandles[sym]) return;
          symHistory[sym] = { closes: [], highs: [], lows: [], candles: [] };
          symDateIndex[sym] = {};
          if (timeframe === '1m') {
            allCandles[sym].forEach(function(c, i) {
              symDateIndex[sym][c.timestamp] = i;
            });
          } else {
            allCandles[sym].forEach(function(c, i) {
              symDateIndex[sym][c.date] = i;
            });
          }
        });

        // Backtest state
        var cash = startCash;
        var holdings = {}; // { BTC: { qty, avgCost } }
        var peaks = {}; // { BTC: peakPrice }
        var trades = [];
        var equityCurve = [];
        var wins = 0, losses = 0;
        var totalCommission = 0;
        var maxEquity = startCash;
        var maxDrawdown = 0;
        var buyThreshold = profile.buyThreshold || 3;
        var sellThreshold = profile.sellThreshold || 0.8;
        var cashPct = profile.cashPct || 0.10;
        // Per-symbol cooldown (in bars) - prevents overtrading
        // For 1m data, cooldowns are in minutes; for daily, in days
        var lastTradeDay = {}; // { BTC: dayIdx }
        var cooldownDays;
        if (timeframe === '1m') {
          cooldownDays = { conservative: 240, moderate: 120, aggressive: 60, yolo: 30 }; // minutes
        } else {
          cooldownDays = { conservative: 5, moderate: 3, aggressive: 2, yolo: 2 };
        }
        var symCooldown = cooldownDays[profileId] || 3;
        var holdUntil = {}; // { BTC: dayIdx } - minimum hold time per asset
        var minHoldDays;
        if (timeframe === '1m') {
          minHoldDays = { crypto: 60, stock: 120, commodity: 240 }; // minutes
        } else {
          minHoldDays = { crypto: 2, stock: 3, commodity: 5 };
        }
        var dailyTradeLimit = { conservative: 2, moderate: 3, aggressive: 5, yolo: 8 };
        var dailyTradeCount = {}; // { "2022-01-15": 3 }
        var cbThresholds = { conservative: 0.10, moderate: 0.15, aggressive: 0.20, yolo: 0.30 };
        var cbCooldownDays = timeframe === '1m' ? 1440 * 10 : 10; // 10 days in minutes or days
        var cbTriggeredDay = -999;
        var dmaState = null; // For DMA backtest: { bought1, bought2, sold1, sold2 }
        var cbTriggerCount = 0;
        var cbMaxTriggers = 3; // After 3 circuit breaker hits, stop permanently

        // Track buy & hold for comparison
        var buyHoldStart = {};
        var buyHoldStartCash = startCash;

        // Equity curve sampling for 1m: only record every N candles
        var eqSampleInterval = timeframe === '1m' ? 1440 : 1; // 1440 minutes = ~1 day

        // Process each date/timestamp
        sortedDates.forEach(function(dateKey, dayIdx) {

          // For 1m, dateKey is a timestamp number; for daily, it's a date string
          var displayDate = timeframe === '1m' ? new Date(dateKey).toISOString().slice(0, 16) : dateKey;
          // For daily trade limit, group by calendar day
          var calendarDay = timeframe === '1m' ? new Date(dateKey).toISOString().slice(0, 10) : dateKey;

          // For each symbol, build up history and compute indicators
          var symData = {}; // { BTC: { sd-like object } }
          symbols.forEach(function(sym) {
            if (!allCandles[sym] || symDateIndex[sym][dateKey] === undefined) return;
            var idx = symDateIndex[sym][dateKey];
            var c = allCandles[sym][idx];
            var sh = symHistory[sym];
            sh.closes.push(c.close);
            sh.highs.push(c.high);
            sh.lows.push(c.low);
            sh.candles.push({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, t: displayDate });

            if (sh.closes.length < 5) return;

            var closes = sh.closes;
            var highs = sh.highs;
            var lows = sh.lows;
            var rsi = calcRSI(closes);
            var macd = calcMACD(closes);
            var bb = calcBB(closes);
            var ema9val = ema(closes, 9) || c.close;
            var ema21val = ema(closes, 21) || c.close;
            var ema50val = ema(closes, 50) || c.close;
            var ema200val = ema(closes, 200) || c.close;
            var stoch = calcStoch(highs, lows, closes);
            var adx = calcADX(highs, lows, closes);
            var vwap = closes.length > 0 ? closes.reduce(function(a, b) { return a + b; }, 0) / closes.length : c.close;

            // Previous MACD hist (for cross detection)
            var prevMacdHist = 0;
            if (sh.closes.length > 26) {
              var prevCloses = sh.closes.slice(0, -1);
              var prevMacd = calcMACD(prevCloses);
              prevMacdHist = prevMacd.hist || 0;
            }

            symData[sym] = {
              cur: c.close,
              candles: sh.candles,
              rsi: rsi,
              macd: macd,
              bb: bb,
              ema9: ema9val,
              ema21: ema21val,
              ema50: ema50val,
              ema200: ema200val,
              stoch: stoch,
              adx: adx,
              vwap: vwap,
              prevMacdHist: prevMacdHist,
            };

            // Store buy & hold start prices
            if (!buyHoldStart[sym] && c.close > 0) {
              buyHoldStart[sym] = c.close;
            }
          });

          // ─── DMA BACKTEST: simple EMA21/EMA50 crossover ───
          if (isDmaBacktest) {
            // DMA Strategy: BTC only, EMA200, two-tranche buy/sell at ±1% and ±2%
            var dmaSym = 'BTC';
            var dmaSD = symData[dmaSym];
            if (dmaSD && dmaSD.candles.length >= 200) {
              var dmaCloses = dmaSD.candles.map(function(c) { return c.c; });
              var ema200val = ema(dmaCloses, 200);
              if (ema200val && ema200val > 0) {
                var price = dmaSD.cur;
                if (price > 0) {
                  var dmaPos = holdings[dmaSym];
                  var dmaPosQty = (dmaPos && dmaPos.qty) || 0;
                  var dmaHalf = startCash * 0.50;
                  var distPct = ((price - ema200val) / ema200val) * 100;
                  var COMM = 0.001;

                  if (!dmaState) dmaState = { bought1: false, bought2: false, sold1: false, sold2: false };

                  // BUY Level 1: price 1% below EMA200
                  if (distPct <= -0.5 && !dmaState.bought1 && cash >= dmaHalf * 0.5) {
                    var buyVal = Math.min(dmaHalf, cash * 0.98);
                    var qty = buyVal / price;
                    var comm = buyVal * COMM;
                    cash -= buyVal + comm;
                    totalCommission += comm;
                    if (!holdings[dmaSym]) holdings[dmaSym] = { qty: 0, avgCost: 0 };
                    var h = holdings[dmaSym];
                    h.avgCost = h.qty > 0 ? ((h.avgCost * h.qty) + (price * qty)) / (h.qty + qty) : price;
                    h.qty += qty;
                    trades.push({ date: displayDate, side: 'buy', symbol: dmaSym, price: +price.toFixed(2), qty: +qty.toFixed(6), total: +buyVal.toFixed(2), pnl: 0, pnlPct: 0, reason: 'EMA200 -' + Math.abs(distPct).toFixed(1) + '% (1st tranche $50K)', regime: 'dma', commission: +comm.toFixed(2) });
                    dmaState.bought1 = true;
                    dmaState.sold1 = false;
                    dmaState.sold2 = false;
                  }
                  // BUY Level 2: price 2% below EMA200
                  if (distPct <= -1.0 && dmaState.bought1 && !dmaState.bought2 && cash >= dmaHalf * 0.3) {
                    var buyVal = Math.min(dmaHalf, cash * 0.98);
                    var qty = buyVal / price;
                    var comm = buyVal * COMM;
                    cash -= buyVal + comm;
                    totalCommission += comm;
                    if (!holdings[dmaSym]) holdings[dmaSym] = { qty: 0, avgCost: 0 };
                    var h = holdings[dmaSym];
                    h.avgCost = h.qty > 0 ? ((h.avgCost * h.qty) + (price * qty)) / (h.qty + qty) : price;
                    h.qty += qty;
                    trades.push({ date: displayDate, side: 'buy', symbol: dmaSym, price: +price.toFixed(2), qty: +qty.toFixed(6), total: +buyVal.toFixed(2), pnl: 0, pnlPct: 0, reason: 'EMA200 -' + Math.abs(distPct).toFixed(1) + '% (2nd tranche FULL)', regime: 'dma', commission: +comm.toFixed(2) });
                    dmaState.bought2 = true;
                  }
                  // SELL Level 1: price 1% above EMA200 → sell $50K worth
                  if (distPct >= 0.5 && !dmaState.sold1 && dmaPosQty > 0) {
                    var sellQty = Math.min(dmaHalf / price, dmaPosQty);
                    var sellVal = sellQty * price;
                    var comm = sellVal * COMM;
                    cash += sellVal - comm;
                    totalCommission += comm;
                    var pnl = (price - dmaPos.avgCost) * sellQty;
                    if (pnl > 0) wins++; else losses++;
                    trades.push({ date: displayDate, side: 'sell', symbol: dmaSym, price: +price.toFixed(2), qty: +sellQty.toFixed(6), total: +sellVal.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +((pnl / (dmaPos.avgCost * sellQty)) * 100).toFixed(2), reason: 'EMA200 +' + distPct.toFixed(1) + '% (1st sell $50K)', regime: 'dma', commission: +comm.toFixed(2) });
                    dmaPos.qty -= sellQty;
                    if (dmaPos.qty <= 0.000001) delete holdings[dmaSym];
                    dmaState.sold1 = true;
                    dmaState.bought1 = false;
                    dmaState.bought2 = false;
                  }
                  // SELL Level 2: price 2% above EMA200
                  if (distPct >= 1.0 && dmaState.sold1 && !dmaState.sold2 && holdings[dmaSym] && holdings[dmaSym].qty > 0) {
                    var remPos = holdings[dmaSym];
                    var sellQty = remPos.qty;
                    var sellVal = sellQty * price;
                    var comm = sellVal * COMM;
                    cash += sellVal - comm;
                    totalCommission += comm;
                    var pnl = (price - remPos.avgCost) * sellQty;
                    if (pnl > 0) wins++; else losses++;
                    trades.push({ date: displayDate, side: 'sell', symbol: dmaSym, price: +price.toFixed(2), qty: +sellQty.toFixed(6), total: +sellVal.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +((pnl / (remPos.avgCost * sellQty)) * 100).toFixed(2), reason: 'EMA200 +' + distPct.toFixed(1) + '% (2nd sell 100% CASH)', regime: 'dma', commission: +comm.toFixed(2) });
                    delete holdings[dmaSym];
                    dmaState.sold2 = true;
                  }
                }
              }
            }
          } else {
          // Now run signal evaluation for each symbol (scoring system)
          symbols.forEach(function(sym) {
            // Daily trade limit check
            if ((dailyTradeCount[calendarDay] || 0) >= (dailyTradeLimit[profileId] || 3)) return;

            var sd = symData[sym];
            if (!sd || sd.candles.length < 30) return;
            var regime = detectRegime(sd);
            if (regime.type === 'warming up') return;
            var pos = holdings[sym];
            var peakPrice = peaks[sym];
            var price = sd.cur;
            if (price <= 0) return;

            // Circuit breaker cooldown check
            if (dayIdx - cbTriggeredDay < cbCooldownDays) return;
            // Permanent stop after 3 circuit breaker hits
            if (cbTriggerCount >= cbMaxTriggers) return;

            // Per-symbol cooldown: skip scoring signals if traded too recently
            // Risk sells (TP/SL/Trailing) still checked below via riskSellTriggered
            var assetType = COINS[sym] ? COINS[sym].type : 'stock';
            var typeCooldown = { crypto: symCooldown, stock: symCooldown * 2, commodity: symCooldown * 3 };
            var effectiveCooldown = typeCooldown[assetType] || symCooldown;
            var inCooldown = lastTradeDay[sym] !== undefined && (dayIdx - lastTradeDay[sym]) < effectiveCooldown;

            // Regime-based weight multipliers (same as live: profile-specific + linear interpolation)
            var profileRegime = {
              conservative: { trendHigh: 2.0, trendLow: 0.3, mrHigh: 2.0, mrLow: 0.3 },
              moderate:     { trendHigh: 1.5, trendLow: 0.5, mrHigh: 1.5, mrLow: 0.5 },
              aggressive:   { trendHigh: 1.3, trendLow: 0.6, mrHigh: 1.3, mrLow: 0.6 },
              yolo:         { trendHigh: 1.2, trendLow: 0.8, mrHigh: 1.2, mrLow: 0.8 },
            };
            var pr = profileRegime[profileId] || profileRegime.moderate;
            var adxVal = regime.adx || 20;
            var trendMult, meanRevMult;
            if (adxVal >= 25) { trendMult = pr.trendHigh; meanRevMult = pr.mrLow; }
            else if (adxVal <= 18) { trendMult = pr.trendLow; meanRevMult = pr.mrHigh; }
            else { var t = (adxVal - 18) / 7; trendMult = pr.trendLow + t * (pr.trendHigh - pr.trendLow); meanRevMult = pr.mrHigh + t * (pr.mrLow - pr.mrHigh); }
            var rangingDowntrend = adxVal <= 18 && sd.ema21 > 0 && sd.cur < sd.ema21;
            if (rangingDowntrend) meanRevMult = pr.mrLow;
            var regimeMultipliers = {
              'trend': trendMult, 'momentum': trendMult,
              'mean-reversion': meanRevMult,
              'neutral': 1.0, 'pattern': 1.0, 'combo': 1.2, 'risk': 0,
            };

            // Score signals with category cap (same as live)
            var buyScore = 0, sellScore = 0;
            var buyReasons = [], sellReasons = [];
            var riskSellTriggered = null;
            var buyCatScores = {};
            var sellCatScores = {};

            SIGNALS.forEach(function(sig) {
              var val = (profile.overrides && profile.overrides[sig.id] !== undefined) ? profile.overrides[sig.id] : 30;

              // Asset-type adjustment for TP/SL/trailing
              if (sig.category === 'risk') {
                var riskAssetType = (COINS[sym] && COINS[sym].type) || 'crypto';
                if (riskAssetType === 'stock') val = val * 0.7;
                else if (riskAssetType === 'commodity') val = val * 0.5;
              }

              var result = evalSignal(sig.id, val, sd, pos, peakPrice);
              if (!result) return;

              if (sig.category === 'risk') {
                if (pos && pos.qty > 0) riskSellTriggered = result;
                return;
              }

              var regimeMult = regimeMultipliers[sig.category] || 1.0;
              var weightedScore = sig.weight * regimeMult;

              if (sig.side === 'buy') {
                var catKey = sig.category;
                buyCatScores[catKey] = (buyCatScores[catKey] || 0) + weightedScore;
                if (buyCatScores[catKey] <= CATEGORY_CAP) {
                  buyScore += weightedScore;
                }
                buyReasons.push(result);
              } else {
                var catKey2 = sig.category;
                sellCatScores[catKey2] = (sellCatScores[catKey2] || 0) + weightedScore;
                if (sellCatScores[catKey2] <= CATEGORY_CAP) {
                  sellScore += weightedScore;
                }
                sellReasons.push(result);
              }
            });

            // Exposure calculation
            var holdingValue = Object.keys(holdings).reduce(function(s, hs) {
              var h = holdings[hs];
              var hPrice = (symData[hs] && symData[hs].cur) || 0;
              return s + ((h && h.qty) || 0) * hPrice;
            }, 0);
            var totalValue = cash + holdingValue;
            var exposurePct = totalValue > 0 ? holdingValue / totalValue : 0;
            var maxExposure = { conservative: 0.75, moderate: 0.85, aggressive: 0.92, yolo: 0.98 }[profile.id] || 0.80;

            if (exposurePct >= maxExposure) {
              buyScore = 0;
              sellScore += 1.5;
              sellReasons.push('Over-exposed');
            }

            // Volatility adjustment
            var volAdjust = regime.volatility > 3 ? 0.5 : (regime.volatility > 2 ? 0.75 : 1.0);
            var btSlippage = (profile.overrides && profile.overrides.slippage !== undefined) ? profile.overrides.slippage : SLIPPAGE_PCT;
            var minCashReserve = startCash * 0.02;
            var availableCash = Math.max(0, cash - minCashReserve);

            // Risk sell (TP/SL/Trailing)
            if (riskSellTriggered && pos && pos.qty > 0) {
              var riskFillP = price * (1 - btSlippage);
              var riskQty = pos.qty;
              var riskTotal = riskFillP * riskQty;
              var riskComm = riskTotal * COMMISSION_RATE;
              cash += riskTotal - riskComm;
              totalCommission += riskComm;
              var riskPnl = (riskFillP - pos.avgCost) * riskQty;
              if (riskPnl > 0) wins++; else losses++;
              trades.push({
                date: displayDate, side: 'sell', symbol: sym, price: +riskFillP.toFixed(2),
                signalPrice: +price.toFixed(2), slippage: btSlippage,
                qty: +riskQty.toFixed(6), total: +riskTotal.toFixed(2),
                pnl: +riskPnl.toFixed(2), pnlPct: +((riskPnl / (pos.avgCost * riskQty)) * 100).toFixed(2),
                reason: riskSellTriggered, regime: regime.type,
                commission: +riskComm.toFixed(2),
              });
              delete holdings[sym];
              delete peaks[sym];
              lastTradeDay[sym] = dayIdx;
              dailyTradeCount[calendarDay] = (dailyTradeCount[calendarDay] || 0) + 1;
              return;
            }

            // Scoring-based buy (skip if in cooldown)
            if (!inCooldown && buyScore >= buyThreshold && buyScore > sellScore && exposurePct < maxExposure) {
              if (availableCash < 100) return;
              // Max position count limit
              var openPositionCount = Object.keys(holdings).filter(function(k) { return holdings[k] && holdings[k].qty > 0; }).length;
              var maxPositions = { conservative: 3, moderate: 5, aggressive: 8, yolo: 12 }[profileId] || 5;
              if (openPositionCount >= maxPositions) return;
              var btBuyFill = price * (1 + btSlippage);
              var tradeValue = Math.min(availableCash * cashPct, availableCash * 0.95);
              // Max per-position capital
              var maxPerPosition = { conservative: 0.15, moderate: 0.12, aggressive: 0.10, yolo: 0.08 }[profileId] || 0.10;
              tradeValue = Math.min(tradeValue, startCash * maxPerPosition);
              var tq = +(tradeValue / btBuyFill).toFixed(6);
              if (tq <= 0) return;
              var total = btBuyFill * tq;
              var commission = total * COMMISSION_RATE;
              if (total + commission > availableCash) return;
              // Commission-aware trade gate: expected profit must exceed 2x trade cost
              var expectedTpPct = (profile.overrides && profile.overrides.tp_pct) || 5;
              var expectedProfit = total * (expectedTpPct / 100);
              var tradeCost = total * COMMISSION_RATE * 2;
              if (expectedProfit < tradeCost * 2) return;
              cash -= total + commission;
              totalCommission += commission;
              var old = holdings[sym] || { qty: 0, avgCost: 0 };
              var nq = +(old.qty + tq).toFixed(6);
              holdings[sym] = { qty: nq, avgCost: nq > 0 ? (old.avgCost * old.qty + total) / nq : btBuyFill };
              peaks[sym] = price;
              var buyAssetType = COINS[sym] ? COINS[sym].type : 'stock';
              holdUntil[sym] = dayIdx + (minHoldDays[buyAssetType] || 3);
              var btTpPct = (profile.overrides && profile.overrides.tp_pct !== undefined) ? profile.overrides.tp_pct : 2.0;
              var btSlPct = (profile.overrides && profile.overrides.sl_pct !== undefined) ? profile.overrides.sl_pct : 1.0;
              trades.push({
                date: displayDate, side: 'buy', symbol: sym, price: +btBuyFill.toFixed(2),
                signalPrice: +price.toFixed(2), slippage: btSlippage,
                bracketTP: +(btBuyFill * (1 + btTpPct / 100)).toFixed(2),
                bracketSL: +(btBuyFill * (1 - btSlPct / 100)).toFixed(2),
                qty: +tq.toFixed(6), total: +total.toFixed(2),
                pnl: 0, pnlPct: 0,
                reason: buyReasons.join(', '), regime: regime.type,
                commission: +commission.toFixed(2),
              });
              lastTradeDay[sym] = dayIdx;
              dailyTradeCount[calendarDay] = (dailyTradeCount[calendarDay] || 0) + 1;
            }
            // Scoring-based sell (skip if in cooldown or minimum hold not met)
            else if (!inCooldown && sellScore >= sellThreshold && pos && pos.qty > 0 && (!holdUntil[sym] || dayIdx >= holdUntil[sym])) {
              var btSellFill = price * (1 - btSlippage);
              var sq = pos.qty;
              var sellTotal = btSellFill * sq;
              var sellComm = sellTotal * COMMISSION_RATE;
              cash += sellTotal - sellComm;
              totalCommission += sellComm;
              var sellPnl = (btSellFill - pos.avgCost) * sq;
              if (sellPnl > 0) wins++; else losses++;
              trades.push({
                date: displayDate, side: 'sell', symbol: sym, price: +btSellFill.toFixed(2),
                signalPrice: +price.toFixed(2), slippage: btSlippage,
                qty: +sq.toFixed(6), total: +sellTotal.toFixed(2),
                pnl: +sellPnl.toFixed(2), pnlPct: +((sellPnl / (pos.avgCost * sq)) * 100).toFixed(2),
                reason: sellReasons.join(', '), regime: regime.type,
                commission: +sellComm.toFixed(2),
              });
              delete holdings[sym];
              delete peaks[sym];
              lastTradeDay[sym] = dayIdx;
              dailyTradeCount[calendarDay] = (dailyTradeCount[calendarDay] || 0) + 1;
            }

            // Update peak tracking
            if (holdings[sym] && price > (peaks[sym] || 0)) {
              peaks[sym] = price;
            }
          });
          } // end else (scoring system)

          // Calculate equity at end of day
          var dayHoldingValue = Object.keys(holdings).reduce(function(s, hs) {
            var h = holdings[hs];
            var hPrice = (symData[hs] && symData[hs].cur) || 0;
            return s + ((h && h.qty) || 0) * hPrice;
          }, 0);
          var equity = cash + dayHoldingValue;
          // For 1m data, only sample equity curve every eqSampleInterval candles
          if (timeframe === '1m') {
            if (dayIdx % eqSampleInterval === 0 || dayIdx === sortedDates.length - 1) {
              equityCurve.push({ date: displayDate, value: +equity.toFixed(2) });
            }
          } else {
            equityCurve.push({ date: displayDate, value: +equity.toFixed(2) });
          }

          // Reset peak after circuit breaker cooldown ends — prevents infinite re-trigger
          if (cbTriggeredDay > 0 && dayIdx === cbTriggeredDay + cbCooldownDays) {
            maxEquity = equity; // Fresh start, DD measured from current level
          }

          // Max drawdown tracking
          if (equity > maxEquity) maxEquity = equity;
          var dd = (maxEquity - equity) / maxEquity;
          if (dd > maxDrawdown) maxDrawdown = dd;

          // Circuit breaker: temporary pause if drawdown exceeds profile threshold
          var cbThreshold = cbThresholds[profileId] || 0.20;
          if (dd > cbThreshold && dayIdx - cbTriggeredDay >= cbCooldownDays) {
            // Close all positions and enter cooldown
            Object.keys(holdings).forEach(function(cbSym) {
              var cbPos = holdings[cbSym];
              if (!cbPos || cbPos.qty <= 0) return;
              var cbPrice = (symData[cbSym] && symData[cbSym].cur) || 0;
              if (cbPrice <= 0) return;
              var cbSlippage = (profile.overrides && profile.overrides.slippage !== undefined) ? profile.overrides.slippage : SLIPPAGE_PCT;
              var cbFillPrice = cbPrice * (1 - cbSlippage);
              var cbTotal = cbFillPrice * cbPos.qty;
              var cbComm = cbTotal * COMMISSION_RATE;
              cash += cbTotal - cbComm;
              totalCommission += cbComm;
              var cbPnl = (cbFillPrice - cbPos.avgCost) * cbPos.qty;
              if (cbPnl > 0) wins++; else losses++;
              trades.push({
                date: displayDate, side: 'sell', symbol: cbSym, price: +cbFillPrice.toFixed(2),
                signalPrice: +cbPrice.toFixed(2), slippage: cbSlippage,
                qty: +cbPos.qty.toFixed(6), total: +cbTotal.toFixed(2),
                pnl: +cbPnl.toFixed(2), pnlPct: +((cbPnl / (cbPos.avgCost * cbPos.qty)) * 100).toFixed(2),
                reason: 'Circuit Breaker - Drawdown > ' + (cbThreshold * 100).toFixed(0) + '% (pausing ' + (timeframe === '1m' ? Math.round(cbCooldownDays / 1440) : cbCooldownDays) + ' days)', regime: 'circuit-break',
                commission: +cbComm.toFixed(2),
              });
            });
            holdings = {};
            cbTriggeredDay = dayIdx;
            cbTriggerCount++;
          }
        });

        // Close all remaining open positions at last known price
        var openPositionsClosed = 0;
        Object.keys(holdings).forEach(function(sym) {
          var pos = holdings[sym];
          if (!pos || pos.qty <= 0) return;
          var lastCandles = allCandles[sym];
          var lastPrice = lastCandles && lastCandles.length > 0 ? lastCandles[lastCandles.length - 1].close : 0;
          if (lastPrice <= 0) return;
          var lastDate = lastCandles[lastCandles.length - 1].date;
          var btSlippage = (profile.overrides && profile.overrides.slippage !== undefined) ? profile.overrides.slippage : SLIPPAGE_PCT;
          var closeFillPrice = lastPrice * (1 - btSlippage);
          var closeQty = pos.qty;
          var closeTotal = closeFillPrice * closeQty;
          var closeComm = closeTotal * COMMISSION_RATE;
          cash += closeTotal - closeComm;
          totalCommission += closeComm;
          var closePnl = (closeFillPrice - pos.avgCost) * closeQty;
          if (closePnl > 0) wins++; else losses++;
          trades.push({
            date: lastDate, side: 'sell', symbol: sym, price: +closeFillPrice.toFixed(2),
            signalPrice: +lastPrice.toFixed(2), slippage: btSlippage,
            qty: +closeQty.toFixed(6), total: +closeTotal.toFixed(2),
            pnl: +closePnl.toFixed(2), pnlPct: +((closePnl / (pos.avgCost * closeQty)) * 100).toFixed(2),
            reason: 'Backtest End - Position Closed', regime: 'end',
            commission: +closeComm.toFixed(2),
          });
          openPositionsClosed++;
        });
        holdings = {};

        // Final equity - after closing all positions, cash IS the final equity
        var finalEquity = +cash.toFixed(2);
        // Update last equity curve point to reflect final closed value
        if (equityCurve.length > 0) {
          equityCurve[equityCurve.length - 1].value = finalEquity;
        }
        var totalReturn = (finalEquity - startCash) / startCash;

        // Buy & hold comparison
        var buyHoldValue = 0;
        var buyHoldSymCount = Object.keys(buyHoldStart).length;
        if (buyHoldSymCount > 0) {
          var perSymCash = buyHoldStartCash / buyHoldSymCount;
          Object.keys(buyHoldStart).forEach(function(sym) {
            var startPrice = buyHoldStart[sym];
            var endCandles = allCandles[sym];
            var endPrice = endCandles && endCandles.length > 0 ? endCandles[endCandles.length - 1].close : startPrice;
            buyHoldValue += perSymCash * (endPrice / startPrice);
          });
        }
        var buyHoldReturn = buyHoldSymCount > 0 ? (buyHoldValue - buyHoldStartCash) / buyHoldStartCash : 0;

        // Sharpe ratio (annualized from period returns)
        // For 1m data, equity curve is sampled every 1440 candles (~1 day), so annualize with sqrt(252)
        var periodReturns = [];
        for (var di = 1; di < equityCurve.length; di++) {
          var prevVal = equityCurve[di - 1].value;
          if (prevVal > 0) periodReturns.push(Math.log(equityCurve[di].value / prevVal));
        }
        var avgReturn = periodReturns.length > 0 ? periodReturns.reduce(function(a, b) { return a + b; }, 0) / periodReturns.length : 0;
        var stdReturn = 0;
        if (periodReturns.length > 1) {
          var variance = periodReturns.reduce(function(a, b) { return a + Math.pow(b - avgReturn, 2); }, 0) / (periodReturns.length - 1);
          stdReturn = Math.sqrt(variance);
        }
        // Equity curve samples are ~daily for both timeframes (1m samples every 1440 candles)
        var sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

        // Build price history per symbol (downsampled for chart)
        var priceHistory = {};
        symbols.forEach(function(sym) {
          if (!allCandles[sym]) return;
          var candles = allCandles[sym];
          var step = candles.length > 500 ? Math.ceil(candles.length / 500) : 1;
          var sampled = [];
          for (var pi = 0; pi < candles.length; pi += step) {
            sampled.push({ date: candles[pi].date, o: +candles[pi].open.toFixed(2), h: +candles[pi].high.toFixed(2), l: +candles[pi].low.toFixed(2), c: +candles[pi].close.toFixed(2), v: +candles[pi].volume.toFixed(2) });
          }
          // Always include last candle
          if (sampled.length > 0 && sampled[sampled.length - 1].date !== candles[candles.length - 1].date) {
            var lc = candles[candles.length - 1];
            sampled.push({ date: lc.date, o: +lc.open.toFixed(2), h: +lc.high.toFixed(2), l: +lc.low.toFixed(2), c: +lc.close.toFixed(2), v: +lc.volume.toFixed(2) });
          }
          priceHistory[sym] = sampled;
        });

        var result = {
          metrics: {
            totalReturn: +(totalReturn * 100).toFixed(2),
            winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : 0,
            maxDrawdown: +(maxDrawdown * 100).toFixed(2),
            sharpe: +sharpe.toFixed(3),
            totalTrades: wins + losses,
            totalOrders: trades.length,
            buys: trades.filter(function(t){return t.side==='buy';}).length,
            sells: trades.filter(function(t){return t.side==='sell';}).length,
            wins: wins,
            losses: losses,
            totalCommission: +totalCommission.toFixed(2),
            finalEquity: +finalEquity.toFixed(2),
            startCash: startCash,
            buyHoldReturn: +(buyHoldReturn * 100).toFixed(2),
            days: sortedDates.length,
            openPositionsClosed: openPositionsClosed,
            circuitBreakerTriggered: cbTriggerCount > 0,
            circuitBreakerCount: cbTriggerCount,
          },
          equityCurve: equityCurve,
          trades: trades,
          priceHistory: priceHistory,
          profile: profileId,
          symbols: symbols,
          startDate: startDate,
          timeframe: timeframe,
          skippedSymbols: skippedSymbols,
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── WEBSOCKET ───
const wss = new WebSocket.Server({ server });
wss.on('connection', function(ws) {
  console.log('Client connected. Total: ' + wss.clients.size);
  ws.send(JSON.stringify({ type: 'init', data: getState() }));
  ws.on('message', function(raw) {
    try {
      var msg = JSON.parse(raw);
      if (msg.type === 'reset' && msg.id) {
        resetPortfolio(msg.id);
        broadcast();
      }
      if (msg.type === 'resume' && msg.id) {
        resumePortfolio(msg.id);
        broadcast();
      }
      if (msg.type === 'updateConfig' && msg.id) {
        var prof = PROFILES.find(function(p) { return p.id === msg.id; });
        if (prof) {
          if (msg.overrides) Object.keys(msg.overrides).forEach(function(k) { prof.overrides[k] = msg.overrides[k]; });
          if (msg.buyThreshold !== undefined) prof.buyThreshold = msg.buyThreshold;
          if (msg.sellThreshold !== undefined) prof.sellThreshold = msg.sellThreshold;
          if (msg.cashPct !== undefined) prof.cashPct = msg.cashPct;
          if (msg.assets !== undefined) {
            prof.assets = msg.assets;
            // Rebuild strategies for this profile
            var pf = portfolios.find(function(p) { return p.id === msg.id; });
            if (pf) pf.strategies = buildStrategies(prof);
            console.log('[' + new Date().toLocaleTimeString() + '] Assets updated for ' + msg.id + ': ' + msg.assets.length + ' assets');
          }
          console.log('[' + new Date().toLocaleTimeString() + '] Config updated: ' + msg.id);
          broadcast();
        }
      }
    } catch(e) {}
  });
  ws.on('close', function() { console.log('Client disconnected. Total: ' + wss.clients.size); });
});

function broadcast() {
  const state = JSON.stringify({ type: 'update', data: getState() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

// ─── START ───
async function start() {
  console.log('Fetching initial real prices...');
  await fetchRealPrices();

  // Update market data with real prices
  Object.keys(lastPrices).forEach(sym => {
    if (marketData[sym] && lastPrices[sym]) {
      marketData[sym].cur = lastPrices[sym];
      marketData[sym].building = { o: lastPrices[sym], h: lastPrices[sym], l: lastPrices[sym], c: lastPrices[sym], v: 0, tickCount: 0 };
      marketData[sym].vwap = lastPrices[sym];
    }
  });

  // Rebuild strategies with real prices for proper qty sizing
  var dmaPfSaved = portfolios.find(function(p) { return p.id === 'dma'; });
  portfolios = PROFILES.map(p => ({
    ...portfolios.find(pf => pf.id === p.id),
    actives: buildStrategies(p),
  }));
  // Re-add DMA portfolio (not in PROFILES)
  if (dmaPfSaved) portfolios.push(dmaPfSaved);

  // Restore saved state (portfolios, candles, indicators)
  const restored = loadState();

  server.listen(PORT, () => {
    console.log('\n  TradeSimBot Server running at http://localhost:' + PORT);
    var cryptoCount = Object.values(COINS).filter(function(c) { return c.type === 'crypto'; }).length;
    var stockCount = Object.values(COINS).filter(function(c) { return c.type === 'stock'; }).length;
    console.log('  BTC: $' + (lastPrices.BTC || 'N/A') + ' | ETH: $' + (lastPrices.ETH || 'N/A'));
    console.log('  5 portfolios (4 scoring + 1 DMA) | ' + cryptoCount + ' crypto + ' + stockCount + ' stocks | 1min candles');
    if (restored) console.log('  State restored from disk');
    console.log('');
  });

  // Connect Binance WebSocket for real-time crypto
  connectBinance();

  // Price ticks (updates candles + runs strategies)
  setInterval(priceTick, TICK_MS);

  // Broadcast to WebSocket clients every 2 seconds
  setInterval(broadcast, TICK_MS);

  // CoinGecko as fallback every 60 seconds
  setInterval(fetchCoinGeckoPrices, 60000);

  // Save state to disk every 30 seconds
  setInterval(saveState, STATE_SAVE_INTERVAL);

  // Save state on shutdown
  process.on('SIGINT', () => { saveState(); console.log('\nState saved. Goodbye!'); process.exit(0); });
  process.on('SIGTERM', () => { saveState(); process.exit(0); });
}

start();
