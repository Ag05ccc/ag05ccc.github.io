#!/usr/bin/env node
/**
 * TradeSimBot Backtest Engine
 * Tests all 30 signals + scoring system against historical data
 * Outputs: win rate, P&L, max drawdown, Sharpe ratio per profile
 */

const fs = require('fs');
const path = require('path');

// ─── TA FUNCTIONS (identical to server.js) ───
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

// ─── SIGNAL DEFINITIONS (optimized weights from backtest v1) ───
const SIGNALS = [
  { id: "rsi_ob", label: "RSI Oversold", side: "buy", category: "mean-reversion", weight: 1.0 },
  { id: "macd_cross_b", label: "MACD Cross Buy", side: "buy", category: "trend", weight: 1.5 },
  { id: "bb_lower", label: "BB Lower", side: "buy", category: "mean-reversion", weight: 1.0 },
  { id: "ema_golden", label: "Golden Cross", side: "buy", category: "trend", weight: 2.0 },
  { id: "ema50_bounce", label: "EMA50 Bounce", side: "buy", category: "trend", weight: 0.5 },
  { id: "stoch_ob", label: "Stoch Oversold", side: "buy", category: "mean-reversion", weight: 0.8 },
  { id: "vol_spike_b", label: "Vol Spike Buy", side: "buy", category: "momentum", weight: 1.2 },
  { id: "hammer", label: "Hammer", side: "buy", category: "pattern", weight: 0.8 },
  { id: "engulf_b", label: "Bull Engulfing", side: "buy", category: "pattern", weight: 1.5 },
  { id: "vwap_buy", label: "Below VWAP", side: "buy", category: "mean-reversion", weight: 0.5 },
  { id: "adx_trend_b", label: "ADX Trend Buy", side: "buy", category: "trend", weight: 1.0 },
  { id: "fib_buy", label: "Fib 61.8%", side: "buy", category: "mean-reversion", weight: 0.8 },
  { id: "dip_rsi_macd", label: "RSI+MACD Buy", side: "buy", category: "combo", weight: 2.5 },
  { id: "breakout_high", label: "Breakout", side: "buy", category: "momentum", weight: 0.8 },
  { id: "ema200_trend", label: "EMA200 Trend", side: "buy", category: "trend", weight: 1.5 },
  { id: "rsi_os", label: "RSI Overbought", side: "sell", category: "mean-reversion", weight: 1.2 },
  { id: "macd_cross_s", label: "MACD Cross Sell", side: "sell", category: "trend", weight: 1.8 },
  { id: "bb_upper", label: "BB Upper", side: "sell", category: "mean-reversion", weight: 1.2 },
  { id: "ema_death", label: "Death Cross", side: "sell", category: "trend", weight: 2.5 },
  { id: "stoch_os", label: "Stoch Overbought", side: "sell", category: "mean-reversion", weight: 1.2 },
  { id: "vol_spike_s", label: "Vol Spike Sell", side: "sell", category: "momentum", weight: 1.5 },
  { id: "shooting_star", label: "Shooting Star", side: "sell", category: "pattern", weight: 1.2 },
  { id: "engulf_s", label: "Bear Engulfing", side: "sell", category: "pattern", weight: 2.0 },
  { id: "vwap_sell", label: "Above VWAP", side: "sell", category: "mean-reversion", weight: 0.8 },
  { id: "dip_rsi_macd_s", label: "RSI+MACD Sell", side: "sell", category: "combo", weight: 2.5 },
  { id: "breakdown", label: "Breakdown", side: "sell", category: "momentum", weight: 1.8 },
  { id: "ema200_break", label: "EMA200 Break", side: "sell", category: "trend", weight: 1.5 },
  { id: "tp_pct", label: "Take Profit", side: "sell", category: "risk", weight: 0 },
  { id: "sl_pct", label: "Stop Loss", side: "sell", category: "risk", weight: 0 },
  { id: "trailing", label: "Trailing Stop", side: "sell", category: "risk", weight: 0 },
];

// ─── PROFILES (optimized from backtest v1) ───
const PROFILES = [
  { id: "conservative", name: "Conservative",
    cashPct: 0.20, buyThreshold: 3.5, sellThreshold: 0.8,
    cooldownBars: 5,
    overrides: {
      rsi_ob: 25, rsi_os: 75, stoch_ob: 18, stoch_os: 82,
      tp_pct: 2.0, sl_pct: 0.8, trailing: 0.6,
      bb_lower: 0.05, bb_upper: 0.02, vol_spike_b: 2.5, vol_spike_s: 1.5,
      breakout_high: 20, breakdown: 10, dip_rsi_macd: 32, dip_rsi_macd_s: 68,
      vwap_sell: 0.03, vwap_buy: 0.05,
    } },
  { id: "moderate", name: "Moderate",
    cashPct: 0.30, buyThreshold: 3.0, sellThreshold: 0.8,
    cooldownBars: 3,
    overrides: {
      rsi_ob: 30, rsi_os: 70, stoch_ob: 22, stoch_os: 78,
      tp_pct: 2.5, sl_pct: 1.0, trailing: 0.8,
      bb_lower: 0.08, bb_upper: 0.05, vol_spike_b: 1.8, vol_spike_s: 1.2,
      breakout_high: 12, breakdown: 8, dip_rsi_macd: 38, dip_rsi_macd_s: 62,
      vwap_sell: 0.05, vwap_buy: 0.08,
    } },
  { id: "aggressive", name: "Aggressive",
    cashPct: 0.35, buyThreshold: 2.5, sellThreshold: 0.8,
    cooldownBars: 2,
    overrides: {
      rsi_ob: 35, rsi_os: 65, stoch_ob: 28, stoch_os: 72,
      tp_pct: 3.5, sl_pct: 1.5, trailing: 1.2,
      bb_lower: 0.15, bb_upper: 0.1, vol_spike_b: 1.4, vol_spike_s: 1.0,
      breakout_high: 8, breakdown: 6, dip_rsi_macd: 42, dip_rsi_macd_s: 58,
      ema50_bounce: 0.5, vwap_buy: 0.1, vwap_sell: 0.08, adx_trend_b: 20,
    } },
  { id: "yolo", name: "YOLO",
    cashPct: 0.40, buyThreshold: 2.0, sellThreshold: 0.5,
    cooldownBars: 2,
    overrides: {
      rsi_ob: 40, rsi_os: 60, stoch_ob: 35, stoch_os: 65,
      tp_pct: 5.0, sl_pct: 2.5, trailing: 1.8,
      bb_lower: 0.3, bb_upper: 0.15, vol_spike_b: 1.0, vol_spike_s: 0.8,
      breakout_high: 5, breakdown: 4, dip_rsi_macd: 45, dip_rsi_macd_s: 55,
      ema50_bounce: 1.0, vwap_buy: 0.05, vwap_sell: 0.03, adx_trend_b: 16,
    } },
];

const COMMISSION_RATE = 0.001;
const CATEGORY_CAP = 3.0;
const DEFAULT_CASH = 100000;

// ─── LOAD CSV DATA ───
function loadCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('http') && !l.startsWith('Unix,'));
  const candles = lines.map(l => {
    const p = l.split(',');
    // Format: Unix,Date,Symbol,Open,High,Low,Close,Volume BTC,Volume USDT,tradecount
    return {
      t: parseInt(p[0]),
      date: p[1],
      o: parseFloat(p[3]),
      h: parseFloat(p[4]),
      l: parseFloat(p[5]),
      c: parseFloat(p[6]),
      v: parseFloat(p[7]) || 0,
    };
  }).filter(c => !isNaN(c.o) && c.o > 0);
  // Sort ascending by time
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

// ─── COMPUTE INDICATORS FOR A CANDLE WINDOW ───
function computeIndicators(candles) {
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;

  // VWAP (volume-weighted average price over last 20 bars)
  const vwapSlice = candles.slice(-20);
  const totalVol = vwapSlice.reduce((s, c) => s + c.v, 0);
  const vwap = totalVol > 0
    ? vwapSlice.reduce((s, c) => s + c.c * c.v, 0) / totalVol
    : closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);

  const prevMacdHist = candles.length > 26
    ? calcMACD(closes.slice(0, -1)).hist
    : 0;

  return {
    cur: lastCandle.c,
    candles: candles,
    rsi: calcRSI(closes),
    macd: calcMACD(closes),
    prevMacdHist,
    bb: calcBB(closes),
    ema9: ema(closes, 9) || lastCandle.c,
    ema21: ema(closes, 21) || lastCandle.c,
    ema50: ema(closes, 50) || 0,
    ema200: ema(closes, 200) || 0,
    stoch: calcStoch(highs, lows, closes),
    adx: calcADX(highs, lows, closes),
    vwap,
  };
}

// ─── SIGNAL EVALUATOR (identical to server.js) ───
function evalSignal(sigId, val, sd, pos, peakPrice) {
  if (!sd || sd.candles.length < 5) return null;
  const candles = sd.candles;
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  switch (sigId) {
    case "rsi_ob": if (sd.rsi <= val) return 'RSI ' + sd.rsi.toFixed(0); break;
    case "rsi_os": if (pos && pos.qty > 0 && sd.rsi >= val) return 'RSI ' + sd.rsi.toFixed(0); break;
    case "macd_cross_b": if (sd.macd.hist > 0 && sd.prevMacdHist <= 0) return 'MACD↑'; break;
    case "macd_cross_s": if (pos && pos.qty > 0 && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return 'MACD↓'; break;
    case "bb_lower": if (sd.bb.lower > 0 && sd.cur <= sd.bb.lower * (1 - val / 100)) return 'BB lower'; break;
    case "bb_upper": if (pos && pos.qty > 0 && sd.bb.upper > 0 && sd.cur >= sd.bb.upper * (1 + val / 100)) return 'BB upper'; break;
    case "ema_golden": if (sd.ema9 > sd.ema21 && candles.length > 21) { const prevE9 = ema(candles.slice(0, -1).map(c => c.c), 9); if (prevE9 && prevE9 <= sd.ema21) return 'Golden cross'; } break;
    case "ema_death": if (pos && pos.qty > 0 && sd.ema9 < sd.ema21 && candles.length > 21) { const prevE9 = ema(candles.slice(0, -1).map(c => c.c), 9); if (prevE9 && prevE9 >= sd.ema21) return 'Death cross'; } break;
    case "ema50_bounce": if (sd.ema50 > 0 && prevCandle) { const dist = ((sd.cur - sd.ema50) / sd.ema50) * 100; if (dist >= 0 && dist <= val && lastCandle.c > lastCandle.o && prevCandle.c < prevCandle.o) return 'EMA50 bounce'; } break;
    case "stoch_ob": if (sd.stoch.k <= val) return 'Stoch K=' + sd.stoch.k.toFixed(0); break;
    case "stoch_os": if (pos && pos.qty > 0 && sd.stoch.k >= val) return 'Stoch K=' + sd.stoch.k.toFixed(0); break;
    case "vol_spike_b": if (candles.length >= 10) { const avgV = candles.slice(-10).reduce((a, c2) => a + c2.v, 0) / 10; if (lastCandle.v > avgV * val && lastCandle.c > lastCandle.o) return 'Vol ' + (lastCandle.v / avgV).toFixed(1) + 'x'; } break;
    case "vol_spike_s": if (pos && pos.qty > 0 && candles.length >= 10) { const avgV = candles.slice(-10).reduce((a, c2) => a + c2.v, 0) / 10; if (lastCandle.v > avgV * val && lastCandle.c < lastCandle.o) return 'Vol sell'; } break;
    case "hammer": if (prevCandle && lastCandle) { const body = Math.abs(lastCandle.c - lastCandle.o); const lw = Math.min(lastCandle.o, lastCandle.c) - lastCandle.l; if (lw > body * 2 && lastCandle.c > lastCandle.o) return 'Hammer'; } break;
    case "shooting_star": if (pos && pos.qty > 0 && lastCandle) { const body = Math.abs(lastCandle.c - lastCandle.o); const uw = lastCandle.h - Math.max(lastCandle.o, lastCandle.c); if (uw > body * 2 && lastCandle.c < lastCandle.o) return 'Shooting star'; } break;
    case "engulf_b": if (prevCandle && lastCandle && prevCandle.c < prevCandle.o && lastCandle.c > lastCandle.o && lastCandle.c > prevCandle.o && lastCandle.o < prevCandle.c) return 'Bull engulf'; break;
    case "engulf_s": if (pos && pos.qty > 0 && prevCandle && lastCandle && prevCandle.c > prevCandle.o && lastCandle.c < lastCandle.o && lastCandle.c < prevCandle.o && lastCandle.o > prevCandle.c) return 'Bear engulf'; break;
    case "vwap_buy": if (sd.vwap > 0) { const vd = ((sd.vwap - sd.cur) / sd.vwap) * 100; if (vd >= val) return 'Below VWAP'; } break;
    case "vwap_sell": if (pos && pos.qty > 0 && sd.vwap > 0) { const vd = ((sd.cur - sd.vwap) / sd.vwap) * 100; if (vd >= val) return 'Above VWAP'; } break;
    case "adx_trend_b": if (sd.adx >= val && sd.cur > sd.ema21) return 'ADX ' + sd.adx.toFixed(0); break;
    case "fib_buy": if (candles.length >= 20) { const hi = Math.max(...candles.slice(-20).map(c => c.h)); const lo = Math.min(...candles.slice(-20).map(c => c.l)); const fib = hi - (hi - lo) * val; if (sd.cur <= fib && sd.cur > lo) return 'Fib'; } break;
    case "dip_rsi_macd": if (sd.rsi < val && sd.macd.hist > 0 && sd.prevMacdHist <= 0) return 'RSI+MACD↑'; break;
    case "dip_rsi_macd_s": if (pos && pos.qty > 0 && sd.rsi > val && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return 'RSI+MACD↓'; break;
    case "breakout_high": { const n = Math.floor(val); if (candles.length >= n + 1) { const bhi = Math.max(...candles.slice(-n - 1, -1).map(c => c.h)); if (sd.cur > bhi) return 'Breakout'; } break; }
    case "breakdown": if (pos && pos.qty > 0 && candles.length >= Math.floor(val) + 1) { const blo = Math.min(...candles.slice(-Math.floor(val) - 1, -1).map(c => c.l)); if (sd.cur < blo) return 'Breakdown'; } break;
    case "tp_pct": if (pos && pos.qty > 0) { const pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl >= val) return 'TP +' + pl.toFixed(1) + '%'; } break;
    case "sl_pct": if (pos && pos.qty > 0) { const pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl <= -val) return 'SL ' + pl.toFixed(1) + '%'; } break;
    case "trailing": if (pos && pos.qty > 0 && peakPrice) { const dr = ((peakPrice - sd.cur) / peakPrice) * 100; if (dr >= val) return 'Trail -' + dr.toFixed(1) + '%'; } break;
    case "ema200_trend": if (sd.ema200 > 0 && sd.cur > sd.ema200 && candles.length > 200) { const pc = candles[candles.length - 2] ? candles[candles.length - 2].c : null; if (pc && pc <= sd.ema200) return 'Above EMA200'; } break;
    case "ema200_break": if (pos && pos.qty > 0 && sd.ema200 > 0 && sd.cur < sd.ema200 && candles.length > 200) { const pc = candles[candles.length - 2] ? candles[candles.length - 2].c : null; if (pc && pc >= sd.ema200) return 'Below EMA200'; } break;
  }
  return null;
}

// ─── REGIME DETECTION ───
function detectRegime(sd) {
  if (!sd || sd.candles.length < 20) return { type: 'warming up', adx: 20, volatility: 0 };
  const adx = sd.adx || 20;
  const closes = sd.candles.slice(-20).map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const stddev = Math.sqrt(closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length);
  const volPct = mean > 0 ? (stddev / mean) * 100 : 0;
  let type = 'mixed';
  if (adx >= 25) type = 'trending';
  else if (adx <= 18) type = 'ranging';
  return { type, adx, volatility: volPct };
}

// ─── BLACK SWAN FILTER ───
function isBlackSwan(candles) {
  if (candles.length < 5) return false;
  const recent = candles.slice(-5);
  const drop = ((recent[recent.length - 1].c - recent[0].o) / recent[0].o) * 100;
  return drop <= -3;
}

// ─── BACKTEST ENGINE ───
function runBacktest(candles, profile, symbolName) {
  const overrides = profile.overrides;
  let cash = DEFAULT_CASH;
  let holdings = {}; // { qty, avgCost }
  let peaks = {};
  let trades = [];
  let lastTradeBar = -999;
  let maxValue = DEFAULT_CASH;
  let maxDrawdown = 0;
  let dailyReturns = [];
  let prevValue = DEFAULT_CASH;
  const WINDOW = 200; // lookback window for indicators

  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - WINDOW), i + 1);
    const sd = computeIndicators(window);
    const price = sd.cur;
    const sym = symbolName;
    const pos = holdings[sym] || null;
    const peakPrice = peaks[sym] || price;

    // Update peak
    if (price > peakPrice) peaks[sym] = price;

    // Portfolio value
    const hVal = pos ? pos.qty * price : 0;
    const totalValue = cash + hVal;

    // Track drawdown
    if (totalValue > maxValue) maxValue = totalValue;
    const dd = ((maxValue - totalValue) / maxValue) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Daily return tracking (every bar)
    dailyReturns.push((totalValue - prevValue) / prevValue);
    prevValue = totalValue;

    // Circuit breaker: stop if drawdown > 20%
    if (dd > 20) continue;

    // Cooldown check
    if (i - lastTradeBar < profile.cooldownBars) continue;

    // Black swan filter
    const blackSwan = isBlackSwan(window);

    // Evaluate all signals
    const regime = detectRegime(sd);
    let buyScore = 0, sellScore = 0;
    const buyReasons = [], sellReasons = [];
    const categoryCaps = {};

    for (const sig of SIGNALS) {
      if (sig.category === 'risk') continue; // Handle separately
      const val = overrides[sig.id] !== undefined ? overrides[sig.id] : 30;
      const result = evalSignal(sig.id, val, sd, pos, peakPrice);
      if (!result) continue;

      // Regime weighting
      let w = sig.weight;
      if (regime.type === 'trending') {
        if (sig.category === 'trend' || sig.category === 'momentum') w *= 1.5;
        if (sig.category === 'mean-reversion') w *= 0.5;
      } else if (regime.type === 'ranging') {
        if (sig.category === 'mean-reversion') w *= 1.5;
        if (sig.category === 'trend') w *= 0.5;
      }

      // Category cap
      const catKey = sig.side + '_' + sig.category;
      if (!categoryCaps[catKey]) categoryCaps[catKey] = 0;
      const remaining = CATEGORY_CAP - categoryCaps[catKey];
      if (remaining <= 0) continue;
      const effectiveW = Math.min(w, remaining);
      categoryCaps[catKey] += effectiveW;

      if (sig.side === 'buy') {
        buyScore += effectiveW;
        buyReasons.push(result);
      } else {
        sellScore += effectiveW;
        sellReasons.push(result);
      }
    }

    // Risk signals (bypass scoring) - TP/SL/Trailing
    if (pos && pos.qty > 0) {
      for (const sig of SIGNALS.filter(s => s.category === 'risk')) {
        const val = overrides[sig.id];
        if (val === undefined) continue;
        const result = evalSignal(sig.id, val, sd, pos, peakPrice);
        if (result) {
          // Immediate sell
          const sellQty = pos.qty;
          const total = sellQty * price;
          const commission = total * COMMISSION_RATE;
          const pnl = (price - pos.avgCost) * sellQty - commission;
          cash += total - commission;
          trades.push({
            bar: i, date: candles[i].date, side: 'sell', price, qty: sellQty,
            total, pnl, reason: result, regime: regime.type, score: 0,
            type: 'risk'
          });
          delete holdings[sym];
          delete peaks[sym];
          lastTradeBar = i;
          break; // Only one risk signal needed
        }
      }
      // If risk signal fired, skip scoring
      if (i === lastTradeBar) continue;
    }

    // Scoring decision
    if (buyScore >= profile.buyThreshold && buyScore > sellScore && !blackSwan) {
      // BUY
      const exposure = hVal / totalValue;
      if (exposure > 0.85) continue; // Max exposure limit
      const tradeValue = Math.min(cash * profile.cashPct, cash * 0.98); // Keep 2% reserve
      if (tradeValue < 10) continue;
      const qty = tradeValue / price;
      const commission = tradeValue * COMMISSION_RATE;
      cash -= tradeValue + commission;

      if (!holdings[sym]) holdings[sym] = { qty: 0, avgCost: price };
      const h = holdings[sym];
      h.avgCost = ((h.avgCost * h.qty) + (price * qty)) / (h.qty + qty);
      h.qty += qty;
      peaks[sym] = price;

      trades.push({
        bar: i, date: candles[i].date, side: 'buy', price, qty,
        total: tradeValue, pnl: 0, reason: buyReasons.join(', '),
        regime: regime.type, score: buyScore, type: 'score'
      });
      lastTradeBar = i;

    } else if (sellScore >= profile.sellThreshold && sellScore > buyScore && pos && pos.qty > 0) {
      // SELL
      const sellQty = pos.qty;
      const total = sellQty * price;
      const commission = total * COMMISSION_RATE;
      const pnl = (price - pos.avgCost) * sellQty - commission;
      cash += total - commission;

      trades.push({
        bar: i, date: candles[i].date, side: 'sell', price, qty: sellQty,
        total, pnl, reason: sellReasons.join(', '),
        regime: regime.type, score: -sellScore, type: 'score'
      });
      delete holdings[sym];
      delete peaks[sym];
      lastTradeBar = i;
    }
  }

  // Final portfolio value
  const finalPos = holdings[symbolName];
  const finalHVal = finalPos ? finalPos.qty * candles[candles.length - 1].c : 0;
  const finalValue = cash + finalHVal;

  // Calculate metrics
  const wins = trades.filter(t => t.side === 'sell' && t.pnl > 0).length;
  const losses = trades.filter(t => t.side === 'sell' && t.pnl <= 0).length;
  const totalSells = wins + losses;
  const winRate = totalSells > 0 ? (wins / totalSells * 100) : 0;
  const totalPnL = finalValue - DEFAULT_CASH;
  const totalReturn = (totalPnL / DEFAULT_CASH) * 100;
  const totalCommission = trades.reduce((s, t) => s + (t.total * COMMISSION_RATE), 0);

  // Sharpe ratio (annualized, assuming daily bars)
  const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 1;
  const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  // Buy-and-hold comparison
  const buyHoldReturn = ((candles[candles.length - 1].c - candles[WINDOW].c) / candles[WINDOW].c) * 100;

  // Signal frequency analysis
  const signalCounts = {};
  trades.forEach(t => {
    t.reason.split(', ').forEach(r => {
      signalCounts[r] = (signalCounts[r] || 0) + 1;
    });
  });

  return {
    profile: profile.id,
    symbol: symbolName,
    period: (candles[WINDOW] ? candles[WINDOW].date : '?') + ' → ' + (candles[candles.length - 1] ? candles[candles.length - 1].date : '?'),
    bars: candles.length - WINDOW,
    finalValue: finalValue.toFixed(0),
    totalReturn: totalReturn.toFixed(2) + '%',
    buyHoldReturn: buyHoldReturn.toFixed(2) + '%',
    alpha: (totalReturn - buyHoldReturn).toFixed(2) + '%',
    totalTrades: trades.length,
    buys: trades.filter(t => t.side === 'buy').length,
    sells: trades.filter(t => t.side === 'sell').length,
    winRate: winRate.toFixed(1) + '%',
    wins, losses,
    maxDrawdown: maxDrawdown.toFixed(2) + '%',
    sharpe: sharpe.toFixed(3),
    totalCommission: '$' + totalCommission.toFixed(0),
    avgTradePnL: totalSells > 0 ? '$' + (trades.filter(t => t.side === 'sell').reduce((s, t) => s + t.pnl, 0) / totalSells).toFixed(2) : 'N/A',
    topSignals: Object.entries(signalCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
    openPosition: finalPos ? { qty: finalPos.qty.toFixed(6), avgCost: finalPos.avgCost.toFixed(2), unrealizedPnL: ((candles[candles.length - 1].c - finalPos.avgCost) * finalPos.qty).toFixed(2) } : null,
    // Last 10 trades for inspection
    recentTrades: trades.slice(-10).map(t => ({
      date: t.date, side: t.side, price: t.price.toFixed(2),
      pnl: t.pnl ? t.pnl.toFixed(2) : '0', reason: t.reason,
      regime: t.regime, score: t.score.toFixed(1)
    })),
  };
}

// ─── MAIN ───
function main() {
  const dataDir = path.join(__dirname, 'data');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TradeSimBot Backtest Engine');
  console.log('  Profiles: ' + PROFILES.map(p => p.id).join(', '));
  console.log('  Data files: ' + files.join(', '));
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allResults = [];

  // Only use daily files for now (1h would take too long)
  const dailyFiles = files.filter(f => f.includes('daily'));

  for (const file of dailyFiles) {
    const sym = file.replace('_daily.csv', '').replace('_1h.csv', '');
    const candles = loadCSV(path.join(dataDir, file));
    console.log('\n' + sym + ': ' + candles.length + ' candles (' + (candles[0] ? candles[0].date : '?') + ' -> ' + (candles[candles.length - 1] ? candles[candles.length - 1].date : '?') + ')');

    for (const profile of PROFILES) {
      const result = runBacktest(candles, profile, sym);
      allResults.push(result);

      const emoji = parseFloat(result.totalReturn) > 0 ? '✅' : '❌';
      const beat = parseFloat(result.alpha) > 0 ? '🏆' : '📉';
      console.log(`  ${emoji} ${profile.id.padEnd(14)} Return: ${result.totalReturn.padStart(8)} | B&H: ${result.buyHoldReturn.padStart(8)} | Alpha: ${result.alpha.padStart(8)} ${beat} | WR: ${result.winRate.padStart(5)} | Trades: ${result.totalTrades} | MaxDD: ${result.maxDrawdown.padStart(6)} | Sharpe: ${result.sharpe}`);
    }
  }

  // Summary
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY BY PROFILE (averaged across all symbols)');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const profile of PROFILES) {
    const results = allResults.filter(r => r.profile === profile.id);
    if (results.length === 0) continue;

    const avgReturn = results.reduce((s, r) => s + parseFloat(r.totalReturn), 0) / results.length;
    const avgAlpha = results.reduce((s, r) => s + parseFloat(r.alpha), 0) / results.length;
    const avgWinRate = results.reduce((s, r) => s + parseFloat(r.winRate), 0) / results.length;
    const avgMaxDD = results.reduce((s, r) => s + parseFloat(r.maxDrawdown), 0) / results.length;
    const avgSharpe = results.reduce((s, r) => s + parseFloat(r.sharpe), 0) / results.length;
    const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);

    console.log(`\n  ${profile.id.toUpperCase()}`);
    console.log(`    Avg Return:    ${avgReturn.toFixed(2)}%`);
    console.log(`    Avg Alpha:     ${avgAlpha.toFixed(2)}%`);
    console.log(`    Avg Win Rate:  ${avgWinRate.toFixed(1)}%`);
    console.log(`    Avg Max DD:    ${avgMaxDD.toFixed(2)}%`);
    console.log(`    Avg Sharpe:    ${avgSharpe.toFixed(3)}`);
    console.log(`    Total Trades:  ${totalTrades}`);
  }

  // Signal Analysis
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  SIGNAL FREQUENCY ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════');

  const globalSignals = {};
  allResults.forEach(r => {
    r.topSignals.forEach(([sig, count]) => {
      globalSignals[sig] = (globalSignals[sig] || 0) + count;
    });
  });
  const sorted = Object.entries(globalSignals).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 15).forEach(([sig, count], i) => {
    console.log(`  ${(i + 1 + '.').padEnd(4)} ${sig.padEnd(20)} ${count} trades`);
  });

  // Save detailed results to JSON
  const outPath = path.join(__dirname, 'backtest_results.json');
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\n\n📁 Detailed results saved to: ${outPath}`);

  // Also run 1-hour backtest on BTC for more granular analysis
  const btc1h = path.join(dataDir, 'BTC_1h.csv');
  if (fs.existsSync(btc1h)) {
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('  1-HOUR BTC BACKTEST (more granular)');
    console.log('═══════════════════════════════════════════════════════════════');

    const candles1h = loadCSV(btc1h);
    console.log('  ' + candles1h.length + ' hourly candles (' + (candles1h[0] ? candles1h[0].date : '?') + ' -> ' + (candles1h[candles1h.length - 1] ? candles1h[candles1h.length - 1].date : '?') + ')');

    for (const profile of PROFILES) {
      const result = runBacktest(candles1h, profile, 'BTC');
      const emoji = parseFloat(result.totalReturn) > 0 ? '✅' : '❌';
      console.log(`  ${emoji} ${profile.id.padEnd(14)} Return: ${result.totalReturn.padStart(8)} | B&H: ${result.buyHoldReturn.padStart(8)} | Alpha: ${result.alpha.padStart(8)} | WR: ${result.winRate.padStart(5)} | Trades: ${result.totalTrades} | MaxDD: ${result.maxDrawdown.padStart(6)} | Sharpe: ${result.sharpe}`);
    }
  }
}

main();
