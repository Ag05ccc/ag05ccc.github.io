const { useState, useEffect, useRef, useCallback } = React;
const { ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid, Legend, AreaChart, Area } = Recharts;

const DEFAULT_CASH = 1000000;
const TICK_MS = 2000;
const TICKS_PER_CANDLE = 30; // 30 ticks x 2s = 60s = 1 minute candles

const COINS = {
  BTC: { name: "Bitcoin", price: 67450, vol: 0.006, drift: 0.00005, type: "crypto" },
  ETH: { name: "Ethereum", price: 3520, vol: 0.008, drift: 0.00003, type: "crypto" },
  SOL: { name: "Solana", price: 148, vol: 0.015, drift: 0.00006, type: "crypto" },
  DOGE: { name: "Dogecoin", price: 0.165, vol: 0.018, drift: 0.00001, type: "crypto" },
  AVAX: { name: "Avalanche", price: 36.50, vol: 0.013, drift: 0.00003, type: "crypto" },
  LINK: { name: "Chainlink", price: 14.80, vol: 0.013, drift: 0.00003, type: "crypto" },
};
const SYMS = Object.keys(COINS);

// ─── TA HELPERS ───
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

function symColor(sym) {
  const colors = { BTC: "#f59e0b", ETH: "#627eea", SOL: "#9945ff", DOGE: "#c2a633", AVAX: "#e84142", LINK: "#2a5ada" };
  return colors[sym] || "#94a3b8";
}

function tk(p, v, d) { return Math.max(p * 0.5, +(p + (Math.random() - 0.5) * 2 * v * p + d * p).toFixed(2)); }
function fmt(n) { return n < 1 ? n.toFixed(4) : n < 100 ? n.toFixed(2) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fK(n) { if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K"; return fmt(n); }
function pc(n) { return (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%"; }

function initState() {
  const p = {};
  Object.entries(COINS).forEach(([s, c]) => {
    p[s] = {
      cur: c.price, candles: [], building: { o: c.price, h: c.price, l: c.price, c: c.price, v: Math.random() * 100 + 50, tickCount: 0 },
      rsi: 50, macd: { macd: 0, signal: 0, hist: 0 }, bb: { upper: 0, mid: 0, lower: 0 },
      ema9: 0, ema21: 0, ema50: 0, ema200: 0,
      stoch: { k: 50, d: 50 }, adx: 20, vwap: c.price,
      prevMacdHist: 0,
    };
  });
  return p;
}

// ─── STRATEGY EVALUATION ───
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
    case "vwap_buy": if (sd.vwap > 0) { const dist = ((sd.vwap - sd.cur) / sd.vwap) * 100; if (dist >= st.value) return `Below VWAP ${dist.toFixed(1)}%`; } break;
    case "vwap_sell": if (pos && pos.qty > 0 && sd.vwap > 0) { const dist = ((sd.cur - sd.vwap) / sd.vwap) * 100; if (dist >= st.value) return `Above VWAP`; } break;
    case "adx_trend_b": if (sd.adx >= st.value && sd.cur > sd.ema21) return `ADX ${sd.adx.toFixed(0)}`; break;
    case "fib_buy": if (candles.length >= 20) { const hi = Math.max(...candles.slice(-20).map(c2 => c2.h)); const lo = Math.min(...candles.slice(-20).map(c2 => c2.l)); const fib = hi - (hi - lo) * st.value; if (sd.cur <= fib && sd.cur > lo) return `Fib ${(st.value * 100).toFixed(1)}%`; } break;
    case "dip_rsi_macd": if (sd.rsi < st.value && sd.macd.hist > 0 && sd.prevMacdHist <= 0) return `RSI${sd.rsi.toFixed(0)}+MACD↑`; break;
    case "dip_rsi_macd_s": if (pos && pos.qty > 0 && sd.rsi > st.value && sd.macd.hist < 0 && sd.prevMacdHist >= 0) return `RSI${sd.rsi.toFixed(0)}+MACD↓`; break;
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

// ─── STRATEGY DEFINITIONS ───
const STRATS = [
  { id: "rsi_ob", label: "RSI Oversold Buy", side: "buy", param: "rsi", def: 30 },
  { id: "macd_cross_b", label: "MACD Cross Buy", side: "buy", param: "trigger", def: 1 },
  { id: "bb_lower", label: "BB Lower Buy", side: "buy", param: "pct", def: 0.1 },
  { id: "ema_golden", label: "Golden Cross", side: "buy", param: "trigger", def: 1 },
  { id: "ema50_bounce", label: "EMA50 Bounce", side: "buy", param: "pct", def: 0.3 },
  { id: "stoch_ob", label: "Stoch Oversold", side: "buy", param: "rsi", def: 20 },
  { id: "vol_spike_b", label: "Vol Spike Buy", side: "buy", param: "mult", def: 1.5 },
  { id: "hammer", label: "Hammer Buy", side: "buy", param: "trigger", def: 1 },
  { id: "engulf_b", label: "Bull Engulfing", side: "buy", param: "trigger", def: 1 },
  { id: "vwap_buy", label: "Below VWAP Buy", side: "buy", param: "pct", def: 0.3 },
  { id: "adx_trend_b", label: "ADX Trend Buy", side: "buy", param: "rsi", def: 25 },
  { id: "fib_buy", label: "Fib 61.8% Buy", side: "buy", param: "pct", def: 0.618 },
  { id: "dip_rsi_macd", label: "RSI+MACD Buy", side: "buy", param: "rsi", def: 40 },
  { id: "breakout_high", label: "Breakout Buy", side: "buy", param: "period", def: 10 },
  { id: "ema200_trend", label: "EMA200 Trend", side: "buy", param: "trigger", def: 1 },
  { id: "rsi_os", label: "RSI Overbought Sell", side: "sell", param: "rsi", def: 70 },
  { id: "macd_cross_s", label: "MACD Cross Sell", side: "sell", param: "trigger", def: 1 },
  { id: "bb_upper", label: "BB Upper Sell", side: "sell", param: "pct", def: 0.1 },
  { id: "ema_death", label: "Death Cross", side: "sell", param: "trigger", def: 1 },
  { id: "stoch_os", label: "Stoch Overbought", side: "sell", param: "rsi", def: 80 },
  { id: "vol_spike_s", label: "Vol Spike Sell", side: "sell", param: "mult", def: 1.5 },
  { id: "shooting_star", label: "Shooting Star", side: "sell", param: "trigger", def: 1 },
  { id: "engulf_s", label: "Bear Engulfing", side: "sell", param: "trigger", def: 1 },
  { id: "vwap_sell", label: "Above VWAP Sell", side: "sell", param: "pct", def: 0.3 },
  { id: "tp_pct", label: "Take Profit %", side: "sell", param: "pct", def: 1.5 },
  { id: "sl_pct", label: "Stop Loss %", side: "sell", param: "pct", def: 1 },
  { id: "trailing", label: "Trailing Stop", side: "sell", param: "pct", def: 0.8 },
  { id: "breakdown", label: "Breakdown Sell", side: "sell", param: "period", def: 10 },
  { id: "dip_rsi_macd_s", label: "RSI+MACD Sell", side: "sell", param: "rsi", def: 60 },
  { id: "ema200_break", label: "EMA200 Break", side: "sell", param: "trigger", def: 1 },
];

// ─── PORTFOLIO PROFILES ───
// cashPct: how much of available cash to deploy per trade signal
const PROFILES = [
  {
    id: "conservative", name: "Conservative", color: "#3b82f6", icon: "🛡️",
    desc: "BTC+ETH only, tight stops, small positions",
    assets: ["BTC", "ETH"], cashPct: 0.10,
    overrides: {
      rsi_ob: 22, rsi_os: 78, stoch_ob: 12, stoch_os: 88,
      tp_pct: 0.8, sl_pct: 0.4, trailing: 0.3,
      bb_lower: 0.02, bb_upper: 0.02, vol_spike_b: 2.5, vol_spike_s: 2.5,
      breakout_high: 20, breakdown: 20, dip_rsi_macd: 30, dip_rsi_macd_s: 70,
    },
  },
  {
    id: "moderate", name: "Moderate", color: "#22c55e", icon: "⚖️",
    desc: "BTC+ETH, balanced thresholds",
    assets: ["BTC", "ETH"], cashPct: 0.25,
    overrides: {
      rsi_ob: 30, rsi_os: 70, stoch_ob: 20, stoch_os: 80,
      tp_pct: 1.5, sl_pct: 1.0, trailing: 0.8,
      bb_lower: 0.1, bb_upper: 0.1, vol_spike_b: 1.8, vol_spike_s: 1.8,
      breakout_high: 12, breakdown: 12, dip_rsi_macd: 38, dip_rsi_macd_s: 62,
    },
  },
  {
    id: "aggressive", name: "Aggressive", color: "#f59e0b", icon: "🔥",
    desc: "4 coins, loose triggers, big positions",
    assets: ["BTC", "ETH", "SOL", "LINK"], cashPct: 0.40,
    overrides: {
      rsi_ob: 42, rsi_os: 58, stoch_ob: 35, stoch_os: 65,
      tp_pct: 4.0, sl_pct: 3.0, trailing: 2.0,
      bb_lower: 0.3, bb_upper: 0.3, vol_spike_b: 1.1, vol_spike_s: 1.1,
      breakout_high: 5, breakdown: 5, dip_rsi_macd: 46, dip_rsi_macd_s: 54,
      ema50_bounce: 0.8, vwap_buy: 0.1, vwap_sell: 0.1, adx_trend_b: 18,
    },
  },
  {
    id: "yolo", name: "YOLO", color: "#ef4444", icon: "🚀",
    desc: "6 coins, triggers everything, all-in",
    assets: ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK"], cashPct: 0.50,
    overrides: {
      rsi_ob: 48, rsi_os: 52, stoch_ob: 45, stoch_os: 55,
      tp_pct: 8.0, sl_pct: 6.0, trailing: 4.0,
      bb_lower: 0.5, bb_upper: 0.5, vol_spike_b: 0.8, vol_spike_s: 0.8,
      breakout_high: 3, breakdown: 3, dip_rsi_macd: 49, dip_rsi_macd_s: 51,
      ema50_bounce: 1.5, vwap_buy: 0.05, vwap_sell: 0.05, adx_trend_b: 12,
    },
  },
];

function buildStrategies(profile) {
  const strats = [];
  profile.assets.forEach(sym => {
    STRATS.forEach(st => {
      const val = profile.overrides[st.id] !== undefined ? profile.overrides[st.id] : st.def;
      strats.push({
        id: `${profile.id}_${st.id}_${sym}_${Math.random()}`,
        type: st.id, symbol: sym, value: val,
        cashPct: profile.cashPct, active: true,
      });
    });
  });
  return strats;
}

function initPortfolio(profile) {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    icon: profile.icon,
    desc: profile.desc,
    cashPct: profile.cashPct,
    cash: DEFAULT_CASH,
    startCash: DEFAULT_CASH,
    holdings: {},
    orders: [],
    actives: buildStrategies(profile),
    log: [],
    peaks: {},
    history: [{ t: 0, value: DEFAULT_CASH }],
    tradeCount: 0,
    wins: 0,
    losses: 0,
  };
}

// ─── INDICATOR BADGE ───
const IndBadge = ({ label, value, color }) => (
  <div style={{ background: "#0f172a", borderRadius: 4, padding: "3px 8px", display: "inline-flex", gap: 4, alignItems: "center", fontSize: 10, fontFamily: "var(--m)" }}>
    <span style={{ color: "#6b7280" }}>{label}</span>
    <span style={{ color, fontWeight: 600 }}>{value}</span>
  </div>
);

// ─── MAIN APP ───
function App() {
  const [data, setData] = useState(initState);
  const [portfolios, setPortfolios] = useState(() => PROFILES.map(initPortfolio));
  const [selected, setSelected] = useState("BTC");
  const [tab, setTab] = useState("compare");
  const [chartType, setChartType] = useState("candle"); // "candle" or "line"
  const [notif, setNotif] = useState(null);
  const ntRef = useRef(null);
  const [tick, setTick] = useState(0);
  const dataRef = useRef(data);
  const portfoliosRef = useRef(portfolios);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { portfoliosRef.current = portfolios; }, [portfolios]);

  const notify = useCallback((msg, type = "info") => {
    if (ntRef.current) clearTimeout(ntRef.current);
    setNotif({ msg, type });
    ntRef.current = setTimeout(() => setNotif(null), 2500);
  }, []);

  // Fetch real prices (BTC + ETH only)
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd")
      .then(r => r.json())
      .then(prices => {
        setData(prev => {
          const next = { ...prev };
          if (prices.bitcoin?.usd) { const p = prices.bitcoin.usd; COINS.BTC.price = p; next.BTC = { ...next.BTC, cur: p, building: { o: p, h: p, l: p, c: p, v: 0, tickCount: 0 }, vwap: p }; }
          if (prices.ethereum?.usd) { const p = prices.ethereum.usd; COINS.ETH.price = p; next.ETH = { ...next.ETH, cur: p, building: { o: p, h: p, l: p, c: p, v: 0, tickCount: 0 }, vwap: p }; }
          return next;
        });
        notify("Live BTC/ETH prices loaded", "buy");
      })
      .catch(() => {});
  }, []);

  // Price engine
  useEffect(() => {
    const iv = setInterval(() => {
      setData(prev => {
        const next = {};
        Object.entries(COINS).forEach(([sym, cfg]) => {
          const p = prev[sym];
          const np = tk(p.cur, cfg.vol, cfg.drift);
          const b = { ...p.building };
          b.h = Math.max(b.h, np); b.l = Math.min(b.l, np); b.c = np;
          b.v += Math.random() * 50 + 10; b.tickCount++;
          let candles = [...p.candles];
          let indicators = {};
          if (b.tickCount >= TICKS_PER_CANDLE) {
            candles = [...candles, { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: Date.now() }].slice(-200);
            const closes = candles.map(c => c.c);
            const highs = candles.map(c => c.h);
            const lows = candles.map(c => c.l);
            indicators = {
              rsi: calcRSI(closes), macd: calcMACD(closes), bb: calcBB(closes),
              ema9: ema(closes, 9) || np, ema21: ema(closes, 21) || np,
              ema50: ema(closes, 50) || np, ema200: ema(closes, 200) || np,
              stoch: calcStoch(highs, lows, closes), adx: calcADX(highs, lows, closes),
              vwap: closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : np,
              prevMacdHist: p.macd?.hist || 0,
            };
            next[sym] = { cur: np, candles, building: { o: np, h: np, l: np, c: np, v: 0, tickCount: 0 }, ...indicators };
          } else {
            next[sym] = { ...p, cur: np, building: b };
          }
        });
        return next;
      });
      setTick(t => t + 1);
    }, TICK_MS);
    return () => clearInterval(iv);
  }, []);

  // Auto trading engine for ALL portfolios
  useEffect(() => {
    const iv = setInterval(() => {
      const d = dataRef.current;
      setPortfolios(prev => prev.map(pf => {
        let cash = pf.cash;
        let holdings = { ...pf.holdings };
        let orders = [...pf.orders];
        let log = [...pf.log];
        let peaks = { ...pf.peaks };
        let tradeCount = pf.tradeCount;
        let wins = pf.wins;
        let losses = pf.losses;
        let changed = false;

        // Update peaks
        Object.keys(holdings).forEach(sym => {
          const c = d[sym]?.cur;
          if (c && (!peaks[sym] || c > peaks[sym])) peaks[sym] = c;
        });

        pf.actives.forEach(st => {
          if (!st.active) return;
          const sd = d[st.symbol];
          if (!sd) return;
          const pos = holdings[st.symbol];
          const sT = STRATS.find(s => s.id === st.type);
          if (!sT) return;
          const side = sT.side;

          const why = evalStrategy(st, sd, pos, peaks[st.symbol]);
          if (!why) return;

          const price = sd.cur;
          if (price <= 0) return;
          const tradeValue = cash * (st.cashPct || 0.25);
          const tq = +(tradeValue / price).toFixed(6);
          if (tq <= 0) return;
          const total = price * tq;

          if (side === "buy") {
            if (total > cash) return;
            cash -= total;
            const old = holdings[st.symbol] || { qty: 0, avgCost: 0 };
            const nq = +(old.qty + tq).toFixed(6);
            holdings[st.symbol] = { qty: nq, avgCost: nq > 0 ? (old.avgCost * old.qty + total) / nq : price };
            peaks[st.symbol] = price;
          } else {
            const held = pos?.qty || 0;
            const sq = Math.min(tq, held);
            if (sq <= 0.000001) return;
            const sellTotal = price * sq;
            cash += sellTotal;
            // Track win/loss
            if (pos && pos.avgCost) {
              if (price > pos.avgCost) wins++;
              else losses++;
            }
            const nq = +(held - sq).toFixed(6);
            if (nq <= 0.000001) {
              const { [st.symbol]: _, ...rest } = holdings;
              holdings = rest;
            } else {
              holdings[st.symbol] = { ...holdings[st.symbol], qty: nq };
            }
          }

          tradeCount++;
          const finalQty = side === "sell" ? Math.min(tq, pos?.qty || tq) : tq;
          orders = [{ id: Date.now() + Math.random(), sym: st.symbol, side, qty: finalQty, price, total: price * finalQty, time: new Date(), strat: sT.label, why }, ...orders].slice(0, 200);
          log = [{ time: new Date(), strat: sT.label, symbol: st.symbol, side, qty: tq, price, why }, ...log].slice(0, 100);
          changed = true;
        });

        // Record portfolio value history
        const hVal = Object.entries(holdings).reduce((s, [sym, h]) => s + (h?.qty || 0) * (d[sym]?.cur || 0), 0);
        const tv = cash + hVal;
        const history = [...pf.history, { t: pf.history.length, value: tv }].slice(-300);

        return { ...pf, cash, holdings, orders, log, peaks, history, tradeCount, wins, losses };
      }));
    }, TICK_MS * TICKS_PER_CANDLE + 200);
    return () => clearInterval(iv);
  }, []);

  // Derived values
  const sd = data[selected];
  const ch = sd.cur - (sd.candles[0]?.o || sd.cur);
  const chP = sd.candles.length > 0 ? ch / (sd.candles[0]?.o || sd.cur) : 0;

  const chartCandles = sd.candles.slice(-60).map((c, i) => ({
    t: i, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
    fill: c.c >= c.o ? "#22c55e" : "#ef4444",
  }));

  const iS = { padding: "5px 7px", borderRadius: 4, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 11, fontFamily: "var(--m)", outline: "none", width: "100%" };

  // Portfolio stats
  const pfStats = portfolios.map(pf => {
    const hVal = Object.entries(pf.holdings).reduce((s, [sym, h]) => s + (h?.qty || 0) * (data[sym]?.cur || 0), 0);
    const tv = pf.cash + hVal;
    const pnl = tv - pf.startCash;
    const pnlPct = pnl / pf.startCash;
    return { ...pf, totalValue: tv, hVal, pnl, pnlPct };
  });

  // Build comparison chart data
  const maxLen = Math.max(...pfStats.map(pf => pf.history.length));
  const compData = [];
  for (let i = 0; i < maxLen; i++) {
    const point = { t: i };
    pfStats.forEach(pf => {
      const h = pf.history[i];
      point[pf.id] = h ? h.value : (pf.history[pf.history.length - 1]?.value || DEFAULT_CASH);
    });
    compData.push(point);
  }

  const resetPortfolio = (id) => {
    const profile = PROFILES.find(p => p.id === id);
    if (!profile) return;
    setPortfolios(prev => prev.map(pf => pf.id === id ? initPortfolio(profile) : pf));
    notify(`${profile.name} portfolio reset`);
  };

  return (
    <div style={{ "--m": "'JetBrains Mono',monospace", "--h": "'Space Grotesk',sans-serif", minHeight: "100vh", background: "#0a0e17", color: "#e2e8f0", fontFamily: "'Space Grotesk',sans-serif" }}>

      {notif && <div style={{ position: "fixed", top: 16, right: 16, zIndex: 1000, padding: "10px 20px", borderRadius: 8, background: notif.type === "buy" ? "#14532d" : "#1e293b", border: `1px solid ${notif.type === "buy" ? "#22c55e" : "#334155"}`, color: "#f1f5f9", fontSize: 13, fontWeight: 500, animation: "fsi .2s", boxShadow: "0 8px 32px rgba(0,0,0,0.4)", fontFamily: "var(--m)" }}>{notif.msg}</div>}

      {/* HEADER */}
      <div style={{ padding: "10px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(10,14,23,0.95)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px rgba(34,197,94,0.5)", animation: "pulse 2s infinite" }} />
          <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: "#f8fafc" }}>TRADE<span style={{ color: "#f59e0b" }}>SIMBOT</span></span>
          <span style={{ fontSize: 10, color: "#f59e0b", background: "rgba(245,158,11,0.1)", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)", fontWeight: 600 }}>6 CRYPTO | 1M CANDLES</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontFamily: "var(--m)", fontSize: 11 }}>
          {pfStats.map(pf => (
            <span key={pf.id}>
              <span style={{ color: pf.color, fontWeight: 600 }}>{pf.icon} </span>
              <span style={{ color: pf.pnl >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#0d1117" }}>
        {[["compare", "Compare"], ["chart", "Chart & TA"], ["portfolios", "Portfolios"], ["log", "Trade Log"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: "9px 20px", fontSize: 12, fontWeight: 500, background: "none", border: "none", cursor: "pointer", color: tab === k ? "#f8fafc" : "#6b7280", borderBottom: tab === k ? "2px solid #f59e0b" : "2px solid transparent", fontFamily: "var(--h)" }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 85px)" }}>
        {/* LEFT SIDEBAR */}
        <div style={{ width: 210, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto", background: "#0d1117", flexShrink: 0 }}>
          <div style={{ padding: "8px 14px", fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 700, letterSpacing: "0.1em", borderBottom: "1px solid rgba(255,255,255,0.04)", background: "rgba(255,255,255,0.02)" }}>MARKETS</div>
          {Object.entries(COINS).map(([sym, c]) => {
            const d2 = data[sym]; const p = d2.cur; const open = d2.candles[0]?.o || p;
            const d = p - open; const dp = d / open;
            return (
              <div key={sym} className="sr" onClick={() => { setSelected(sym); setTab("chart"); }}
                style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.03)", background: selected === sym ? "rgba(245,158,11,0.08)" : "transparent", borderLeft: selected === sym ? "2px solid #f59e0b" : "2px solid transparent" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontFamily: "var(--m)", fontWeight: 700, fontSize: 14, color: symColor(sym) }}>{sym}</div>
                    <div style={{ fontSize: 10, color: "#6b7280" }}>{c.name}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: "var(--m)", fontSize: 13, fontWeight: 600, color: "#f8fafc" }}>${fmt(p)}</div>
                    <div style={{ fontFamily: "var(--m)", fontSize: 10, color: d >= 0 ? "#22c55e" : "#ef4444" }}>{pc(dp)}</div>
                  </div>
                </div>
              </div>
            );
          })}
          {/* Indicators */}
          <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 6 }}>INDICATORS · {selected}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <IndBadge label="RSI" value={sd.rsi?.toFixed(1)} color={sd.rsi < 30 ? "#22c55e" : sd.rsi > 70 ? "#ef4444" : "#f8fafc"} />
              <IndBadge label="MACD" value={sd.macd?.hist?.toFixed(2)} color={sd.macd?.hist > 0 ? "#22c55e" : "#ef4444"} />
              <IndBadge label="EMA9" value={`$${fmt(sd.ema9 || 0)}`} color="#22d3ee" />
              <IndBadge label="EMA21" value={`$${fmt(sd.ema21 || 0)}`} color="#f59e0b" />
              <IndBadge label="Stoch" value={sd.stoch?.k?.toFixed(0)} color={sd.stoch?.k < 20 ? "#22c55e" : sd.stoch?.k > 80 ? "#ef4444" : "#f8fafc"} />
              <IndBadge label="ADX" value={sd.adx?.toFixed(0)} color={sd.adx > 25 ? "#f59e0b" : "#6b7280"} />
              <IndBadge label="Candles" value={`${sd.candles.length}`} color="#6b7280" />
            </div>
          </div>
        </div>

        {/* MAIN CONTENT */}
        <div style={{ flex: 1, overflow: "auto" }}>

          {/* ════════ COMPARE TAB ════════ */}
          {tab === "compare" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 4 }}>Portfolio Race</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 16 }}>4 risk profiles trading simultaneously on the same market data</div>

              {/* Performance Chart */}
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 8 }}>PORTFOLIO VALUE OVER TIME</div>
                {compData.length > 2 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={compData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="t" hide />
                      <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={v => `$${fK(v)}`} />
                      <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} formatter={(v) => [`$${fK(v)}`, ""]} />
                      {PROFILES.map(p => (
                        <Area key={p.id} type="monotone" dataKey={p.id} name={p.name} stroke={p.color} fill={p.color} fillOpacity={0.08} strokeWidth={2} dot={false} isAnimationActive={false} />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>Warming up... strategies trigger on candle close</div>
                )}
              </div>

              {/* Portfolio Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
                {pfStats.sort((a, b) => b.pnl - a.pnl).map((pf, rank) => {
                  const winRate = pf.wins + pf.losses > 0 ? (pf.wins / (pf.wins + pf.losses) * 100).toFixed(0) : "--";
                  return (
                    <div key={pf.id} style={{ background: "#0f172a", borderRadius: 10, padding: 16, border: `1px solid ${rank === 0 && pf.pnl > 0 ? pf.color + "66" : "rgba(255,255,255,0.04)"}`, position: "relative" }}>
                      {rank === 0 && pf.pnl > 0 && <div style={{ position: "absolute", top: 8, right: 10, fontSize: 8, background: "rgba(245,158,11,0.2)", color: "#f59e0b", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)", fontWeight: 700 }}>LEADING</div>}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <span style={{ fontSize: 20 }}>{pf.icon}</span>
                        <div>
                          <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 15, color: pf.color }}>{pf.name}</div>
                          <div style={{ fontSize: 9, color: "#6b7280" }}>{pf.desc}</div>
                        </div>
                      </div>

                      <div style={{ fontFamily: "var(--m)", fontSize: 24, fontWeight: 700, color: "#f8fafc", marginBottom: 4 }}>${fK(pf.totalValue)}</div>
                      <div style={{ fontFamily: "var(--m)", fontSize: 14, color: pf.pnl >= 0 ? "#22c55e" : "#ef4444", marginBottom: 12 }}>
                        {pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)} ({pc(pf.pnlPct)})
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 10, fontFamily: "var(--m)" }}>
                        <div style={{ background: "#0a0e17", borderRadius: 4, padding: "6px 8px" }}>
                          <div style={{ color: "#6b7280", fontSize: 8 }}>CASH</div>
                          <div style={{ color: "#94a3b8" }}>${fK(pf.cash)}</div>
                        </div>
                        <div style={{ background: "#0a0e17", borderRadius: 4, padding: "6px 8px" }}>
                          <div style={{ color: "#6b7280", fontSize: 8 }}>POSITIONS</div>
                          <div style={{ color: "#94a3b8" }}>${fK(pf.hVal)}</div>
                        </div>
                        <div style={{ background: "#0a0e17", borderRadius: 4, padding: "6px 8px" }}>
                          <div style={{ color: "#6b7280", fontSize: 8 }}>TRADES</div>
                          <div style={{ color: "#94a3b8" }}>{pf.tradeCount}</div>
                        </div>
                        <div style={{ background: "#0a0e17", borderRadius: 4, padding: "6px 8px" }}>
                          <div style={{ color: "#6b7280", fontSize: 8 }}>WIN RATE</div>
                          <div style={{ color: winRate !== "--" && parseInt(winRate) >= 50 ? "#22c55e" : "#ef4444" }}>{winRate}%</div>
                        </div>
                      </div>

                      {Object.keys(pf.holdings).length > 0 && (
                        <div style={{ marginTop: 8, display: "flex", gap: 3, flexWrap: "wrap" }}>
                          {Object.entries(pf.holdings).slice(0, 8).map(([sym, h]) => (
                            <span key={sym} style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "rgba(255,255,255,0.04)", color: symColor(sym), fontFamily: "var(--m)", fontWeight: 600 }}>{sym} {h.qty.toFixed(h.qty < 1 ? 4 : 2)}</span>
                          ))}
                          {Object.keys(pf.holdings).length > 8 && <span style={{ fontSize: 8, color: "#6b7280" }}>+{Object.keys(pf.holdings).length - 8}</span>}
                        </div>
                      )}

                      <button onClick={() => resetPortfolio(pf.id)} className="bt" style={{ marginTop: 8, width: "100%", padding: "5px 0", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#6b7280", fontSize: 9, fontWeight: 600, fontFamily: "var(--h)", cursor: "pointer" }}>RESET</button>
                    </div>
                  );
                })}
              </div>

              {/* Leaderboard Table */}
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", overflow: "hidden" }}>
                <div style={{ padding: "10px 16px", fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>LEADERBOARD</div>
                <div style={{ display: "grid", gridTemplateColumns: "30px 1fr 90px 90px 90px 70px 60px", padding: "6px 16px", fontSize: 9, color: "#4b5563", fontFamily: "var(--h)", fontWeight: 600 }}>
                  <span>#</span><span>PORTFOLIO</span><span>VALUE</span><span>P&L</span><span>P&L %</span><span>TRADES</span><span>WIN %</span>
                </div>
                {pfStats.sort((a, b) => b.pnl - a.pnl).map((pf, i) => {
                  const wr = pf.wins + pf.losses > 0 ? (pf.wins / (pf.wins + pf.losses) * 100).toFixed(0) : "--";
                  return (
                    <div key={pf.id} style={{ display: "grid", gridTemplateColumns: "30px 1fr 90px 90px 90px 70px 60px", padding: "8px 16px", fontSize: 11, fontFamily: "var(--m)", borderTop: "1px solid rgba(255,255,255,0.02)", background: i === 0 ? "rgba(245,158,11,0.03)" : "transparent" }}>
                      <span style={{ color: i === 0 ? "#f59e0b" : "#6b7280", fontWeight: 700 }}>{i + 1}</span>
                      <span style={{ color: pf.color, fontWeight: 600 }}>{pf.icon} {pf.name}</span>
                      <span style={{ color: "#f8fafc" }}>${fK(pf.totalValue)}</span>
                      <span style={{ color: pf.pnl >= 0 ? "#22c55e" : "#ef4444" }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)}</span>
                      <span style={{ color: pf.pnl >= 0 ? "#22c55e" : "#ef4444" }}>{pc(pf.pnlPct)}</span>
                      <span style={{ color: "#94a3b8" }}>{pf.tradeCount}</span>
                      <span style={{ color: wr !== "--" && parseInt(wr) >= 50 ? "#22c55e" : "#ef4444" }}>{wr}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ════════ CHART TAB ════════ */}
          {tab === "chart" && (() => {
            const maxVol = Math.max(...chartCandles.map(c => c.v), 1);
            const avgVol = chartCandles.length > 0 ? chartCandles.reduce((s, c) => s + c.v, 0) / chartCandles.length : 1;
            return (
            <div style={{ padding: "16px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                  <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 24, color: symColor(selected) }}>{selected}/USDT</span>
                  <span style={{ fontSize: 10, background: "rgba(245,158,11,0.1)", color: "#f59e0b", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)" }}>1M</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {["candle", "line"].map(t => (
                    <button key={t} onClick={() => setChartType(t)} style={{ padding: "3px 10px", fontSize: 10, fontFamily: "var(--m)", fontWeight: 600, borderRadius: 4, border: "1px solid", borderColor: chartType === t ? "#f59e0b" : "#1e293b", background: chartType === t ? "rgba(245,158,11,0.15)" : "transparent", color: chartType === t ? "#f59e0b" : "#6b7280", cursor: "pointer" }}>{t === "candle" ? "Candle" : "Line"}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
                <span style={{ fontFamily: "var(--m)", fontSize: 32, fontWeight: 600, color: "#f8fafc" }}>${fmt(sd.cur)}</span>
                <span style={{ fontFamily: "var(--m)", fontSize: 16, color: ch >= 0 ? "#22c55e" : "#ef4444" }}>{ch >= 0 ? "+" : ""}{fmt(ch)} ({pc(chP)})</span>
              </div>

              {chartCandles.length > 2 ? (
                chartType === "candle" ? (
                  /* ── CANDLESTICK CHART (SVG) ── */
                  <div style={{ background: "#0f172a", borderRadius: 8, padding: "12px 8px", border: "1px solid rgba(255,255,255,0.04)" }}>
                    <svg width="100%" height="340" viewBox={`0 0 ${chartCandles.length * 14 + 20} 340`} preserveAspectRatio="none" style={{ display: "block" }}>
                      {(() => {
                        const prices = chartCandles.flatMap(c => [c.h, c.l]);
                        const minP = Math.min(...prices); const maxP = Math.max(...prices);
                        const range = maxP - minP || 1;
                        const yScale = (v) => 330 - ((v - minP) / range) * 320;
                        const w = 8; const gap = 6;
                        // BB bands
                        const bbU = sd.bb?.upper || 0; const bbL = sd.bb?.lower || 0;
                        return (
                          <g>
                            {bbU > 0 && <line x1="0" y1={yScale(bbU)} x2={chartCandles.length * (w + gap)} y2={yScale(bbU)} stroke="#6366f1" strokeDasharray="4 4" strokeWidth="0.5" opacity="0.5" />}
                            {bbL > 0 && <line x1="0" y1={yScale(bbL)} x2={chartCandles.length * (w + gap)} y2={yScale(bbL)} stroke="#6366f1" strokeDasharray="4 4" strokeWidth="0.5" opacity="0.5" />}
                            {sd.ema9 > 0 && <line x1="0" y1={yScale(sd.ema9)} x2={chartCandles.length * (w + gap)} y2={yScale(sd.ema9)} stroke="#22d3ee" strokeDasharray="3 3" strokeWidth="0.5" opacity="0.6" />}
                            {sd.ema21 > 0 && <line x1="0" y1={yScale(sd.ema21)} x2={chartCandles.length * (w + gap)} y2={yScale(sd.ema21)} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth="0.5" opacity="0.6" />}
                            {chartCandles.map((c, i) => {
                              const x = i * (w + gap) + 10;
                              const green = c.c >= c.o;
                              const color = green ? "#22c55e" : "#ef4444";
                              const bodyTop = yScale(Math.max(c.o, c.c));
                              const bodyBot = yScale(Math.min(c.o, c.c));
                              const bodyH = Math.max(bodyBot - bodyTop, 1);
                              return (
                                <g key={i}>
                                  <line x1={x + w / 2} y1={yScale(c.h)} x2={x + w / 2} y2={yScale(c.l)} stroke={color} strokeWidth="1" />
                                  <rect x={x} y={bodyTop} width={w} height={bodyH} fill={green ? color : color} rx="1" />
                                </g>
                              );
                            })}
                          </g>
                        );
                      })()}
                    </svg>
                  </div>
                ) : (
                  /* ── LINE CHART ── */
                  <ResponsiveContainer width="100%" height={340}>
                    <ComposedChart data={chartCandles} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                      <XAxis dataKey="t" hide />
                      <YAxis domain={["auto", "auto"]} hide />
                      <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} labelFormatter={() => ""} formatter={(v, name) => [`$${fmt(v)}`, name === "c" ? "Close" : name]} />
                      {sd.bb?.mid > 0 && <ReferenceLine y={sd.bb.upper} stroke="#6366f1" strokeDasharray="3 3" strokeWidth={0.5} />}
                      {sd.bb?.mid > 0 && <ReferenceLine y={sd.bb.lower} stroke="#6366f1" strokeDasharray="3 3" strokeWidth={0.5} />}
                      {sd.ema9 > 0 && <ReferenceLine y={sd.ema9} stroke="#22d3ee" strokeDasharray="2 2" strokeWidth={0.5} />}
                      {sd.ema21 > 0 && <ReferenceLine y={sd.ema21} stroke="#f59e0b" strokeDasharray="2 2" strokeWidth={0.5} />}
                      <Line type="monotone" dataKey="c" stroke={ch >= 0 ? "#22c55e" : "#ef4444"} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )
              ) : (
                <div style={{ height: 340, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>Loading candle data...</div>
              )}

              {/* ── VOLUME BARS (readable) ── */}
              {chartCandles.length > 2 && (
                <div style={{ marginTop: 8, background: "#0f172a", borderRadius: 6, padding: "8px 12px", border: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600 }}>VOLUME</span>
                    <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--m)" }}>avg: {fK(avgVol)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 40 }}>
                    {chartCandles.map((c, i) => {
                      const pct = c.v / maxVol;
                      const isHigh = c.v > avgVol * 1.5;
                      return (
                        <div key={i} title={`Vol: ${fK(c.v)}`} style={{ flex: 1, height: `${Math.max(pct * 100, 2)}%`, borderRadius: "2px 2px 0 0", background: isHigh ? (c.c >= c.o ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)") : "rgba(99,102,241,0.2)", transition: "height 0.2s" }} />
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <IndBadge label="RSI(14)" value={sd.rsi?.toFixed(1)} color={sd.rsi < 30 ? "#22c55e" : sd.rsi > 70 ? "#ef4444" : "#f8fafc"} />
                <IndBadge label="MACD" value={sd.macd?.hist?.toFixed(2)} color={sd.macd?.hist > 0 ? "#22c55e" : "#ef4444"} />
                <IndBadge label="BB" value={`${fmt(sd.bb?.lower || 0)} — ${fmt(sd.bb?.upper || 0)}`} color="#a5b4fc" />
                <IndBadge label="EMA9" value={`$${fmt(sd.ema9)}`} color="#22d3ee" />
                <IndBadge label="EMA21" value={`$${fmt(sd.ema21)}`} color="#f59e0b" />
                <IndBadge label="Stoch" value={sd.stoch?.k?.toFixed(0)} color={sd.stoch?.k < 20 ? "#22c55e" : sd.stoch?.k > 80 ? "#ef4444" : "#f8fafc"} />
                <IndBadge label="ADX" value={sd.adx?.toFixed(0)} color={sd.adx > 25 ? "#f59e0b" : "#6b7280"} />
              </div>
            </div>
            );
          })()}

          {/* ════════ PORTFOLIOS TAB ════════ */}
          {tab === "portfolios" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 16 }}>Portfolio Details</div>
              {pfStats.map(pf => (
                <div key={pf.id} style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{pf.icon}</span>
                      <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: pf.color }}>{pf.name}</span>
                      <span style={{ fontSize: 9, color: "#6b7280" }}>{pf.desc}</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: "var(--m)", fontSize: 18, fontWeight: 600, color: "#f8fafc" }}>${fK(pf.totalValue)}</div>
                      <div style={{ fontFamily: "var(--m)", fontSize: 12, color: pf.pnl >= 0 ? "#22c55e" : "#ef4444" }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)} ({pc(pf.pnlPct)})</div>
                    </div>
                  </div>

                  {/* Strategy config summary */}
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
                    {Object.entries(PROFILES.find(p => p.id === pf.id)?.overrides || {}).map(([k, v]) => {
                      const st = STRATS.find(s => s.id === k);
                      return st ? (
                        <span key={k} style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: st.side === "buy" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: st.side === "buy" ? "#22c55e" : "#ef4444", fontFamily: "var(--m)" }}>{st.label}: {v}</span>
                      ) : null;
                    })}
                  </div>

                  {/* Holdings */}
                  {Object.keys(pf.holdings).length === 0 ? (
                    <div style={{ fontSize: 11, color: "#374151", textAlign: "center", padding: 8 }}>No positions yet</div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6 }}>
                      {Object.entries(pf.holdings).map(([sym, h]) => {
                        if (!h || !h.qty) return null;
                        const p = data[sym]?.cur || 0;
                        const v = h.qty * p;
                        const pl = (p - h.avgCost) * h.qty;
                        return (
                          <div key={sym} style={{ background: "#0a0e17", borderRadius: 6, padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontFamily: "var(--m)", fontWeight: 600, fontSize: 12, color: symColor(sym) }}>{sym}</span>
                              <span style={{ fontSize: 9, color: "#6b7280", marginLeft: 6 }}>{h.qty.toFixed(h.qty < 1 ? 4 : 2)}</span>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontFamily: "var(--m)", fontSize: 11, color: "#f8fafc" }}>${fmt(v)}</div>
                              <div style={{ fontFamily: "var(--m)", fontSize: 9, color: pl >= 0 ? "#22c55e" : "#ef4444" }}>{pl >= 0 ? "+" : ""}${fmt(pl)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ════════ LOG TAB ════════ */}
          {tab === "log" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 16 }}>Trade Log</div>
              {pfStats.map(pf => (
                <div key={pf.id} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 14 }}>{pf.icon}</span>
                    <span style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 13, color: pf.color }}>{pf.name}</span>
                    <span style={{ fontSize: 9, color: "#6b7280" }}>{pf.orders.length} trades</span>
                  </div>
                  {pf.orders.length === 0 ? (
                    <div style={{ fontSize: 11, color: "#374151", padding: 8 }}>No trades yet</div>
                  ) : (
                    <div style={{ background: "#0f172a", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)", maxHeight: 200, overflowY: "auto" }}>
                      {pf.orders.slice(0, 50).map(o => (
                        <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: "1px solid rgba(255,255,255,0.02)", fontFamily: "var(--m)", fontSize: 10 }}>
                          <span style={{ color: "#4b5563", minWidth: 52 }}>{typeof o.time === "string" ? new Date(o.time).toLocaleTimeString() : o.time.toLocaleTimeString()}</span>
                          <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: o.side === "buy" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: o.side === "buy" ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{o.side === "buy" ? "BUY" : "SELL"}</span>
                          <span style={{ color: symColor(o.sym), fontWeight: 700 }}>{o.sym}</span>
                          <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fK(o.price * o.qty)}</span>
                          <span style={{ color: "#6366f1", fontWeight: 600 }}>{o.strat}</span>
                          {o.why && <span style={{ color: "#a78bfa", fontWeight: 600 }}>| {o.why}</span>}
                          <span style={{ color: "#4b5563", fontSize: 9 }}>{o.qty.toFixed(4)}x${fmt(o.price)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
