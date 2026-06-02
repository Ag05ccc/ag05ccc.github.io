// ─── SHARED ENGINE CORE ───
// Single source of truth for asset definitions, TA functions, signal definitions,
// the signal evaluator, regime detection, and portfolio profiles. Required by both
// the live server (server.js) and the backtest CLI (backtest/backtest.js) so the
// backtest provably runs the SAME strategy logic as live trading. Previously these
// were hand-duplicated across files and had silently drifted (different VWAP,
// category-cap, dynamic-TP, and profile thresholds), so "backtested" weights no
// longer matched what ran live. Keep all pure strategy logic here.
'use strict';

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
// True Wilder ADX: tracks +DM and -DM (not just up-moves), Wilder-smooths TR/+DM/-DM
// into +DI/-DI, then DX = 100*|+DI - -DI|/(+DI + -DI), and ADX = Wilder average of DX.
// (Previously this returned a directional, upward-biased mean of +DM/TR that
// mislabelled strong downtrends as "ranging".) NOTE: the regime thresholds in
// detectRegime (18/25) were tuned against the old metric and may warrant re-tuning.
function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2 + 1) return 20; // need warmup for DI smoothing + ADX smoothing
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDMs.push((up > down && up > 0) ? up : 0);
    minusDMs.push((down > up && down > 0) ? down : 0);
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  if (trs.length < period * 2) return 20;
  function wilderSmooth(arr) {
    const sm = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    sm.push(sum);
    for (let i = period; i < arr.length; i++) { sum = sum - sum / period + arr[i]; sm.push(sum); }
    return sm;
  }
  const trS = wilderSmooth(trs), pdmS = wilderSmooth(plusDMs), mdmS = wilderSmooth(minusDMs);
  const dxs = [];
  for (let i = 0; i < trS.length; i++) {
    const tr = trS[i] || 1e-9;
    const plusDI = (pdmS[i] / tr) * 100;
    const minusDI = (mdmS[i] / tr) * 100;
    const diSum = plusDI + minusDI;
    dxs.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }
  if (dxs.length < period) return dxs.length ? dxs.reduce((a, b) => a + b, 0) / dxs.length : 20;
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]) / period;
  return adx;
}

function calcATR(highs, lows, closes, period = 14) {
  var n = closes.length;
  if (n < period + 1) return 0;
  var trs = [];
  for (var i = 1; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  if (trs.length < period) return 0;
  var atr = trs.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (var j = period; j < trs.length; j++) atr = ((atr * (period - 1)) + trs[j]) / period;
  return atr;
}

// ─── SIGNAL DEFINITIONS ───
// Each signal evaluates to a label (truthy) or null (no signal)
// Signals are scored: buy signals = +1, sell signals = -1
// Trade executes when net score meets profile threshold
// Weights optimized via backtest on 20 cryptos (2017-2026)
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
  { id: "trend_follow", label: "Trend Follow", side: "buy", category: "momentum", weight: 1.8 },
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
const STRATS = SIGNALS;

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
    case "trend_follow": if (sd.ema200 > 0 && sd.ema21 > sd.ema50 && sd.cur > sd.ema200 && sd.adx >= val && candles.length >= 220) { var base = (candles[candles.length - 21] || {}).c; var ret20 = base > 0 ? ((sd.cur - base) / base) * 100 : 0; if (ret20 > 3) return 'Trend +' + ret20.toFixed(1) + '%'; } break;
    case "ema200_break": if (pos && pos.qty > 0 && sd.ema200 > 0 && sd.cur < sd.ema200 && candles.length > 200) { var pc2 = (candles[candles.length - 2] || {}).c; if (pc2 && pc2 >= sd.ema200) return 'Below EMA200'; } break;
  }
  return null;
}

// ─── PORTFOLIO PROFILES ───
// buyThreshold: minimum weighted score to trigger buy (higher = more confirmation needed)
// sellThreshold: minimum weighted score to trigger sell
// cashPct: % of available cash per trade
// Risk signals (TP/SL/Trailing) always execute immediately (bypass scoring)
const PROFILES = [
  { id: "conservative", name: "Conservative", color: "#3b82f6", icon: "🛡️",
    desc: "Few high-conviction trades, tight risk control",
    assets: ['GOLD','AAPL','MSFT','GOOGL','AMZN','NVDA','JPM','V','WMT','BTC','ETH'], cashPct: 0.36, buyThreshold: 4.5, sellThreshold: 1.0,
    overrides: {
      rsi_ob: 22, rsi_os: 78, stoch_ob: 15, stoch_os: 85,
      tp_pct: 999, sl_pct: 4.0, trailing: 12.0,  // Ride trend; wide trailing caps give-back
      bb_lower: 0.05, bb_upper: 0.02, vol_spike_b: 2.5, vol_spike_s: 1.5,
      breakout_high: 25, breakdown: 15, dip_rsi_macd: 28, dip_rsi_macd_s: 72,
      trend_follow: 20,
      vwap_sell: 0.03, vwap_buy: 0.05,
      slippage: 0.0003,
    } },
  { id: "moderate", name: "Moderate", color: "#22c55e", icon: "⚖️",
    desc: "Balanced approach, trend-following bias",
    assets: ['GOLD','AAPL','MSFT','GOOGL','NVDA','AMD','META','JPM','V','WMT','BTC','ETH','SOL','LINK'], cashPct: 0.26, buyThreshold: 4.0, sellThreshold: 1.0,
    overrides: {
      rsi_ob: 28, rsi_os: 72, stoch_ob: 20, stoch_os: 80,
      tp_pct: 999, sl_pct: 5.0, trailing: 14.0,  // Ride trend
      bb_lower: 0.08, bb_upper: 0.05, vol_spike_b: 2.0, vol_spike_s: 1.2,
      breakout_high: 18, breakdown: 10, dip_rsi_macd: 32, dip_rsi_macd_s: 68,
      trend_follow: 18,
      vwap_sell: 0.05, vwap_buy: 0.08,
      slippage: 0.0005,
    } },
  { id: "aggressive", name: "Aggressive", color: "#f59e0b", icon: "🔥",
    desc: "Trend-following, wider stops, bigger moves",
    assets: ['NVDA','AMD','GOOGL','META','INTC','AAPL','MSFT','GOLD','AMZN','BTC','ETH'], cashPct: 0.26, buyThreshold: 4.0, sellThreshold: 1.0,
    overrides: {
      rsi_ob: 32, rsi_os: 68, stoch_ob: 25, stoch_os: 75,
      tp_pct: 999, sl_pct: 6.0, trailing: 12.0,  // Ride trend (tighter)
      bb_lower: 0.15, bb_upper: 0.1, vol_spike_b: 1.5, vol_spike_s: 1.0,
      breakout_high: 12, breakdown: 8, dip_rsi_macd: 38, dip_rsi_macd_s: 62,
      trend_follow: 16,
      ema50_bounce: 0.5, vwap_buy: 0.1, vwap_sell: 0.08, adx_trend_b: 22,
      slippage: 0.0007,
    } },
  { id: "yolo", name: "YOLO", color: "#ef4444", icon: "🚀",
    desc: "Maximum trend capture, high volatility tolerance",
    assets: ['SOL','AVAX','DOGE','ARB','SUI','OP','APT','NEAR','LINK','UNI','COIN','TSLA'], cashPct: 0.35, buyThreshold: 3.0, sellThreshold: 0.8,
    overrides: {
      rsi_ob: 38, rsi_os: 62, stoch_ob: 30, stoch_os: 70,
      tp_pct: 999, sl_pct: 8.0, trailing: 22.0,  // Ride trend
      bb_lower: 0.3, bb_upper: 0.15, vol_spike_b: 1.2, vol_spike_s: 0.8,
      breakout_high: 8, breakdown: 5, dip_rsi_macd: 42, dip_rsi_macd_s: 58,
      trend_follow: 14,
      ema50_bounce: 1.0, vwap_buy: 0.05, vwap_sell: 0.03, adx_trend_b: 18,
      slippage: 0.001,
    } },
];

// ─── SHARED SIGNAL SCORING ───
// Encapsulates regime weighting (profile-specific, ADX-interpolated), ranging-
// downtrend protection, and the per-category score cap. Mirrors the live scoring
// in server.js runStrategies so the backtest and live engine cannot diverge.
const CATEGORY_CAP = 3.0; // max score contribution per category
const PROFILE_REGIME = {
  conservative: { trendHigh: 2.0, trendLow: 0.3, mrHigh: 2.0, mrLow: 0.3 },
  moderate:     { trendHigh: 1.5, trendLow: 0.5, mrHigh: 1.5, mrLow: 0.5 },
  aggressive:   { trendHigh: 1.3, trendLow: 0.6, mrHigh: 1.3, mrLow: 0.6 },
  yolo:         { trendHigh: 1.2, trendLow: 0.8, mrHigh: 1.2, mrLow: 0.8 },
};

const PROFILE_RISK = {
  conservative: { riskPct: 0.005, atrMult: 2.4, rewardRisk: 1.8 },
  moderate:     { riskPct: 0.008, atrMult: 2.2, rewardRisk: 2.0 },
  aggressive:   { riskPct: 0.012, atrMult: 2.0, rewardRisk: 2.2 },
  yolo:         { riskPct: 0.018, atrMult: 1.8, rewardRisk: 2.5 },
};

const PROFILE_EXIT = {
  conservative: { profitLockAt: 0.025, profitLockGiveback: 0.006, minProfit: 0.006, reversalMargin: 0.8, reversalMinSell: 0.70, timeExitMaxPnl: 0.012 },
  moderate:     { profitLockAt: 0.035, profitLockGiveback: 0.010, minProfit: 0.008, reversalMargin: 1.0, reversalMinSell: 0.80, timeExitMaxPnl: 0.010 },
  aggressive:   { profitLockAt: 0.050, profitLockGiveback: 0.014, minProfit: 0.010, reversalMargin: 1.2, reversalMinSell: 0.90, timeExitMaxPnl: 0.008 },
  yolo:         { profitLockAt: 0.080, profitLockGiveback: 0.025, minProfit: 0.015, reversalMargin: 1.5, reversalMinSell: 1.00, timeExitMaxPnl: 0.005 },
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function buildRiskPlan(opts) {
  opts = opts || {};
  var profile = opts.profile || {};
  var sd = opts.sd || {};
  var price = opts.price || sd.cur || 0;
  var startCash = opts.startCash || 100000;
  var cash = opts.cash != null ? opts.cash : startCash;
  var availableCash = opts.availableCash != null ? opts.availableCash : cash;
  var portfolioValue = opts.portfolioValue != null ? opts.portfolioValue : startCash;
  if (!isFinite(portfolioValue) || portfolioValue <= 0) portfolioValue = startCash;
  var cashPct = opts.cashPct != null ? opts.cashPct : (profile.cashPct || 0.10);
  var maxPerPosition = opts.maxPerPosition != null ? opts.maxPerPosition : 0.10;
  var symType = opts.symType || ((COINS[opts.symbol] && COINS[opts.symbol].type) || 'crypto');
  var pr = PROFILE_RISK[profile.id] || PROFILE_RISK.moderate;
  var regime = opts.regime || detectRegime(sd);
  var trendAligned = !!(sd && sd.ema21 > 0 && sd.ema50 > 0 && sd.ema200 > 0 && price > sd.ema200 && sd.ema21 > sd.ema50);
  var downtrend = !!(sd && sd.ema21 > 0 && price < sd.ema21);
  var regimeRiskMult = 1.0;
  var deploymentMult = 1.0;
  if (regime.type === 'trending' && trendAligned) {
    regimeRiskMult = 1.35;
    deploymentMult = 1.25;
  } else if (regime.type === 'trending') {
    regimeRiskMult = 1.12;
    deploymentMult = 1.10;
  } else if (regime.type === 'ranging') {
    regimeRiskMult = 0.75;
    deploymentMult = 0.72;
  }
  if (downtrend) {
    regimeRiskMult *= 0.65;
    deploymentMult *= 0.65;
  }
  var assetRiskMult = symType === 'commodity' ? 0.65 : (symType === 'stock' ? 0.80 : 1.0);
  var atr = sd.atr || 0;
  var atrPct = price > 0 && atr > 0 ? atr / price : 0;
  var fallbackStopPct = ((profile.overrides && profile.overrides.sl_pct) || 5) / 100;
  if (symType === 'stock') fallbackStopPct *= 0.7;
  else if (symType === 'commodity') fallbackStopPct *= 0.5;
  var stopPct = clamp(Math.max(atrPct * pr.atrMult, fallbackStopPct), 0.004, symType === 'crypto' ? 0.18 : 0.08);
  var riskBudget = portfolioValue * pr.riskPct * assetRiskMult * regimeRiskMult;
  var byRisk = stopPct > 0 ? riskBudget / stopPct : availableCash * cashPct;
  var adjustedCashPct = clamp(cashPct * deploymentMult, 0.02, 0.50);
  var adjustedMaxPerPosition = clamp(maxPerPosition * deploymentMult, 0.05, symType === 'crypto' ? 0.45 : 0.35);
  var tradeValue = Math.min(availableCash * adjustedCashPct, availableCash * 0.95, portfolioValue * adjustedMaxPerPosition, byRisk);
  if (!isFinite(tradeValue) || tradeValue < 0) tradeValue = 0;
  var qty = price > 0 ? +(tradeValue / price).toFixed(6) : 0;
  var rewardRisk = pr.rewardRisk;
  var targetPct = stopPct * rewardRisk;
  return {
    atr: atr,
    atrPct: atrPct,
    stopPct: stopPct,
    targetPct: targetPct,
    riskPct: pr.riskPct * assetRiskMult * regimeRiskMult,
    riskBudget: riskBudget,
    tradeValue: tradeValue,
    qty: qty,
    portfolioValue: portfolioValue,
    cashPct: adjustedCashPct,
    maxPerPosition: adjustedMaxPerPosition,
    regimeRiskMult: regimeRiskMult,
    deploymentMult: deploymentMult,
    trendAligned: trendAligned,
    stopPrice: price > 0 ? +(price * (1 - stopPct)).toFixed(4) : 0,
    takeProfitPrice: price > 0 ? +(price * (1 + targetPct)).toFixed(4) : 0,
    rewardRisk: rewardRisk,
  };
}

// symType is the asset class ('crypto' | 'stock' | 'commodity') used to scale
// risk (TP/SL/trailing) thresholds, matching live behaviour.
function scoreSignals(sd, pos, peakPrice, profile, symType) {
  var regime = detectRegime(sd);
  var pr = PROFILE_REGIME[profile.id] || PROFILE_REGIME.moderate;
  var adxVal = regime.adx || 20;
  var trendMult, meanRevMult;
  if (adxVal >= 25) { trendMult = pr.trendHigh; meanRevMult = pr.mrLow; }
  else if (adxVal <= 18) { trendMult = pr.trendLow; meanRevMult = pr.mrHigh; }
  else { var t = (adxVal - 18) / 7; trendMult = pr.trendLow + t * (pr.trendHigh - pr.trendLow); meanRevMult = pr.mrHigh + t * (pr.mrLow - pr.mrHigh); }
  var rangingDowntrend = adxVal <= 18 && sd.ema21 > 0 && sd.cur < sd.ema21;
  if (rangingDowntrend) meanRevMult = pr.mrLow;
  var regimeMultipliers = {
    'trend': trendMult, 'momentum': trendMult, 'mean-reversion': meanRevMult,
    'neutral': 1.0, 'pattern': 1.0, 'combo': 1.2, 'risk': 0,
  };

  var buyScore = 0, sellScore = 0, buyReasons = [], sellReasons = [], riskSellTriggered = null;
  var buyCatScores = {}, sellCatScores = {};
  SIGNALS.forEach(function(sig) {
    var val = (profile.overrides && profile.overrides[sig.id] !== undefined) ? profile.overrides[sig.id] : 30;
    if (sig.category === 'risk') {
      if (symType === 'stock') val = val * 0.7;
      else if (symType === 'commodity') val = val * 0.5;
    }
    var result = evalSignal(sig.id, val, sd, pos, peakPrice);
    if (!result) return;
    if (sig.category === 'risk') { if (pos && pos.qty > 0) riskSellTriggered = result; return; }
    var weightedScore = sig.weight * (regimeMultipliers[sig.category] || 1.0);
    if (sig.side === 'buy') {
      buyCatScores[sig.category] = (buyCatScores[sig.category] || 0) + weightedScore;
      if (buyCatScores[sig.category] <= CATEGORY_CAP) buyScore += weightedScore;
      buyReasons.push(result);
    } else {
      sellCatScores[sig.category] = (sellCatScores[sig.category] || 0) + weightedScore;
      if (sellCatScores[sig.category] <= CATEGORY_CAP) sellScore += weightedScore;
      sellReasons.push(result);
    }
  });
  return { regime: regime, buyScore: buyScore, sellScore: sellScore, buyReasons: buyReasons, sellReasons: sellReasons, riskSellTriggered: riskSellTriggered, rangingDowntrend: rangingDowntrend };
}

function evaluateTradeDecision(opts) {
  opts = opts || {};
  var sd = opts.sd;
  var profile = opts.profile || {};
  var symbol = opts.symbol;
  var pos = opts.pos || null;
  var peakPrice = opts.peakPrice;
  var symType = opts.symType || ((COINS[symbol] && COINS[symbol].type) || 'crypto');
  var scored = scoreSignals(sd, pos, peakPrice, profile, symType);
  var buyScore = scored.buyScore;
  var sellScore = scored.sellScore;
  var buyReasons = scored.buyReasons.slice();
  var sellReasons = scored.sellReasons.slice();
  var trend15m = opts.trend15m || 0;
  var blackSwan = !!opts.blackSwan;
  var exposurePct = opts.exposurePct || 0;
  var scoreExposureLimit = opts.scoreExposureLimit != null ? opts.scoreExposureLimit : 0.80;
  var buyExposureLimit = opts.buyExposureLimit != null ? opts.buyExposureLimit : scoreExposureLimit;
  var exposureLimited = opts.exposureLimited != null ? !!opts.exposureLimited : exposurePct >= scoreExposureLimit;
  var buyThreshold = opts.buyThreshold != null ? opts.buyThreshold : (profile.buyThreshold || 3);
  var sellThreshold = opts.sellThreshold != null ? opts.sellThreshold : (profile.sellThreshold || 2);
  var inCooldown = !!opts.inCooldown;
  var minHoldBlocked = !!opts.minHoldBlocked;
  var requireAboveEma200ForBuy = opts.requireAboveEma200ForBuy !== false;
  var requireBelowEma200ForSell = !!opts.requireBelowEma200ForSell;
  var sellMustBeatBuy = !!opts.sellMustBeatBuy;
  var exitCfg = Object.assign({}, PROFILE_EXIT[profile.id] || PROFILE_EXIT.moderate, opts.exit || {});
  var holdingBars = opts.holdingBars != null ? opts.holdingBars : null;
  var maxHoldBars = opts.maxHoldBars != null ? opts.maxHoldBars : 0;
  var buyBlockedReasons = [];
  var sellBlockedReasons = [];

  if (trend15m === -1) {
    buyScore = buyScore * 0.3;
    buyBlockedReasons.push('15m trend down');
  } else if (trend15m === 1) {
    buyScore = buyScore * 1.2;
  }

  if (blackSwan) {
    buyScore = 0;
    buyReasons.push('BLACK SWAN BLOCKED');
    buyBlockedReasons.push('black swan');
  }

  if (exposureLimited) {
    buyScore = 0;
    sellScore += 1.5;
    sellReasons.push('Over-exposed');
    buyBlockedReasons.push('portfolio exposure');
  }

  var hasPos = !!(pos && pos.qty > 0);
  var price = sd && sd.cur ? sd.cur : 0;
  var buyTrendOk = !requireAboveEma200ForBuy || (sd && sd.ema200 > 0 && sd.cur > sd.ema200);
  var sellTrendOk = !requireBelowEma200ForSell || (sd && sd.ema200 > 0 && sd.cur < sd.ema200);
  var buyExposureOk = exposurePct < buyExposureLimit;
  var pnlPct = hasPos && pos.avgCost > 0 && price > 0 ? (price - pos.avgCost) / pos.avgCost : 0;
  var peakPnlPct = hasPos && pos.avgCost > 0 && peakPrice > 0 ? (peakPrice - pos.avgCost) / pos.avgCost : pnlPct;
  var givebackPct = hasPos && peakPrice > 0 && price > 0 ? (peakPrice - price) / peakPrice : 0;
  var exitTriggered = null;

  if (inCooldown) {
    buyBlockedReasons.push('cooldown');
    sellBlockedReasons.push('cooldown');
  }
  if (!buyTrendOk) buyBlockedReasons.push('below EMA200');
  if (!buyExposureOk) buyBlockedReasons.push('buy exposure');
  if (!sellTrendOk) sellBlockedReasons.push('above EMA200');
  if (minHoldBlocked) sellBlockedReasons.push('minimum hold');

  if (hasPos && price > 0 && !minHoldBlocked) {
    if (peakPnlPct >= exitCfg.profitLockAt && pnlPct >= exitCfg.minProfit && givebackPct >= exitCfg.profitLockGiveback) {
      exitTriggered = 'Profit lock +' + (pnlPct * 100).toFixed(1) + '% after peak +' + (peakPnlPct * 100).toFixed(1) + '%';
    } else if (sellScore >= Math.max(sellThreshold * exitCfg.reversalMinSell, buyScore + exitCfg.reversalMargin) && buyScore < buyThreshold) {
      exitTriggered = 'Signal reversal sell ' + sellScore.toFixed(1) + ' > buy ' + buyScore.toFixed(1);
    } else if (maxHoldBars > 0 && holdingBars !== null && holdingBars >= maxHoldBars && pnlPct <= exitCfg.timeExitMaxPnl && sellScore >= buyScore) {
      exitTriggered = 'Time exit ' + holdingBars + ' bars pnl ' + (pnlPct * 100).toFixed(1) + '%';
    }
  }

  var action = 'hold';
  var side = null;
  var type = 'hold';
  var reason = '';
  if (hasPos && (scored.riskSellTriggered || exitTriggered)) {
    action = 'riskSell';
    side = 'sell';
    type = 'risk';
    reason = scored.riskSellTriggered || exitTriggered;
  } else if (!inCooldown && price > 0 && buyScore >= buyThreshold && buyScore > sellScore && buyExposureOk && buyTrendOk) {
    action = 'buy';
    side = 'buy';
    type = 'score';
    reason = buyReasons.join(', ');
  } else if (!inCooldown && price > 0 && hasPos && sellScore >= sellThreshold && (!sellMustBeatBuy || sellScore > buyScore) && sellTrendOk && !minHoldBlocked) {
    action = 'sell';
    side = 'sell';
    type = 'score';
    reason = sellReasons.join(', ');
  }

  return {
    action: action, side: side, type: type, reason: reason,
    regime: scored.regime, buyScore: buyScore, sellScore: sellScore,
    buyReasons: buyReasons, sellReasons: sellReasons,
    riskSellTriggered: scored.riskSellTriggered || exitTriggered,
    exitTriggered: exitTriggered,
    pnlPct: pnlPct, peakPnlPct: peakPnlPct, givebackPct: givebackPct,
    holdingBars: holdingBars, maxHoldBars: maxHoldBars,
    rangingDowntrend: scored.rangingDowntrend,
    trend15m: trend15m, blackSwan: blackSwan,
    exposurePct: exposurePct, exposureLimited: exposureLimited,
    buyThreshold: buyThreshold, sellThreshold: sellThreshold,
    buyBlockedReasons: buyBlockedReasons, sellBlockedReasons: sellBlockedReasons,
  };
}

module.exports = {
  COINS, ema, emaArray, calcRSI, calcMACD, calcBB, calcStoch, calcADX, calcATR,
  SIGNALS, STRATS, detectRegime, evalSignal, PROFILES,
  CATEGORY_CAP, PROFILE_REGIME, PROFILE_RISK, PROFILE_EXIT, scoreSignals, evaluateTradeDecision, buildRiskPlan,
};
