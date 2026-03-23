const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');

const PORT = 3000;
const TICK_MS = 2000;
const CANDLE_TICKS = 4; // 4 ticks per candle = 8 seconds per candle in sim mode
const PRICE_FETCH_INTERVAL = 30000; // Fetch real prices every 30 seconds
const DEFAULT_CASH = 1000000;

// ─── ASSET DEFINITIONS ───
const COINS = {
  BTC: { name: "Bitcoin", cgId: "bitcoin", type: "crypto" },
  ETH: { name: "Ethereum", cgId: "ethereum", type: "crypto" },
  BNB: { name: "BNB", cgId: "binancecoin", type: "crypto" },
  SOL: { name: "Solana", cgId: "solana", type: "crypto" },
  XRP: { name: "Ripple", cgId: "ripple", type: "crypto" },
  ADA: { name: "Cardano", cgId: "cardano", type: "crypto" },
  AVAX: { name: "Avalanche", cgId: "avalanche-2", type: "crypto" },
  DOGE: { name: "Dogecoin", cgId: "dogecoin", type: "crypto" },
  DOT: { name: "Polkadot", cgId: "polkadot", type: "crypto" },
  LINK: { name: "Chainlink", cgId: "chainlink", type: "crypto" },
  AAPL: { name: "Apple", type: "stock", price: 178.50 },
  MSFT: { name: "Microsoft", type: "stock", price: 420.50 },
  GOOGL: { name: "Alphabet", type: "stock", price: 155.80 },
  AMZN: { name: "Amazon", type: "stock", price: 185.60 },
  NVDA: { name: "NVIDIA", type: "stock", price: 875.30 },
  META: { name: "Meta", type: "stock", price: 505.20 },
  TSLA: { name: "Tesla", type: "stock", price: 248.30 },
  JPM: { name: "JPMorgan", type: "stock", price: 198.40 },
  V: { name: "Visa", type: "stock", price: 282.60 },
  WMT: { name: "Walmart", type: "stock", price: 168.90 },
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

// ─── STRATEGY EVALUATION ───
const STRATS = [
  { id: "rsi_ob", label: "RSI Oversold Buy", side: "buy" },
  { id: "macd_cross_b", label: "MACD Cross Buy", side: "buy" },
  { id: "bb_lower", label: "BB Lower Buy", side: "buy" },
  { id: "ema_golden", label: "Golden Cross", side: "buy" },
  { id: "ema50_bounce", label: "EMA50 Bounce", side: "buy" },
  { id: "stoch_ob", label: "Stoch Oversold", side: "buy" },
  { id: "vol_spike_b", label: "Vol Spike Buy", side: "buy" },
  { id: "hammer", label: "Hammer Buy", side: "buy" },
  { id: "engulf_b", label: "Bull Engulfing", side: "buy" },
  { id: "vwap_buy", label: "Below VWAP Buy", side: "buy" },
  { id: "adx_trend_b", label: "ADX Trend Buy", side: "buy" },
  { id: "fib_buy", label: "Fib 61.8% Buy", side: "buy" },
  { id: "dip_rsi_macd", label: "RSI+MACD Buy", side: "buy" },
  { id: "breakout_high", label: "Breakout Buy", side: "buy" },
  { id: "ema200_trend", label: "EMA200 Trend", side: "buy" },
  { id: "rsi_os", label: "RSI Overbought Sell", side: "sell" },
  { id: "macd_cross_s", label: "MACD Cross Sell", side: "sell" },
  { id: "bb_upper", label: "BB Upper Sell", side: "sell" },
  { id: "ema_death", label: "Death Cross", side: "sell" },
  { id: "stoch_os", label: "Stoch Overbought", side: "sell" },
  { id: "vol_spike_s", label: "Vol Spike Sell", side: "sell" },
  { id: "shooting_star", label: "Shooting Star", side: "sell" },
  { id: "engulf_s", label: "Bear Engulfing", side: "sell" },
  { id: "vwap_sell", label: "Above VWAP Sell", side: "sell" },
  { id: "tp_pct", label: "Take Profit %", side: "sell" },
  { id: "sl_pct", label: "Stop Loss %", side: "sell" },
  { id: "trailing", label: "Trailing Stop", side: "sell" },
  { id: "breakdown", label: "Breakdown Sell", side: "sell" },
  { id: "dip_rsi_macd_s", label: "RSI+MACD Sell", side: "sell" },
  { id: "ema200_break", label: "EMA200 Break", side: "sell" },
];

function evalStrategy(st, sd, pos, peakPrice) {
  if (!sd || sd.candles.length < 5) return null;
  const candles = sd.candles;
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  switch (st.type) {
    case "rsi_ob": if (sd.rsi <= st.value) return `RSI ${sd.rsi.toFixed(0)}`; break;
    case "rsi_os": if (pos && pos.qty > 0 && sd.rsi >= st.value) return `RSI ${sd.rsi.toFixed(0)}`; break;
    case "macd_cross_b": if (sd.macd.hist > 0 && sd.prevMacdHist <= 0) return `MACD↑`; break;
    case "macd_cross_s": if (pos && pos.qty > 0 && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return `MACD↓`; break;
    case "bb_lower": if (sd.bb.lower > 0 && sd.cur <= sd.bb.lower * (1 - st.value / 100)) return `BB lower`; break;
    case "bb_upper": if (pos && pos.qty > 0 && sd.bb.upper > 0 && sd.cur >= sd.bb.upper * (1 + st.value / 100)) return `BB upper`; break;
    case "ema_golden": if (sd.ema9 > sd.ema21 && candles.length > 21) { const prevE9 = ema(candles.slice(0, -1).map(c => c.c), 9); if (prevE9 && prevE9 <= sd.ema21) return `Golden cross`; } break;
    case "ema_death": if (pos && pos.qty > 0 && sd.ema9 < sd.ema21 && candles.length > 21) { const prevE9 = ema(candles.slice(0, -1).map(c => c.c), 9); if (prevE9 && prevE9 >= sd.ema21) return `Death cross`; } break;
    case "ema50_bounce": if (sd.ema50 > 0) { const dist = ((sd.cur - sd.ema50) / sd.ema50) * 100; if (dist >= 0 && dist <= st.value && lastCandle.c > lastCandle.o) return `EMA50 bounce`; } break;
    case "stoch_ob": if (sd.stoch.k <= st.value) return `Stoch K=${sd.stoch.k.toFixed(0)}`; break;
    case "stoch_os": if (pos && pos.qty > 0 && sd.stoch.k >= st.value) return `Stoch K=${sd.stoch.k.toFixed(0)}`; break;
    case "vol_spike_b": if (candles.length >= 10) { const avgVol = candles.slice(-10).reduce((a, c2) => a + c2.v, 0) / 10; if (lastCandle.v > avgVol * st.value && lastCandle.c > lastCandle.o) return `Vol ${(lastCandle.v / avgVol).toFixed(1)}x`; } break;
    case "vol_spike_s": if (pos && pos.qty > 0 && candles.length >= 10) { const avgVol = candles.slice(-10).reduce((a, c2) => a + c2.v, 0) / 10; if (lastCandle.v > avgVol * st.value && lastCandle.c < lastCandle.o) return `Vol sell`; } break;
    case "hammer": if (prevCandle && lastCandle) { const body = Math.abs(lastCandle.c - lastCandle.o); const lw = Math.min(lastCandle.o, lastCandle.c) - lastCandle.l; if (lw > body * 2 && lastCandle.c > lastCandle.o) return `Hammer`; } break;
    case "shooting_star": if (pos && pos.qty > 0 && lastCandle) { const body = Math.abs(lastCandle.c - lastCandle.o); const uw = lastCandle.h - Math.max(lastCandle.o, lastCandle.c); if (uw > body * 2 && lastCandle.c < lastCandle.o) return `Shooting star`; } break;
    case "engulf_b": if (prevCandle && lastCandle && prevCandle.c < prevCandle.o && lastCandle.c > lastCandle.o && lastCandle.c > prevCandle.o && lastCandle.o < prevCandle.c) return `Bull engulf`; break;
    case "engulf_s": if (pos && pos.qty > 0 && prevCandle && lastCandle && prevCandle.c > prevCandle.o && lastCandle.c < lastCandle.o && lastCandle.c < prevCandle.o && lastCandle.o > prevCandle.c) return `Bear engulf`; break;
    case "vwap_buy": if (sd.vwap > 0) { const dist = ((sd.vwap - sd.cur) / sd.vwap) * 100; if (dist >= st.value) return `Below VWAP`; } break;
    case "vwap_sell": if (pos && pos.qty > 0 && sd.vwap > 0) { const dist = ((sd.cur - sd.vwap) / sd.vwap) * 100; if (dist >= st.value) return `Above VWAP`; } break;
    case "adx_trend_b": if (sd.adx >= st.value && sd.cur > sd.ema21) return `ADX ${sd.adx.toFixed(0)}`; break;
    case "fib_buy": if (candles.length >= 20) { const hi = Math.max(...candles.slice(-20).map(c2 => c2.h)); const lo = Math.min(...candles.slice(-20).map(c2 => c2.l)); const fib = hi - (hi - lo) * st.value; if (sd.cur <= fib && sd.cur > lo) return `Fib`; } break;
    case "dip_rsi_macd": if (sd.rsi < st.value && sd.macd.hist > 0 && sd.prevMacdHist <= 0) return `RSI+MACD↑`; break;
    case "dip_rsi_macd_s": if (pos && pos.qty > 0 && sd.rsi > st.value && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return `RSI+MACD↓`; break;
    case "breakout_high": { const n = Math.floor(st.value); if (candles.length >= n) { const hi = Math.max(...candles.slice(-n - 1, -1).map(c2 => c2.h)); if (sd.cur > hi) return `Breakout`; } break; }
    case "breakdown": if (pos && pos.qty > 0 && candles.length >= Math.floor(st.value)) { const lo = Math.min(...candles.slice(-Math.floor(st.value) - 1, -1).map(c2 => c2.l)); if (sd.cur < lo) return `Breakdown`; } break;
    case "tp_pct": if (pos && pos.qty > 0) { const pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl >= st.value) return `TP +${pl.toFixed(1)}%`; } break;
    case "sl_pct": if (pos && pos.qty > 0) { const pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl <= -st.value) return `SL ${pl.toFixed(1)}%`; } break;
    case "trailing": if (pos && pos.qty > 0 && peakPrice) { const dr = ((peakPrice - sd.cur) / peakPrice) * 100; if (dr >= st.value) return `Trail -${dr.toFixed(1)}%`; } break;
    case "ema200_trend": if (sd.ema200 > 0 && sd.cur > sd.ema200 && candles.length > 200) { const prevC = candles[candles.length - 2]?.c; if (prevC && prevC <= sd.ema200) return `Above EMA200`; } break;
    case "ema200_break": if (pos && pos.qty > 0 && sd.ema200 > 0 && sd.cur < sd.ema200 && candles.length > 200) { const prevC = candles[candles.length - 2]?.c; if (prevC && prevC >= sd.ema200) return `Below EMA200`; } break;
  }
  return null;
}

// ─── PORTFOLIO PROFILES ───
function qtyFor(sym, mult, price) {
  const p = price || 100;
  if (p > 10000) return +(0.005 * mult);
  if (p > 1000) return +(0.02 * mult);
  if (p > 100) return +(0.2 * mult);
  if (p > 10) return +(2 * mult);
  if (p > 1) return +(10 * mult);
  return +(200 * mult);
}

const PROFILES = [
  { id: "conservative", name: "Conservative", color: "#3b82f6", icon: "🛡️", desc: "Low-risk, tight stops",
    assets: ["AAPL", "MSFT", "GOOGL", "JPM", "V", "WMT", "BTC", "ETH"], qtyMult: 0.5,
    overrides: { rsi_ob: 25, rsi_os: 75, stoch_ob: 15, stoch_os: 85, tp_pct: 0.8, sl_pct: 0.5, trailing: 0.4, bb_lower: 0.05, bb_upper: 0.05, vol_spike_b: 2.0, vol_spike_s: 2.0, breakout_high: 15, breakdown: 15, dip_rsi_macd: 35, dip_rsi_macd_s: 65 } },
  { id: "moderate", name: "Moderate", color: "#22c55e", icon: "⚖️", desc: "Balanced mix",
    assets: ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "LINK", "BNB"], qtyMult: 1.0,
    overrides: { rsi_ob: 30, rsi_os: 70, stoch_ob: 20, stoch_os: 80, tp_pct: 1.5, sl_pct: 1.0, trailing: 0.8, bb_lower: 0.1, bb_upper: 0.1, vol_spike_b: 1.5, vol_spike_s: 1.5, breakout_high: 10, breakdown: 10, dip_rsi_macd: 40, dip_rsi_macd_s: 60 } },
  { id: "aggressive", name: "Aggressive", color: "#f59e0b", icon: "🔥", desc: "High volatility, wider thresholds",
    assets: ["BTC", "ETH", "SOL", "AVAX", "DOGE", "LINK", "DOT", "NVDA", "TSLA", "META"], qtyMult: 2.0,
    overrides: { rsi_ob: 38, rsi_os: 62, stoch_ob: 30, stoch_os: 70, tp_pct: 3.0, sl_pct: 2.0, trailing: 1.5, bb_lower: 0.2, bb_upper: 0.2, vol_spike_b: 1.2, vol_spike_s: 1.2, breakout_high: 6, breakdown: 6, dip_rsi_macd: 45, dip_rsi_macd_s: 55, ema50_bounce: 0.5, vwap_buy: 0.2, vwap_sell: 0.2, adx_trend_b: 20 } },
  { id: "yolo", name: "YOLO", color: "#ef4444", icon: "🚀", desc: "Maximum risk",
    assets: ["SOL", "DOGE", "AVAX", "TSLA", "NVDA", "ADA", "XRP", "DOT", "ETH", "BTC"], qtyMult: 4.0,
    overrides: { rsi_ob: 45, rsi_os: 55, stoch_ob: 40, stoch_os: 60, tp_pct: 5.0, sl_pct: 4.0, trailing: 3.0, bb_lower: 0.3, bb_upper: 0.3, vol_spike_b: 1.0, vol_spike_s: 1.0, breakout_high: 4, breakdown: 4, dip_rsi_macd: 48, dip_rsi_macd_s: 52, ema50_bounce: 1.0, vwap_buy: 0.1, vwap_sell: 0.1, adx_trend_b: 15 } },
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
      strats.push({ id: `${profile.id}_${st.id}_${sym}`, type: st.id, symbol: sym, value: val, qty: qtyFor(sym, profile.qtyMult, lastPrices[sym]), active: true });
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

// ─── FETCH REAL PRICES ───
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CryptoTA/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchRealPrices() {
  try {
    // Crypto from CoinGecko
    const cgIds = Object.entries(COINS).filter(([,c]) => c.cgId).map(([,c]) => c.cgId).join(',');
    const prices = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`);
    Object.entries(COINS).forEach(([sym, c]) => {
      if (c.cgId && prices[c.cgId]?.usd) {
        lastPrices[sym] = prices[c.cgId].usd;
      }
    });
    console.log(`[${new Date().toLocaleTimeString()}] Fetched real crypto prices. BTC=$${lastPrices.BTC}`);
  } catch(e) {
    console.log('CoinGecko fetch failed:', e.message);
  }

  // Stocks from Yahoo Finance
  for (const sym of Object.keys(COINS).filter(s => COINS[s].type === 'stock')) {
    try {
      const d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
      const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) lastPrices[sym] = price;
    } catch(e) { /* ignore stock fetch errors */ }
  }
}

// ─── PRICE TICK ───
function priceTick() {
  tickCount++;
  const now = Date.now();

  Object.keys(COINS).forEach(sym => {
    const sd = marketData[sym];
    // Use real price as base, add tiny noise for candle formation
    const realPrice = lastPrices[sym] || sd.cur;
    const noise = realPrice * 0.0005 * (Math.random() - 0.5); // ±0.05% noise
    const np = Math.max(realPrice * 0.5, realPrice + noise);
    sd.cur = np;

    const b = sd.building;
    b.h = Math.max(b.h, np);
    b.l = Math.min(b.l, np);
    b.c = np;
    b.v += Math.random() * 50 + 10;
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
      sd.prevMacdHist = sd.macd?.hist || 0;

      sd.building = { o: np, h: np, l: np, c: np, v: 0, tickCount: 0 };

      // Run strategies on candle close
      runStrategies();
    }
  });
}

// ─── STRATEGY ENGINE ───
function runStrategies() {
  portfolios.forEach(pf => {
    pf.actives.forEach(st => {
      if (!st.active) return;
      const sd = marketData[st.symbol];
      if (!sd) return;
      const pos = pf.holdings[st.symbol];
      const sT = STRATS.find(s => s.id === st.type);
      if (!sT) return;

      const why = evalStrategy(st, sd, pos, pf.peaks[st.symbol]);
      if (!why) return;

      const price = sd.cur;
      const tq = st.qty;
      const total = price * tq;

      if (sT.side === "buy") {
        if (total > pf.cash) return;
        pf.cash -= total;
        const old = pf.holdings[st.symbol] || { qty: 0, avgCost: 0 };
        const nq = +(old.qty + tq).toFixed(6);
        pf.holdings[st.symbol] = { qty: nq, avgCost: nq > 0 ? (old.avgCost * old.qty + total) / nq : price };
        pf.peaks[st.symbol] = price;
      } else {
        const held = pos?.qty || 0;
        const sq = Math.min(tq, held);
        if (sq <= 0.000001) return;
        pf.cash += price * sq;
        if (pos && pos.avgCost) {
          if (price > pos.avgCost) pf.wins++; else pf.losses++;
        }
        const nq = +(held - sq).toFixed(6);
        if (nq <= 0.000001) {
          delete pf.holdings[st.symbol];
        } else {
          pf.holdings[st.symbol] = { ...pf.holdings[st.symbol], qty: nq };
        }
      }

      pf.tradeCount++;
      pf.orders = [{ sym: st.symbol, side: sT.side, qty: sT.side === "sell" ? Math.min(tq, pos?.qty || tq) : tq, price, time: new Date().toISOString(), strat: sT.label, why }, ...pf.orders].slice(0, 200);
    });

    // Update peaks
    Object.keys(pf.holdings).forEach(sym => {
      const c = marketData[sym]?.cur;
      if (c && (!pf.peaks[sym] || c > pf.peaks[sym])) pf.peaks[sym] = c;
    });

    // Record history
    const hVal = Object.entries(pf.holdings).reduce((s, [sym, h]) => s + (h?.qty || 0) * (marketData[sym]?.cur || 0), 0);
    pf.history.push({ t: pf.history.length, value: pf.cash + hVal });
    if (pf.history.length > 1000) pf.history = pf.history.slice(-1000);
  });
}

// ─── BUILD CLIENT STATE ───
function getState() {
  const prices = {};
  Object.keys(COINS).forEach(sym => {
    const sd = marketData[sym];
    prices[sym] = {
      cur: sd.cur,
      candles: sd.candles.slice(-200),
      rsi: sd.rsi, macd: sd.macd, bb: sd.bb,
      ema9: sd.ema9, ema21: sd.ema21, ema50: sd.ema50, ema200: sd.ema200,
      stoch: sd.stoch, adx: sd.adx, vwap: sd.vwap, prevMacdHist: sd.prevMacdHist,
    };
  });

  const pfs = portfolios.map(pf => {
    const hVal = Object.entries(pf.holdings).reduce((s, [sym, h]) => s + (h?.qty || 0) * (marketData[sym]?.cur || 0), 0);
    return {
      id: pf.id, name: pf.name, color: pf.color, icon: pf.icon, desc: pf.desc,
      cash: pf.cash, startCash: pf.startCash, holdings: pf.holdings,
      orders: pf.orders.slice(0, 50),
      history: pf.history.slice(-300),
      tradeCount: pf.tradeCount, wins: pf.wins, losses: pf.losses,
      totalValue: pf.cash + hVal, hVal, pnl: pf.cash + hVal - pf.startCash,
    };
  });

  return { prices, portfolios: pfs, tick: tickCount, serverTime: new Date().toISOString() };
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
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── WEBSOCKET ───
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  console.log(`Client connected. Total: ${wss.clients.size}`);
  ws.send(JSON.stringify({ type: 'init', data: getState() }));
  ws.on('close', () => console.log(`Client disconnected. Total: ${wss.clients.size}`));
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
  portfolios = PROFILES.map(p => ({
    ...portfolios.find(pf => pf.id === p.id),
    actives: buildStrategies(p),
  }));

  server.listen(PORT, () => {
    console.log(`\n  CryptoTA Server running at http://localhost:${PORT}`);
    console.log(`  BTC: $${lastPrices.BTC || 'N/A'} | ETH: $${lastPrices.ETH || 'N/A'}`);
    console.log(`  4 portfolios active with 30 strategies each`);
    console.log(`\n  To expose to internet, run: ngrok http ${PORT}\n`);
  });

  // Price ticks
  setInterval(priceTick, TICK_MS);

  // Broadcast to WebSocket clients every 2 seconds
  setInterval(broadcast, TICK_MS);

  // Fetch real prices periodically
  setInterval(fetchRealPrices, PRICE_FETCH_INTERVAL);
}

start();
