import { useState, useEffect, useRef, useCallback } from "react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ReferenceLine } from "recharts";

const DEFAULT_CASH = 10000; // USDT
const TICK_MS = 1500;
const TICKS_PER_CANDLE = 4; // 4 ticks = 1 candle (simulated 5m)

const COINS = {
  BTC: { name: "Bitcoin", price: 67450, vol: 0.006, drift: 0.00005 },
  ETH: { name: "Ethereum", price: 3520, vol: 0.008, drift: 0.00003 },
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
  return { k, d: k }; // simplified
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

function tk(p, v, d) { return Math.max(p * 0.5, +(p + (Math.random() - 0.5) * 2 * v * p + d * p).toFixed(2)); }
function fmt(n) { return n < 1 ? n.toFixed(4) : n < 100 ? n.toFixed(2) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fK(n) { if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K"; return fmt(n); }
function pc(n) { return (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%"; }

function initState() {
  const p = {};
  Object.entries(COINS).forEach(([s, c]) => {
    p[s] = {
      cur: c.price, candles: [], building: { o: c.price, h: c.price, l: c.price, c: c.price, v: Math.random() * 100 + 50, tickCount: 0 },
      // Indicator caches
      rsi: 50, macd: { macd: 0, signal: 0, hist: 0 }, bb: { upper: 0, mid: 0, lower: 0 },
      ema9: 0, ema21: 0, ema50: 0, ema200: 0,
      stoch: { k: 50, d: 50 }, adx: 20, vwap: c.price,
      prevMacdHist: 0,
    };
  });
  return p;
}

// 30 TA STRATEGIES
const STRATS = [
  // BUY (15)
  { id: "rsi_ob", label: "RSI Aşırı Satım", icon: "📊", desc: "RSI < X olunca al (varsayılan 30)", side: "buy", param: "rsi", def: 30, ds: "BTC" },
  { id: "macd_cross_b", label: "MACD Crossover Al", icon: "📈", desc: "MACD sinyal çizgisini yukarı kesince al", side: "buy", param: "trigger", def: 1, ds: "ETH" },
  { id: "bb_lower", label: "Bollinger Alt Bant", icon: "📉", desc: "Fiyat alt bandın X% altına düşünce al", side: "buy", param: "pct", def: 0.1, ds: "BTC" },
  { id: "ema_golden", label: "EMA 9/21 Golden Cross", icon: "✨", desc: "EMA9, EMA21'i yukarı kesince al", side: "buy", param: "trigger", def: 1, ds: "ETH" },
  { id: "ema50_bounce", label: "EMA 50 Destek", icon: "🛡️", desc: "Fiyat EMA50'ye yaklaşıp sıçrayınca al", side: "buy", param: "pct", def: 0.3, ds: "BTC" },
  { id: "stoch_ob", label: "Stochastic Oversold", icon: "🔄", desc: "Stochastic K < X olunca al", side: "buy", param: "rsi", def: 20, ds: "ETH" },
  { id: "vol_spike_b", label: "Hacim Patlaması Al", icon: "🔊", desc: "Yeşil mumda hacim ortalamanın X katı", side: "buy", param: "mult", def: 1.5, ds: "BTC" },
  { id: "hammer", label: "Çekiç Mum Al", icon: "🔨", desc: "Çekiç formasyonu tespit edilince al", side: "buy", param: "trigger", def: 1, ds: "ETH" },
  { id: "engulf_b", label: "Yutan Boğa Mumu", icon: "🐂", desc: "Bullish engulfing formasyonu al", side: "buy", param: "trigger", def: 1, ds: "BTC" },
  { id: "vwap_buy", label: "VWAP Altı Al", icon: "📐", desc: "Fiyat VWAP'ın X% altındayken al", side: "buy", param: "pct", def: 0.3, ds: "ETH" },
  { id: "adx_trend_b", label: "ADX Güçlü Trend Al", icon: "💪", desc: "ADX > X ve fiyat yükseliyorsa al", side: "buy", param: "rsi", def: 25, ds: "BTC" },
  { id: "fib_buy", label: "Fibonacci %61.8 Al", icon: "🌀", desc: "Fiyat %61.8 Fib seviyesine gelince al", side: "buy", param: "pct", def: 0.618, ds: "ETH" },
  { id: "dip_rsi_macd", label: "RSI+MACD Combo Al", icon: "🎯", desc: "RSI<40 VE MACD histogram pozitife dönünce", side: "buy", param: "rsi", def: 40, ds: "BTC" },
  { id: "breakout_high", label: "Direnç Kırılımı", icon: "💥", desc: "Fiyat son X mumun en yükseğini kırınca", side: "buy", param: "period", def: 10, ds: "ETH" },
  { id: "ema200_trend", label: "EMA 200 Üstü Trend", icon: "🏔️", desc: "Fiyat EMA200 üstüne çıkınca al", side: "buy", param: "trigger", def: 1, ds: "BTC" },
  // SELL (15)
  { id: "rsi_os", label: "RSI Aşırı Alım Sat", icon: "📊", desc: "RSI > X olunca sat (varsayılan 70)", side: "sell", param: "rsi", def: 70, ds: "BTC" },
  { id: "macd_cross_s", label: "MACD Crossover Sat", icon: "📉", desc: "MACD sinyal çizgisini aşağı kesince sat", side: "sell", param: "trigger", def: 1, ds: "ETH" },
  { id: "bb_upper", label: "Bollinger Üst Bant", icon: "📈", desc: "Fiyat üst bandın X% üstüne çıkınca sat", side: "sell", param: "pct", def: 0.1, ds: "BTC" },
  { id: "ema_death", label: "EMA 9/21 Death Cross", icon: "💀", desc: "EMA9, EMA21'i aşağı kesince sat", side: "sell", param: "trigger", def: 1, ds: "ETH" },
  { id: "stoch_os", label: "Stochastic Overbought", icon: "🔄", desc: "Stochastic K > X olunca sat", side: "sell", param: "rsi", def: 80, ds: "BTC" },
  { id: "vol_spike_s", label: "Hacim Patlaması Sat", icon: "🔊", desc: "Kırmızı mumda yüksek hacim sat", side: "sell", param: "mult", def: 1.5, ds: "ETH" },
  { id: "shooting_star", label: "Kayan Yıldız Sat", icon: "⭐", desc: "Shooting star formasyonu sat", side: "sell", param: "trigger", def: 1, ds: "BTC" },
  { id: "engulf_s", label: "Yutan Ayı Mumu", icon: "🐻", desc: "Bearish engulfing formasyonu sat", side: "sell", param: "trigger", def: 1, ds: "ETH" },
  { id: "vwap_sell", label: "VWAP Üstü Sat", icon: "📐", desc: "Fiyat VWAP'ın X% üstündeyken sat", side: "sell", param: "pct", def: 0.3, ds: "BTC" },
  { id: "tp_pct", label: "Kar Al (%)", icon: "💰", desc: "Pozisyon P&L +X% olunca sat", side: "sell", param: "pct", def: 1.5, ds: "ETH" },
  { id: "sl_pct", label: "Zarar Kes (%)", icon: "🛑", desc: "Pozisyon P&L -X% olunca sat", side: "sell", param: "pct", def: 1, ds: "BTC" },
  { id: "trailing", label: "Trailing Stop", icon: "📏", desc: "Fiyat zirveden X% düşünce sat", side: "sell", param: "pct", def: 0.8, ds: "ETH" },
  { id: "breakdown", label: "Destek Kırılımı Sat", icon: "⬇️", desc: "Fiyat son X mumun en düşüğünü kırınca", side: "sell", param: "period", def: 10, ds: "BTC" },
  { id: "dip_rsi_macd_s", label: "RSI+MACD Combo Sat", icon: "🎯", desc: "RSI>60 VE MACD histogram negatife dönünce", side: "sell", param: "rsi", def: 60, ds: "ETH" },
  { id: "ema200_break", label: "EMA 200 Altı Sat", icon: "🏔️", desc: "Fiyat EMA200 altına düşünce sat", side: "sell", param: "trigger", def: 1, ds: "BTC" },
];

export default function App() {
  const [startCash, setStartCash] = useState(DEFAULT_CASH);
  const [data, setData] = useState(initState);
  const [cash, setCash] = useState(DEFAULT_CASH);
  const [holdings, setHoldings] = useState({});
  const [selected, setSelected] = useState("BTC");
  const [orders, setOrders] = useState([]);
  const [tab, setTab] = useState("auto");
  const [notif, setNotif] = useState(null);
  const ntRef = useRef(null);
  const [showReset, setShowReset] = useState(false);
  const [showCap, setShowCap] = useState(false);
  const [capIn, setCapIn] = useState(DEFAULT_CASH.toString());
  const [rstIn, setRstIn] = useState(DEFAULT_CASH.toString());
  const [stratFilter, setStratFilter] = useState("all");
  const peakRef = useRef({});

  const initCard = () => { const s = {}; STRATS.forEach(st => { s[st.id] = { symbol: st.ds, value: st.def, qty: st.ds === "BTC" ? 0.01 : 0.1 }; }); return s; };
  const [cardCfg, setCardCfg] = useState(initCard);
  const [actives, setActives] = useState([]);
  const logRef = useRef([]);
  const [autoLog, setAutoLog] = useState([]);
  const [autoOn, setAutoOn] = useState(true);

  const cR = useRef(cash); const hR = useRef(holdings); const dR = useRef(data);
  useEffect(() => { cR.current = cash; }, [cash]);
  useEffect(() => { hR.current = holdings; }, [holdings]);
  useEffect(() => { dR.current = data; }, [data]);

  const notify = useCallback((msg, type = "info") => {
    if (ntRef.current) clearTimeout(ntRef.current);
    setNotif({ msg, type });
    ntRef.current = setTimeout(() => setNotif(null), 2500);
  }, []);

  // ─── PRICE + CANDLE ENGINE ───
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
            // Close candle
            candles = [...candles, { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: Date.now() }].slice(-200);
            const closes = candles.map(c => c.c);
            const highs = candles.map(c => c.h);
            const lows = candles.map(c => c.l);

            indicators = {
              rsi: calcRSI(closes),
              macd: calcMACD(closes),
              bb: calcBB(closes),
              ema9: ema(closes, 9) || np,
              ema21: ema(closes, 21) || np,
              ema50: ema(closes, 50) || np,
              ema200: ema(closes, 200) || np,
              stoch: calcStoch(highs, lows, closes),
              adx: calcADX(highs, lows, closes),
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
    }, TICK_MS);
    return () => clearInterval(iv);
  }, []);

  // Peak tracker
  useEffect(() => { Object.keys(holdings).forEach(sym => { const c = data[sym]?.cur; if (c && (!peakRef.current[sym] || c > peakRef.current[sym])) peakRef.current[sym] = c; }); }, [data, holdings]);

  // ─── AUTO ENGINE ───
  useEffect(() => {
    if (!autoOn || actives.length === 0) return;
    const iv = setInterval(() => {
      const d = dR.current; const c = cR.current; const h = hR.current;
      actives.forEach(st => {
        if (!st.active) return;
        const sd = d[st.symbol]; if (!sd || sd.candles.length < 5) return;
        const pos = h[st.symbol];
        const candles = sd.candles;
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
        let go = false, why = "";

        switch (st.type) {
          case "rsi_ob": { if (sd.rsi <= st.value) { go = true; why = `RSI ${sd.rsi.toFixed(0)}`; } break; }
          case "rsi_os": { if (pos?.qty > 0 && sd.rsi >= st.value) { go = true; why = `RSI ${sd.rsi.toFixed(0)}`; } break; }
          case "macd_cross_b": { if (sd.macd.hist > 0 && sd.prevMacdHist <= 0) { go = true; why = `MACD↑ ${sd.macd.hist.toFixed(1)}`; } break; }
          case "macd_cross_s": { if (pos?.qty > 0 && sd.macd.hist < 0 && sd.prevMacdHist >= 0) { go = true; why = `MACD↓ ${sd.macd.hist.toFixed(1)}`; } break; }
          case "bb_lower": { if (sd.bb.lower > 0 && sd.cur <= sd.bb.lower * (1 - st.value / 100)) { go = true; why = `BB alt $${fmt(sd.bb.lower)}`; } break; }
          case "bb_upper": { if (pos?.qty > 0 && sd.bb.upper > 0 && sd.cur >= sd.bb.upper * (1 + st.value / 100)) { go = true; why = `BB üst $${fmt(sd.bb.upper)}`; } break; }
          case "ema_golden": { if (sd.ema9 > sd.ema21 && candles.length > 21) { const prevE9 = ema(candles.slice(0, -1).map(c => c.c), 9); if (prevE9 && prevE9 <= sd.ema21) { go = true; why = `EMA9>21 Golden`; } } break; }
          case "ema_death": { if (pos?.qty > 0 && sd.ema9 < sd.ema21 && candles.length > 21) { const prevE9 = ema(candles.slice(0, -1).map(c => c.c), 9); if (prevE9 && prevE9 >= sd.ema21) { go = true; why = `EMA9<21 Death`; } } break; }
          case "ema50_bounce": { if (sd.ema50 > 0) { const dist = ((sd.cur - sd.ema50) / sd.ema50) * 100; if (dist >= 0 && dist <= st.value && lastCandle.c > lastCandle.o) { go = true; why = `EMA50 sıçrama`; } } break; }
          case "stoch_ob": { if (sd.stoch.k <= st.value) { go = true; why = `Stoch K=${sd.stoch.k.toFixed(0)}`; } break; }
          case "stoch_os": { if (pos?.qty > 0 && sd.stoch.k >= st.value) { go = true; why = `Stoch K=${sd.stoch.k.toFixed(0)}`; } break; }
          case "vol_spike_b": { if (candles.length >= 10) { const avgVol = candles.slice(-10).reduce((a, c2) => a + c2.v, 0) / 10; if (lastCandle.v > avgVol * st.value && lastCandle.c > lastCandle.o) { go = true; why = `Hacim ${(lastCandle.v / avgVol).toFixed(1)}x`; } } break; }
          case "vol_spike_s": { if (pos?.qty > 0 && candles.length >= 10) { const avgVol = candles.slice(-10).reduce((a, c2) => a + c2.v, 0) / 10; if (lastCandle.v > avgVol * st.value && lastCandle.c < lastCandle.o) { go = true; why = `Hacim sat ${(lastCandle.v / avgVol).toFixed(1)}x`; } } break; }
          case "hammer": { if (prevCandle && lastCandle) { const body = Math.abs(lastCandle.c - lastCandle.o); const lowerWick = Math.min(lastCandle.o, lastCandle.c) - lastCandle.l; if (lowerWick > body * 2 && lastCandle.c > lastCandle.o) { go = true; why = `Çekiç mum`; } } break; }
          case "shooting_star": { if (pos?.qty > 0 && lastCandle) { const body = Math.abs(lastCandle.c - lastCandle.o); const upperWick = lastCandle.h - Math.max(lastCandle.o, lastCandle.c); if (upperWick > body * 2 && lastCandle.c < lastCandle.o) { go = true; why = `Kayan yıldız`; } } break; }
          case "engulf_b": { if (prevCandle && lastCandle && prevCandle.c < prevCandle.o && lastCandle.c > lastCandle.o && lastCandle.c > prevCandle.o && lastCandle.o < prevCandle.c) { go = true; why = `Boğa yutuş`; } break; }
          case "engulf_s": { if (pos?.qty > 0 && prevCandle && lastCandle && prevCandle.c > prevCandle.o && lastCandle.c < lastCandle.o && lastCandle.c < prevCandle.o && lastCandle.o > prevCandle.c) { go = true; why = `Ayı yutuş`; } break; }
          case "vwap_buy": { if (sd.vwap > 0) { const dist = ((sd.vwap - sd.cur) / sd.vwap) * 100; if (dist >= st.value) { go = true; why = `VWAP altı ${dist.toFixed(1)}%`; } } break; }
          case "vwap_sell": { if (pos?.qty > 0 && sd.vwap > 0) { const dist = ((sd.cur - sd.vwap) / sd.vwap) * 100; if (dist >= st.value) { go = true; why = `VWAP üstü ${dist.toFixed(1)}%`; } } break; }
          case "adx_trend_b": { if (sd.adx >= st.value && sd.cur > sd.ema21) { go = true; why = `ADX ${sd.adx.toFixed(0)} trend`; } break; }
          case "fib_buy": { if (candles.length >= 20) { const hi = Math.max(...candles.slice(-20).map(c2 => c2.h)); const lo = Math.min(...candles.slice(-20).map(c2 => c2.l)); const fib = hi - (hi - lo) * st.value; if (sd.cur <= fib && sd.cur > lo) { go = true; why = `Fib ${(st.value * 100).toFixed(1)}%`; } } break; }
          case "dip_rsi_macd": { if (sd.rsi < st.value && sd.macd.hist > 0 && sd.prevMacdHist <= 0) { go = true; why = `RSI${sd.rsi.toFixed(0)}+MACD↑`; } break; }
          case "dip_rsi_macd_s": { if (pos?.qty > 0 && sd.rsi > st.value && sd.macd.hist < 0 && sd.prevMacdHist >= 0) { go = true; why = `RSI${sd.rsi.toFixed(0)}+MACD↓`; } break; }
          case "breakout_high": { const n = Math.floor(st.value); if (candles.length >= n) { const hi = Math.max(...candles.slice(-n - 1, -1).map(c2 => c2.h)); if (sd.cur > hi) { go = true; why = `Kırılım > $${fmt(hi)}`; } } break; }
          case "breakdown": { if (pos?.qty > 0 && candles.length >= Math.floor(st.value)) { const lo = Math.min(...candles.slice(-Math.floor(st.value) - 1, -1).map(c2 => c2.l)); if (sd.cur < lo) { go = true; why = `Kırılım < $${fmt(lo)}`; } } break; }
          case "tp_pct": { if (pos?.qty > 0) { const pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl >= st.value) { go = true; why = `TP +${pl.toFixed(1)}%`; } } break; }
          case "sl_pct": { if (pos?.qty > 0) { const pl = ((sd.cur - pos.avgCost) / pos.avgCost) * 100; if (pl <= -st.value) { go = true; why = `SL ${pl.toFixed(1)}%`; } } break; }
          case "trailing": { if (pos?.qty > 0) { const pk = peakRef.current[st.symbol] || sd.cur; const dr = ((pk - sd.cur) / pk) * 100; if (dr >= st.value) { go = true; why = `Trail -${dr.toFixed(1)}%`; } } break; }
          case "ema200_trend": { if (sd.ema200 > 0 && sd.cur > sd.ema200 && candles.length > 200) { const prevC = candles[candles.length - 2]?.c; if (prevC && prevC <= sd.ema200) { go = true; why = `EMA200 üstü`; } } break; }
          case "ema200_break": { if (pos?.qty > 0 && sd.ema200 > 0 && sd.cur < sd.ema200 && candles.length > 200) { const prevC = candles[candles.length - 2]?.c; if (prevC && prevC >= sd.ema200) { go = true; why = `EMA200 altı`; } } break; }
        }

        if (go) {
          const sT = STRATS.find(s => s.id === st.type); const side = sT?.side || "buy";
          const price = sd.cur;
          const tq = st.qty;
          const total = price * tq;
          if (side === "buy") {
            if (total > c) return;
            setCash(v => v - total);
            setHoldings(v => { const o = v[st.symbol] || { qty: 0, avgCost: 0 }; const nq = +(o.qty + tq).toFixed(6); return { ...v, [st.symbol]: { qty: nq, avgCost: (o.avgCost * o.qty + total) / nq } }; });
            peakRef.current[st.symbol] = price;
          } else {
            const held = pos?.qty || 0;
            const sq = Math.min(tq, held);
            if (sq <= 0) return;
            setCash(v => v + price * sq);
            setHoldings(v => { const nq = +(v[st.symbol].qty - sq).toFixed(6); if (nq <= 0.000001) { const { [st.symbol]: _, ...r } = v; return r; } return { ...v, [st.symbol]: { ...v[st.symbol], qty: nq } }; });
          }
          setOrders(o => [{ id: Date.now() + Math.random(), sym: st.symbol, side, qty: side === "sell" ? Math.min(tq, pos?.qty || 0) : tq, price, time: new Date(), strat: sT?.label }, ...o].slice(0, 500));
          logRef.current = [{ time: new Date(), strat: sT?.label, symbol: st.symbol, side, qty: tq, price, why }, ...logRef.current].slice(0, 120);
          setAutoLog([...logRef.current]);
        }
      });
    }, TICK_MS * TICKS_PER_CANDLE + 200);
    return () => clearInterval(iv);
  }, [autoOn, actives]);

  const sd = data[selected]; const cfg = COINS[selected];
  const ch = sd.cur - (sd.candles[0]?.o || sd.cur);
  const chP = sd.candles.length > 0 ? ch / (sd.candles[0]?.o || sd.cur) : 0;
  const hVal = Object.entries(holdings).reduce((s, [sym, h]) => s + h.qty * data[sym].cur, 0);
  const tv = cash + hVal; const pnl = tv - startCash;

  const applyCap = () => { const v = parseFloat(capIn); if (!v || v < 100) return; const old = startCash; setStartCash(v); setCash(c => c + (v - old)); setShowCap(false); notify(`Sermaye → $${fK(v)}`); };
  const resetAll = () => { const v = parseFloat(rstIn) || DEFAULT_CASH; setStartCash(v); setCash(v); setHoldings({}); setOrders([]); setData(initState()); setActives([]); logRef.current = []; setAutoLog([]); peakRef.current = {}; setCardCfg(initCard()); setShowReset(false); notify("Sıfırlandı — $" + fK(v)); };
  const activate = (id) => { const st = STRATS.find(s => s.id === id); const cc = cardCfg[id]; setActives(v => [...v, { id: Date.now() + Math.random(), type: id, symbol: cc.symbol, value: parseFloat(cc.value) || st.def, qty: parseFloat(cc.qty) || (cc.symbol === "BTC" ? 0.01 : 0.1), active: true }]); };
  const activateAll = () => {
    const na = STRATS.map(st => { const cc = cardCfg[st.id]; return { id: Date.now() + Math.random() + Math.random(), type: st.id, symbol: cc.symbol, value: parseFloat(cc.value) || st.def, qty: parseFloat(cc.qty) || (cc.symbol === "BTC" ? 0.01 : 0.1), active: true }; });
    setActives(v => [...v, ...na]);
    notify(`🔥 30 TEKNİK ANALİZ STRATEJİSİ AKTİF!`, "buy");
  };
  const upCard = (id, k, v) => setCardCfg(o => ({ ...o, [id]: { ...o[id], [k]: v } }));
  const ac = actives.filter(s => s.active).length;
  const filteredStrats = stratFilter === "all" ? STRATS : STRATS.filter(s => s.side === stratFilter);

  // Candlestick chart data
  const chartCandles = sd.candles.slice(-60).map((c, i) => ({
    t: i, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
    fill: c.c >= c.o ? "#22c55e" : "#ef4444",
    body: [Math.min(c.o, c.c), Math.max(c.o, c.c)],
  }));

  const iS = { padding: "5px 7px", borderRadius: 4, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 11, fontFamily: "var(--m)", outline: "none", width: "100%" };
  const tB = { fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "rgba(34,197,94,0.15)", color: "#22c55e", fontWeight: 600 };
  const tSl = { fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "rgba(239,68,68,0.15)", color: "#ef4444", fontWeight: 600 };

  const Modal = ({ children, onClose }) => (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 12, padding: 28, width: 380, boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}>{children}</div>
    </div>
  );

  // Indicator display
  const IndBadge = ({ label, value, color }) => (
    <div style={{ background: "#0f172a", borderRadius: 4, padding: "3px 8px", display: "inline-flex", gap: 4, alignItems: "center", fontSize: 10, fontFamily: "var(--m)" }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ "--m": "'JetBrains Mono',monospace", "--h": "'Space Grotesk',sans-serif", minHeight: "100vh", background: "#0a0e17", color: "#e2e8f0", fontFamily: "'Söhne',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:4px}@keyframes fsi{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}.sr:hover{background:rgba(255,255,255,0.03)!important}.bt{transition:all .12s;cursor:pointer}.bt:hover{transform:translateY(-1px);filter:brightness(1.15)}.bt:active{transform:translateY(0)}.bg{transition:all .12s;cursor:pointer}.bg:hover{background:rgba(255,255,255,0.06)!important}.sc{transition:border-color .2s}.sc:hover{border-color:rgba(99,102,241,0.4)!important}input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 6px center}`}</style>

      {notif && <div style={{ position: "fixed", top: 16, right: 16, zIndex: 1000, padding: "10px 20px", borderRadius: 8, background: notif.type === "buy" ? "#14532d" : "#1e293b", border: `1px solid ${notif.type === "buy" ? "#22c55e" : "#334155"}`, color: "#f1f5f9", fontSize: 13, fontWeight: 500, animation: "fsi .2s", boxShadow: "0 8px 32px rgba(0,0,0,0.4)", fontFamily: "var(--m)" }}>{notif.msg}</div>}

      {showCap && <Modal onClose={() => setShowCap(false)}>
        <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 18, color: "#f8fafc", marginBottom: 12 }}>Sermaye Ayarla (USDT)</div>
        <input type="number" value={capIn} onChange={e => setCapIn(e.target.value)} style={{ ...iS, fontSize: 20, fontWeight: 600, marginBottom: 12, padding: "14px 16px" }} onKeyDown={e => e.key === "Enter" && applyCap()} />
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {[5000, 10000, 25000, 50000, 100000].map(v => (<button key={v} onClick={() => setCapIn(v.toString())} className="bg" style={{ padding: "4px 10px", borderRadius: 4, fontSize: 11, border: "1px solid #1e293b", background: capIn == v ? "rgba(99,102,241,0.15)" : "#0f172a", color: capIn == v ? "#a5b4fc" : "#6b7280", fontFamily: "var(--m)" }}>${fK(v)}</button>))}
        </div>
        <div style={{ display: "flex", gap: 10 }}><button onClick={() => setShowCap(false)} className="bg" style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid #1e293b", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, fontFamily: "var(--h)" }}>İptal</button><button onClick={applyCap} className="bt" style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#6366f1,#4f46e5)", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--h)" }}>Uygula</button></div>
      </Modal>}

      {showReset && <Modal onClose={() => setShowReset(false)}>
        <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 18, color: "#f8fafc", marginBottom: 12 }}>Sıfırla</div>
        <input type="number" value={rstIn} onChange={e => setRstIn(e.target.value)} style={{ ...iS, fontSize: 18, fontWeight: 600, marginBottom: 16, padding: "12px 16px" }} />
        <div style={{ display: "flex", gap: 10 }}><button onClick={() => setShowReset(false)} className="bg" style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid #1e293b", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, fontFamily: "var(--h)" }}>İptal</button><button onClick={resetAll} className="bt" style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#dc2626,#b91c1c)", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--h)" }}>Sıfırla</button></div>
      </Modal>}

      {/* HEADER */}
      <div style={{ padding: "10px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(10,14,23,0.95)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: autoOn ? "#f59e0b" : "#ef4444", boxShadow: `0 0 8px ${autoOn ? "rgba(245,158,11,0.5)" : "rgba(239,68,68,0.5)"}`, animation: "pulse 2s infinite" }} />
          <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: "#f8fafc" }}>TRADE<span style={{ color: "#f59e0b" }}>SIMBOT</span></span>
          <span style={{ fontSize: 10, color: "#f59e0b", background: "rgba(245,158,11,0.1)", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)", fontWeight: 600 }}>5DK TEKNİK ANALİZ · {ac} AKTİF</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", gap: 14, fontFamily: "var(--m)", fontSize: 11 }}>
            <span><span style={{ color: "#6b7280" }}>PORTFÖY </span><span style={{ color: "#f8fafc", fontWeight: 600 }}>${fK(tv)}</span></span>
            <span><span style={{ color: "#6b7280" }}>K/Z </span><span style={{ color: pnl >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{pnl >= 0 ? "+" : ""}${fK(pnl)} ({pc(pnl / startCash)})</span></span>
            <span><span style={{ color: "#6b7280" }}>USDT </span><span style={{ color: "#94a3b8" }}>${fK(cash)}</span></span>
          </div>
          <button onClick={() => { setCapIn(startCash.toString()); setShowCap(true); }} className="bt" style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid #f59e0b", background: "rgba(245,158,11,0.1)", color: "#f59e0b", fontSize: 10, fontWeight: 600, fontFamily: "var(--h)" }}>💰 SERMAYE</button>
          <button onClick={() => { setRstIn(startCash.toString()); setShowReset(true); }} className="bg" style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid #374151", background: "transparent", color: "#ef4444", fontSize: 10, fontWeight: 600, fontFamily: "var(--h)" }}>SIFIRLA</button>
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#0d1117" }}>
        {[["auto", "Stratejiler (30)"], ["chart", "Grafik & TA"], ["portfolio", "Portföy"], ["orders", `İşlemler (${orders.length})`]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: "9px 20px", fontSize: 12, fontWeight: 500, background: "none", border: "none", cursor: "pointer", color: tab === k ? "#f8fafc" : "#6b7280", borderBottom: tab === k ? "2px solid #f59e0b" : "2px solid transparent", fontFamily: "var(--h)" }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 85px)" }}>
        {/* LEFT - BTC & ETH */}
        <div style={{ width: 220, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto", background: "#0d1117", flexShrink: 0 }}>
          {Object.entries(COINS).map(([sym, c]) => {
            const d2 = data[sym]; const p = d2.cur; const open = d2.candles[0]?.o || p;
            const d = p - open; const dp = d / open; const held = holdings[sym]?.qty || 0;
            return (
              <div key={sym} className="sr" onClick={() => { setSelected(sym); setTab("chart"); }}
                style={{ padding: "12px 14px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.03)", background: selected === sym ? "rgba(245,158,11,0.08)" : "transparent", borderLeft: selected === sym ? "2px solid #f59e0b" : "2px solid transparent" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontFamily: "var(--m)", fontWeight: 700, fontSize: 15, color: sym === "BTC" ? "#f59e0b" : "#627eea" }}>{sym}</div>
                    <div style={{ fontSize: 10, color: "#6b7280" }}>{c.name}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: "var(--m)", fontSize: 14, fontWeight: 600, color: "#f8fafc" }}>${fmt(p)}</div>
                    <div style={{ fontFamily: "var(--m)", fontSize: 10, color: d >= 0 ? "#22c55e" : "#ef4444" }}>{pc(dp)}</div>
                  </div>
                </div>
                {held > 0 && <div style={{ fontSize: 10, color: "#a5b4fc", fontFamily: "var(--m)", marginTop: 4 }}>{held.toFixed(4)} {sym} · ${fmt(held * p)}</div>}
                {/* Indicators */}
                <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: d2.rsi < 30 ? "rgba(34,197,94,0.15)" : d2.rsi > 70 ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.04)", color: d2.rsi < 30 ? "#22c55e" : d2.rsi > 70 ? "#ef4444" : "#6b7280", fontFamily: "var(--m)" }}>RSI {d2.rsi?.toFixed(0) || "--"}</span>
                  <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: d2.macd?.hist > 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: d2.macd?.hist > 0 ? "#22c55e" : "#ef4444", fontFamily: "var(--m)" }}>MACD {d2.macd?.hist > 0 ? "↑" : "↓"}</span>
                </div>
              </div>
            );
          })}
          {/* Live indicators panel */}
          <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 8, letterSpacing: "0.05em" }}>CANLI İNDİKATÖRLER · {selected}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <IndBadge label="RSI" value={sd.rsi?.toFixed(1) || "--"} color={sd.rsi < 30 ? "#22c55e" : sd.rsi > 70 ? "#ef4444" : "#f8fafc"} />
              <IndBadge label="MACD" value={sd.macd?.hist?.toFixed(2) || "--"} color={sd.macd?.hist > 0 ? "#22c55e" : "#ef4444"} />
              <IndBadge label="BB Üst" value={`$${fmt(sd.bb?.upper || 0)}`} color="#a5b4fc" />
              <IndBadge label="BB Alt" value={`$${fmt(sd.bb?.lower || 0)}`} color="#a5b4fc" />
              <IndBadge label="EMA9" value={`$${fmt(sd.ema9 || 0)}`} color="#22d3ee" />
              <IndBadge label="EMA21" value={`$${fmt(sd.ema21 || 0)}`} color="#f59e0b" />
              <IndBadge label="EMA50" value={`$${fmt(sd.ema50 || 0)}`} color="#a78bfa" />
              <IndBadge label="Stoch K" value={sd.stoch?.k?.toFixed(0) || "--"} color={sd.stoch?.k < 20 ? "#22c55e" : sd.stoch?.k > 80 ? "#ef4444" : "#f8fafc"} />
              <IndBadge label="ADX" value={sd.adx?.toFixed(0) || "--"} color={sd.adx > 25 ? "#f59e0b" : "#6b7280"} />
              <IndBadge label="VWAP" value={`$${fmt(sd.vwap || 0)}`} color="#94a3b8" />
              <IndBadge label="Mum" value={`${sd.candles.length}`} color="#6b7280" />
            </div>
          </div>
        </div>

        {/* MAIN */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {/* STRATEGIES */}
          {tab === "auto" && (
            <div style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div>
                  <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 18, color: "#f8fafc" }}>30 Teknik Analiz Stratejisi</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>5 dakikalık mum grafiği · RSI, MACD, Bollinger, EMA, Stochastic, ADX, VWAP, Formasyonlar</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {["all", "buy", "sell"].map(f => (
                    <button key={f} onClick={() => setStratFilter(f)} style={{ padding: "4px 12px", borderRadius: 5, border: stratFilter === f ? "1px solid #f59e0b" : "1px solid #1e293b", background: stratFilter === f ? "rgba(245,158,11,0.15)" : "transparent", color: stratFilter === f ? "#f59e0b" : "#6b7280", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--h)", textTransform: "uppercase" }}>{f === "all" ? "Hepsi" : f === "buy" ? "AL" : "SAT"}</button>
                  ))}
                  <button onClick={() => setAutoOn(!autoOn)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 14px", borderRadius: 5, cursor: "pointer", border: autoOn ? "1px solid #22c55e" : "1px solid #374151", background: autoOn ? "rgba(34,197,94,0.1)" : "transparent", color: autoOn ? "#22c55e" : "#6b7280", fontSize: 10, fontWeight: 600, fontFamily: "var(--h)" }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: autoOn ? "#22c55e" : "#6b7280" }} />{autoOn ? "AÇIK" : "KAPALI"}
                  </button>
                  <button onClick={activateAll} className="bt" style={{ padding: "4px 16px", borderRadius: 5, border: "none", background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#000", fontSize: 10, fontWeight: 800, fontFamily: "var(--h)" }}>🔥 HEPSİNİ AKTİF ET</button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 6, marginBottom: 16 }}>
                {filteredStrats.map(st => {
                  const cc = cardCfg[st.id];
                  const isA = actives.some(a => a.type === st.id && a.active);
                  return (
                    <div key={st.id} className="sc" style={{ background: "#0f172a", borderRadius: 7, padding: "10px 12px", border: `1px solid ${isA ? (st.side === "buy" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)") : "rgba(255,255,255,0.04)"}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                        <span style={{ fontSize: 14 }}>{st.icon}</span>
                        <span style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#f8fafc", flex: 1 }}>{st.label}</span>
                        <span style={st.side === "buy" ? tB : tSl}>{st.side === "buy" ? "AL" : "SAT"}</span>
                      </div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 6, lineHeight: 1.2 }}>{st.desc}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 52px", gap: 3, alignItems: "end" }}>
                        <div>
                          <div style={{ fontSize: 8, color: "#4b5563" }}>Coin</div>
                          <select value={cc.symbol} onChange={e => upCard(st.id, "symbol", e.target.value)} style={{ ...iS, paddingRight: 16, fontSize: 10 }}>
                            {SYMS.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <div style={{ fontSize: 8, color: "#4b5563" }}>Değer</div>
                          <input type="number" value={cc.value} onChange={e => upCard(st.id, "value", e.target.value)} style={{ ...iS, fontSize: 10 }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 8, color: "#4b5563" }}>Miktar</div>
                          <input type="number" value={cc.qty} step={cc.symbol === "BTC" ? 0.001 : 0.01} onChange={e => upCard(st.id, "qty", e.target.value)} style={{ ...iS, fontSize: 10 }} />
                        </div>
                        <button onClick={() => activate(st.id)} className="bt" style={{ padding: "5px 0", borderRadius: 4, border: "none", fontSize: 8, fontWeight: 700, fontFamily: "var(--h)", background: isA ? "rgba(245,158,11,0.2)" : st.side === "buy" ? "linear-gradient(135deg,#16a34a,#15803d)" : "linear-gradient(135deg,#dc2626,#b91c1c)", color: isA ? "#f59e0b" : "#fff" }}>
                          {isA ? "✓" : "AKTİF"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {actives.length > 0 && <>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 5, fontFamily: "var(--h)", fontWeight: 600 }}>ÇALIŞAN ({ac}) <button onClick={() => setActives([])} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 9, marginLeft: 8 }}>HEPSİNİ SİL</button></div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 16 }}>
                  {actives.map(st => { const sT = STRATS.find(s => s.id === st.type); return (
                    <div key={st.id} style={{ background: "#0f172a", borderRadius: 4, padding: "3px 8px", border: "1px solid rgba(255,255,255,0.04)", opacity: st.active ? 1 : 0.3, display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontFamily: "var(--m)" }}>
                      <span style={sT?.side === "buy" ? tB : tSl}>{sT?.side === "buy" ? "A" : "S"}</span>
                      <span style={{ color: st.symbol === "BTC" ? "#f59e0b" : "#627eea", fontWeight: 600 }}>{st.symbol}</span>
                      <span style={{ color: "#4b5563" }}>{sT?.label?.split(" ")[0]}</span>
                      <button onClick={() => setActives(v => v.filter(s => s.id !== st.id))} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 9, padding: 0 }}>✕</button>
                    </div>
                  ); })}
                </div>
              </>}

              <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 5, fontFamily: "var(--h)", fontWeight: 600 }}>İŞLEM GÜNLÜĞÜ</div>
              {autoLog.length === 0 ? <div style={{ textAlign: "center", padding: 12, color: "#374151", fontSize: 11 }}>Mum verileri yükleniyor... stratejiler mum kapanışlarında tetiklenir</div> : (
                <div style={{ background: "#0f172a", borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)", maxHeight: 200, overflowY: "auto" }}>
                  {autoLog.map((l, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderBottom: "1px solid rgba(255,255,255,0.02)", fontFamily: "var(--m)", fontSize: 9 }}>
                      <span style={{ color: "#4b5563", minWidth: 55 }}>{l.time.toLocaleTimeString()}</span>
                      <span style={l.side === "buy" ? tB : tSl}>{l.side === "buy" ? "AL" : "SAT"}</span>
                      <span style={{ color: l.symbol === "BTC" ? "#f59e0b" : "#627eea", fontWeight: 600, minWidth: 28 }}>{l.symbol}</span>
                      <span style={{ color: "#94a3b8" }}>{l.qty}×${fmt(l.price)} = ${fK(l.price * l.qty)}</span>
                      {l.why && <span style={{ color: "#a78bfa", marginLeft: "auto", fontWeight: 500 }}>({l.why})</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* CHART */}
          {tab === "chart" && (
            <div style={{ padding: "16px 24px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
                <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 24, color: selected === "BTC" ? "#f59e0b" : "#627eea" }}>{selected}/USDT</span>
                <span style={{ fontSize: 10, background: "rgba(245,158,11,0.1)", color: "#f59e0b", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)" }}>5DK</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
                <span style={{ fontFamily: "var(--m)", fontSize: 32, fontWeight: 600, color: "#f8fafc" }}>${fmt(sd.cur)}</span>
                <span style={{ fontFamily: "var(--m)", fontSize: 16, color: ch >= 0 ? "#22c55e" : "#ef4444" }}>{ch >= 0 ? "▲" : "▼"} {fmt(Math.abs(ch))} ({pc(chP)})</span>
              </div>

              {/* Candle chart */}
              {chartCandles.length > 2 ? (
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={chartCandles} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <XAxis dataKey="t" hide />
                    <YAxis domain={["auto", "auto"]} hide />
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} labelFormatter={() => ""} formatter={(v, name) => [name === "c" ? `$${fmt(v)}` : v, name === "c" ? "Kapanış" : name === "h" ? "Yüksek" : name === "l" ? "Düşük" : name === "o" ? "Açılış" : name]} />
                    {sd.bb?.mid > 0 && <ReferenceLine y={sd.bb.upper} stroke="#6366f1" strokeDasharray="3 3" strokeWidth={0.5} />}
                    {sd.bb?.mid > 0 && <ReferenceLine y={sd.bb.lower} stroke="#6366f1" strokeDasharray="3 3" strokeWidth={0.5} />}
                    {sd.ema9 > 0 && <ReferenceLine y={sd.ema9} stroke="#22d3ee" strokeDasharray="2 2" strokeWidth={0.5} />}
                    {sd.ema21 > 0 && <ReferenceLine y={sd.ema21} stroke="#f59e0b" strokeDasharray="2 2" strokeWidth={0.5} />}
                    <Line type="monotone" dataKey="c" stroke={ch >= 0 ? "#22c55e" : "#ef4444"} strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="h" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="l" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 340, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>Mum verileri yükleniyor...</div>
              )}

              {/* Volume */}
              {chartCandles.length > 2 && (
                <ResponsiveContainer width="100%" height={60}>
                  <ComposedChart data={chartCandles} margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                    <XAxis dataKey="t" hide /><YAxis hide />
                    <Bar dataKey="v" fill="rgba(99,102,241,0.3)" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}

              {/* TA summary */}
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
          )}

          {/* PORTFOLIO */}
          {tab === "portfolio" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 18, marginBottom: 14, color: "#f8fafc" }}>Portföy</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 16 }}>
                {[{ l: "Toplam", v: `$${fK(tv)}`, c: "#f8fafc" }, { l: "USDT", v: `$${fK(cash)}`, c: "#94a3b8" }, { l: "Pozisyon", v: `$${fK(hVal)}`, c: "#f59e0b" }, { l: "K/Z", v: `${pnl >= 0 ? "+" : ""}$${fK(pnl)}`, c: pnl >= 0 ? "#22c55e" : "#ef4444" }].map((c, i) => (
                  <div key={i} style={{ background: "#0f172a", borderRadius: 8, padding: "10px 12px", border: "1px solid rgba(255,255,255,0.04)" }}>
                    <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2, fontFamily: "var(--h)", fontWeight: 600 }}>{c.l}</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: c.c, fontFamily: "var(--m)" }}>{c.v}</div>
                  </div>
                ))}
              </div>
              {Object.keys(holdings).length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "#6b7280" }}>Henüz pozisyon yok. 🔥 HEPSİNİ AKTİF ET!</div> : (
                <div style={{ display: "grid", gap: 10 }}>
                  {Object.entries(holdings).map(([sym, h]) => {
                    const p = data[sym].cur; const v = h.qty * p; const pl = (p - h.avgCost) * h.qty; const plP = ((p - h.avgCost) / h.avgCost) * 100;
                    return (<div key={sym} style={{ background: "#0f172a", borderRadius: 8, padding: "14px 16px", border: "1px solid rgba(255,255,255,0.04)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <span style={{ fontFamily: "var(--m)", fontWeight: 700, fontSize: 18, color: sym === "BTC" ? "#f59e0b" : "#627eea" }}>{sym}</span>
                          <span style={{ fontFamily: "var(--m)", fontSize: 12, color: "#6b7280", marginLeft: 8 }}>{h.qty.toFixed(6)} {sym}</span>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: "var(--m)", fontSize: 16, fontWeight: 600, color: "#f8fafc" }}>${fmt(v)}</div>
                          <div style={{ fontFamily: "var(--m)", fontSize: 12, color: pl >= 0 ? "#22c55e" : "#ef4444" }}>{pl >= 0 ? "+" : ""}${fmt(pl)} ({plP >= 0 ? "+" : ""}{plP.toFixed(2)}%)</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 16, marginTop: 6, fontFamily: "var(--m)", fontSize: 10, color: "#6b7280" }}>
                        <span>Ort. Maliyet: <span style={{ color: "#94a3b8" }}>${fmt(h.avgCost)}</span></span>
                        <span>Güncel: <span style={{ color: "#f8fafc" }}>${fmt(p)}</span></span>
                      </div>
                    </div>);
                  })}
                </div>
              )}
            </div>
          )}

          {/* ORDERS */}
          {tab === "orders" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 18, marginBottom: 14, color: "#f8fafc" }}>İşlem Geçmişi ({orders.length})</div>
              {orders.length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "#6b7280" }}>Henüz işlem yok.</div> : (
                <div style={{ background: "#0f172a", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "80px 45px 40px 65px 85px 75px auto", padding: "7px 12px", fontSize: 9, color: "#6b7280", borderBottom: "1px solid rgba(255,255,255,0.04)", fontFamily: "var(--h)", fontWeight: 600 }}>
                    <span>ZAMAN</span><span>YÖN</span><span>COİN</span><span>MİKTAR</span><span>FİYAT</span><span>TOPLAM</span><span>STRATEJİ</span>
                  </div>
                  {orders.slice(0, 150).map(o => (
                    <div key={o.id} style={{ display: "grid", gridTemplateColumns: "80px 45px 40px 65px 85px 75px auto", padding: "4px 12px", fontSize: 10, borderBottom: "1px solid rgba(255,255,255,0.02)", fontFamily: "var(--m)" }}>
                      <span style={{ color: "#4b5563", fontSize: 9 }}>{o.time.toLocaleTimeString()}</span>
                      <span style={{ color: o.side === "buy" ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{o.side === "buy" ? "AL" : "SAT"}</span>
                      <span style={{ color: o.sym === "BTC" ? "#f59e0b" : "#627eea", fontWeight: 600 }}>{o.sym}</span>
                      <span style={{ color: "#94a3b8" }}>{o.qty}</span>
                      <span style={{ color: "#94a3b8" }}>${fmt(o.price)}</span>
                      <span style={{ color: "#f8fafc" }}>${fK(o.price * o.qty)}</span>
                      <span style={{ color: "#a5b4fc", fontSize: 9 }}>{o.strat}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
