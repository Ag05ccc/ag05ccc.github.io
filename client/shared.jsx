const { useState, useEffect, useRef, useCallback } = React;
const { ResponsiveContainer, ComposedChart, AreaChart, Area, Bar, Line, Scatter, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid, LineChart, Legend, Brush, PieChart, Pie, Cell } = Recharts;
const BacktestQualityPanel = (props) => {
  const Component = window.BacktestQualityPanel;
  return Component ? <Component {...props} /> : null;
};
const BacktestAuditPanel = (props) => {
  const Component = window.BacktestAuditPanel;
  return Component ? <Component {...props} /> : null;
};
const BacktestDiagnosticsPanel = (props) => {
  const Component = window.BacktestDiagnosticsPanel;
  return Component ? <Component {...props} /> : null;
};
const DataQualityPanel = (props) => {
  const Component = window.DataQualityPanel;
  return Component ? <Component {...props} /> : null;
};

// ZoomChart - wraps chart container, slices data on mouse wheel zoom
// Children receive sliced data via render prop pattern, but simpler: we slice the data prop of the chart
function ZoomChart({ children, dataKey, dataLength }) {
  const ref = React.useRef(null);
  const [range, setRange] = React.useState(null);
  const rangeRef = React.useRef(null);
  React.useEffect(() => { rangeRef.current = range; }, [range]);
  React.useEffect(() => { setRange(null); }, [dataLength]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || dataLength < 10) return;
    const handler = (e) => {
      e.preventDefault();
      // Mouse X position relative to chart container (0.0 = left, 1.0 = right)
      const rect = el.getBoundingClientRect();
      const mouseX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setRange(prev => {
        const s = prev ? prev[0] : 0;
        const en = prev ? prev[1] : dataLength;
        const span = en - s;
        // Zoom anchor = data index under mouse cursor
        const anchor = s + span * mouseX;
        const factor = e.deltaY > 0 ? 1.25 : 0.75;
        let ns = Math.round(span * factor);
        ns = Math.max(8, Math.min(dataLength, ns));
        // Keep anchor at same mouse position after zoom
        let nStart = Math.round(anchor - ns * mouseX);
        let nEnd = nStart + ns;
        if (nStart < 0) { nStart = 0; nEnd = Math.min(ns, dataLength); }
        if (nEnd > dataLength) { nEnd = dataLength; nStart = Math.max(0, dataLength - ns); }
        if (nEnd - nStart >= dataLength) return null;
        return [nStart, nEnd];
      });
    };
    // Mouse drag to pan left/right
    let dragging = false, dragStartX = 0, dragStartRange = null;
    const onDown = (e) => {
      if (e.button !== 0) return; // left click only
      const cur = rangeRef.current;
      if (!cur) return; // not zoomed, nothing to pan
      dragging = true;
      dragStartX = e.clientX;
      dragStartRange = [cur[0], cur[1]];
      el.style.cursor = 'grabbing';
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const sr = dragStartRange;
      if (!sr) return;
      const rect = el.getBoundingClientRect();
      const span = sr[1] - sr[0];
      const dx = e.clientX - dragStartX;
      // Convert pixel delta to data index delta
      const indexDelta = Math.round((-dx / rect.width) * span);
      let nStart = sr[0] + indexDelta;
      let nEnd = sr[1] + indexDelta;
      if (nStart < 0) { nStart = 0; nEnd = span; }
      if (nEnd > dataLength) { nEnd = dataLength; nStart = dataLength - span; }
      setRange([nStart, nEnd]);
    };
    const onUp = () => {
      dragging = false;
      el.style.cursor = 'crosshair';
    };
    el.addEventListener('wheel', handler, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('wheel', handler);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dataLength]);

  // Clone chart children and replace their data prop with sliced version
  function sliceChartData(child) {
    if (!child || !child.props) return child;
    // If it's ResponsiveContainer, go deeper
    if (child.type === ResponsiveContainer) {
      return React.cloneElement(child, {},
        ...React.Children.map(child.props.children, sliceChartData)
      );
    }
    // If it has a data prop (AreaChart, ComposedChart, LineChart), slice it
    if (child.props.data && range) {
      const sliced = child.props.data.slice(range[0], range[1]);
      return React.cloneElement(child, { data: sliced });
    }
    return child;
  }

  const pct = range ? Math.round(((range[1] - range[0]) / dataLength) * 100) : 100;
  return (
    <div ref={ref} style={{ cursor: "crosshair", position: "relative" }}>
      {range && (
        <div style={{ position: "absolute", top: 4, right: 8, zIndex: 10, display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#818cf8", fontFamily: "var(--m)", background: "rgba(99,102,241,0.15)", padding: "2px 6px", borderRadius: 3 }}>{pct}%</span>
          <span onClick={() => setRange(null)} style={{ fontSize: 9, color: "#ef4444", cursor: "pointer", fontFamily: "var(--m)", background: "rgba(239,68,68,0.1)", padding: "2px 6px", borderRadius: 3 }}>Reset</span>
        </div>
      )}
      {React.Children.map(children, sliceChartData)}
    </div>
  );
}

const COINS_META = {
  BTC: { name: "Bitcoin", type: "crypto" }, ETH: { name: "Ethereum", type: "crypto" },
  SOL: { name: "Solana", type: "crypto" }, BNB: { name: "BNB", type: "crypto" },
  XRP: { name: "Ripple", type: "crypto" }, ADA: { name: "Cardano", type: "crypto" },
  AVAX: { name: "Avalanche", type: "crypto" }, DOGE: { name: "Dogecoin", type: "crypto" },
  DOT: { name: "Polkadot", type: "crypto" }, LINK: { name: "Chainlink", type: "crypto" },
  MATIC: { name: "Polygon (POL)", type: "crypto", displaySymbol: "POL" }, UNI: { name: "Uniswap", type: "crypto" },
  ATOM: { name: "Cosmos", type: "crypto" }, LTC: { name: "Litecoin", type: "crypto" },
  NEAR: { name: "NEAR", type: "crypto" }, APT: { name: "Aptos", type: "crypto" },
  ARB: { name: "Arbitrum", type: "crypto" }, OP: { name: "Optimism", type: "crypto" },
  SUI: { name: "Sui", type: "crypto" }, FIL: { name: "Filecoin", type: "crypto" },
  GOLD: { name: "Gold", type: "commodity" }, SILVER: { name: "Silver", type: "commodity" },
  PLAT: { name: "Platinum", type: "commodity" }, COPPER: { name: "Copper", type: "commodity" },
  OIL: { name: "Crude Oil", type: "commodity" }, NATGAS: { name: "Nat Gas", type: "commodity" },
  AAPL: { name: "Apple", type: "stock" }, MSFT: { name: "Microsoft", type: "stock" },
  GOOGL: { name: "Alphabet", type: "stock" }, AMZN: { name: "Amazon", type: "stock" },
  NVDA: { name: "NVIDIA", type: "stock" }, META: { name: "Meta", type: "stock" },
  TSLA: { name: "Tesla", type: "stock" }, JPM: { name: "JPMorgan", type: "stock" },
  V: { name: "Visa", type: "stock" }, WMT: { name: "Walmart", type: "stock" },
  NFLX: { name: "Netflix", type: "stock" }, AMD: { name: "AMD", type: "stock" },
  CRM: { name: "Salesforce", type: "stock" }, ORCL: { name: "Oracle", type: "stock" },
  INTC: { name: "Intel", type: "stock" }, DIS: { name: "Disney", type: "stock" },
  BA: { name: "Boeing", type: "stock" }, PYPL: { name: "PayPal", type: "stock" },
  UBER: { name: "Uber", type: "stock" }, COIN: { name: "Coinbase", type: "stock" },
};

function symColor(sym) {
  const colors = { BTC: "#f59e0b", ETH: "#627eea", SOL: "#9945ff", BNB: "#f3ba2f", XRP: "#00aae4", ADA: "#0033ad", AVAX: "#e84142", DOGE: "#c2a633", DOT: "#e6007a", LINK: "#2a5ada", MATIC: "#8247e5", UNI: "#ff007a", ATOM: "#2e3148", LTC: "#bfbbbb", NEAR: "#00c08b", APT: "#00bfa5", ARB: "#28a0f0", OP: "#ff0420", SUI: "#4da2ff", FIL: "#0090ff", GOLD: "#ffd700", SILVER: "#c0c0c0", PLAT: "#e5e4e2", COPPER: "#b87333", OIL: "#4a3728", NATGAS: "#ff6b35", AAPL: "#a2aaad", MSFT: "#00a4ef", GOOGL: "#4285f4", AMZN: "#ff9900", NVDA: "#76b900", META: "#0081fb", TSLA: "#cc0000", JPM: "#006eb6", V: "#1a1f71", WMT: "#0071ce", NFLX: "#e50914", AMD: "#ed1c24", CRM: "#00a1e0", ORCL: "#f80000", INTC: "#0071c5", DIS: "#113ccf", BA: "#0033a0", PYPL: "#003087", UBER: "#000000", COIN: "#0052ff" };
  return colors[sym] || "#94a3b8";
}

function fmt(n) { return n < 1 ? n.toFixed(4) : n < 100 ? n.toFixed(2) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fK(n) { if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K"; return fmt(n); }
function pc(n) { return (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%"; }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString(); }
function getAdminToken() { try { return new URLSearchParams(window.location.search).get('token') || ''; } catch (e) { return ''; } }
function adminFetch(url, opts) {
  opts = opts || {};
  const token = getAdminToken();
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers['X-Admin-Token'] = token;
  return fetch(url, Object.assign({}, opts, { headers }));
}

const IndBadge = ({ label, value, color }) => (
  <div style={{ background: "#0f172a", borderRadius: 4, padding: "3px 8px", display: "inline-flex", gap: 4, alignItems: "center", fontSize: 10, fontFamily: "var(--m)" }}>
    <span style={{ color: "#6b7280" }}>{label}</span>
    <span style={{ color, fontWeight: 600 }}>{value}</span>
  </div>
);

// Timeframe: group candles
function groupCandles(candles, factor) {
  if (factor <= 1) return candles;
  const grouped = [];
  for (let i = 0; i < candles.length; i += factor) {
    const slice = candles.slice(i, i + factor);
    if (slice.length === 0) continue;
    grouped.push({
      o: slice[0].o, h: Math.max(...slice.map(c => c.h)), l: Math.min(...slice.map(c => c.l)),
      c: slice[slice.length - 1].c, v: slice.reduce((a, c) => a + (c.v || 0), 0), t: slice[slice.length - 1].t,
    });
  }
  return grouped;
}

const TIMEFRAMES = [
  { label: "1m", factor: 1 },
  { label: "5m", factor: 5 },
  { label: "15m", factor: 15 },
  { label: "1h", factor: 60 },
  { label: "4h", factor: 240 },
  { label: "1D", factor: 1440 },
];

Object.assign(window, {
  useState, useEffect, useRef, useCallback,
  ResponsiveContainer, ComposedChart, AreaChart, Area, Bar, Line, Scatter,
  XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid, LineChart, Legend,
  Brush, PieChart, Pie, Cell,
  BacktestQualityPanel, BacktestAuditPanel, BacktestDiagnosticsPanel, DataQualityPanel,
  ZoomChart, COINS_META, symColor, fmt, fK, pc, fmtTime,
  getAdminToken, adminFetch, IndBadge, groupCandles, TIMEFRAMES,
});
