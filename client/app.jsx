function App() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState("BTC");
  const [tab, setTab] = useState("compare");
  const [tf, setTf] = useState("5m");
  const [chartType, setChartType] = useState("candle");
  const [showSidebar, setShowSidebar] = useState(window.innerWidth > 768);
  const isMobile = window.innerWidth <= 768;
  const [editProfile, setEditProfile] = useState(null);
  const [compareStart, setCompareStart] = useState("2026-01-01");
  const [chartZoom, setChartZoom] = useState(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simResults, setSimResults] = useState(null);
  const [simError, setSimError] = useState(null);
  const [simReplayData, setSimReplayData] = useState([]);
  const [simReplayIndex, setSimReplayIndex] = useState(0);
  const [simReplayPlaying, setSimReplayPlaying] = useState(false);
  const [histData, setHistData] = useState(null);
  const [histLoading, setHistLoading] = useState(false);
  const [dataQuality, setDataQuality] = useState(null);
  const [dataQualityLoading, setDataQualityLoading] = useState(false);
  const [dataQualityError, setDataQualityError] = useState(null);
  const [assetFilter, setAssetFilter] = useState("ALL");
  const wsRef = useRef(null);
  const simReplayTimerRef = useRef(null);

  // WebSocket connection
  useEffect(() => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'init' || msg.type === 'update') {
            setState(msg.data);
          } else if (msg.type === 'prices') {
            // Lightweight 2s delta: merge only the fields that change every tick
            // (current prices + portfolio totals) into the last full snapshot,
            // keeping candles/indicators/orders/history. Avoids re-sending ~800KB/2s.
            setState(prev => {
              if (!prev) return prev; // wait for the first full snapshot
              const prices = { ...prev.prices };
              if (msg.prices) {
                for (const sym in msg.prices) {
                  if (prices[sym]) prices[sym] = { ...prices[sym], cur: msg.prices[sym] };
                }
              }
              let portfolios = prev.portfolios;
              if (msg.portfolios) {
                const byId = {};
                msg.portfolios.forEach(p => { byId[p.id] = p; });
                portfolios = prev.portfolios.map(pf => {
                  const u = byId[pf.id];
                  return u ? { ...pf, cash: u.cash, hVal: u.hVal, totalValue: u.totalValue, pnl: u.pnl } : pf;
                });
              }
              return { ...prev, prices, portfolios, tick: msg.tick != null ? msg.tick : prev.tick };
            });
          } else if (msg.type === 'backtestProgress') {
            window._btProgress = msg.pct || 0;
            if (window._setBtProgress) window._setBtProgress(msg.pct || 0);
          }
        } catch(err) {}
      };
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, []);

  const sendWs = useCallback(function(msg) {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Attach the admin token (if the operator opened the page with ?token=...).
      // Mutating commands (reset/resume/updateConfig) are rejected server-side
      // without it when an ADMIN_TOKEN is configured.
      var adminToken = getAdminToken();
      wsRef.current.send(JSON.stringify(adminToken ? Object.assign({}, msg, { token: adminToken }) : msg));
    }
  }, []);
  const resetPf = useCallback(function(id) { sendWs({ type: 'reset', id: id }); }, [sendWs]);

  const stopSimulationReplay = useCallback(function() {
    if (simReplayTimerRef.current) {
      clearInterval(simReplayTimerRef.current);
      simReplayTimerRef.current = null;
    }
    setSimReplayPlaying(false);
  }, []);

  const loadDataQuality = useCallback(function() {
    setDataQualityLoading(true);
    setDataQualityError(null);
    fetch('/api/data-quality')
      .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
      .then(function(resp) {
        setDataQualityLoading(false);
        if (!resp.ok || resp.data.error) {
          setDataQualityError(resp.data.error || 'Data quality check failed');
          return;
        }
        setDataQuality(resp.data);
      })
      .catch(function(e) {
        setDataQualityLoading(false);
        setDataQualityError(e.message || 'Data quality check failed');
      });
  }, []);

  useEffect(function() {
    loadDataQuality();
    var id = setInterval(loadDataQuality, 60000);
    return function() { clearInterval(id); };
  }, [loadDataQuality]);

  useEffect(function() {
    return function() {
      if (simReplayTimerRef.current) clearInterval(simReplayTimerRef.current);
    };
  }, []);

  function loadHistorical(sym, startDate) {
    const s = sym || selected;
    const sd2 = startDate || "2020-01-01";
    setHistLoading(true);
    setHistData(null);
    adminFetch('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: "moderate", symbols: [s], startDate: sd2 }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      setHistLoading(false);
      if (data.error) { setHistData(null); return; }
      if (data.priceHistory && data.priceHistory[s]) {
        setHistData({ symbol: s, startDate: sd2, candles: data.priceHistory[s] });
      }
    })
    .catch(function() { setHistLoading(false); });
  }

  // Auto-load historical data + reset zoom when selected symbol changes
  useEffect(function() {
    if (selected) loadHistorical(selected, "2020-01-01");
    setChartZoom(null);
  }, [selected]);

  // Chart zoom refs — must be before early return to maintain hooks order
  const chartRef = useRef(null);
  const chartZoomRef = useRef({ allLen: 0, zoomStart: 0, zoomEnd: 0 });

  // Non-passive wheel listener for chart zoom (must be before early return)
  useEffect(function() {
    var el = chartRef.current;
    if (!el) return;
    function handler(e) {
      e.preventDefault();
      e.stopPropagation();
      var z = chartZoomRef.current;
      var len = z.allLen;
      if (len < 10) return;
      var rect = el.getBoundingClientRect();
      var mouseX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var s = z.zoomStart, en = z.zoomEnd;
      var span = en - s;
      var anchor = s + span * mouseX;
      var factor = e.deltaY > 0 ? 1.25 : 0.75;
      var ns = Math.round(span * factor);
      ns = Math.max(10, Math.min(len, ns));
      var nStart = Math.round(anchor - ns * mouseX);
      var nEnd = nStart + ns;
      if (nStart < 0) { nStart = 0; nEnd = Math.min(ns, len); }
      if (nEnd > len) { nEnd = len; nStart = Math.max(0, len - ns); }
      if (nEnd - nStart >= len) { setChartZoom(null); return; }
      setChartZoom([nStart, nEnd]);
    }
    el.addEventListener('wheel', handler, { passive: false });
    return function() { el.removeEventListener('wheel', handler); };
  }, []);

  if (!state || !state.prices) {
    return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "#f59e0b", fontFamily: "'Space Grotesk',sans-serif", fontSize: 18 }}>
      {connected ? "Loading data..." : "Connecting to server..."}
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#22c55e" : "#ef4444", marginLeft: 10, animation: "pulse 2s infinite" }} />
    </div>;
  }

  const prices = state.prices;
  const pfStats = state.portfolios || [];
  const allSymbols = Object.keys(prices).filter(s => prices[s] && prices[s].cur > 0);
  const sd = prices[selected] || { cur: 0, candles: [], rsi: 50, macd: { hist: 0 }, bb: {}, stoch: { k: 50 }, adx: 20 };
  const ch = sd.cur - (sd.candles[0]?.o || sd.cur);
  const chP = sd.candles.length > 0 ? ch / (sd.candles[0]?.o || sd.cur) : 0;

  // Build merged candles: historical daily + live
  var mergedSourceCandles = [];
  if (histData && histData.symbol === selected && histData.candles) {
    mergedSourceCandles = histData.candles.map(function(c) {
      return { t: c.date || c.d || '', o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, isDaily: true };
    });
  }
  // Append live candles (more recent, 1-min granularity)
  if (sd.candles && sd.candles.length > 0) {
    sd.candles.forEach(function(c) {
      mergedSourceCandles.push({ t: c.t || 0, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, isDaily: false });
    });
  }

  // Group candles by timeframe (only groups live/minute candles; daily candles pass through for larger TFs)
  const tfObj = TIMEFRAMES.find(t => t.label === tf) || TIMEFRAMES[1];
  // For daily historical candles, grouping by minute-factor doesn't apply, so split and handle
  var histPart = mergedSourceCandles.filter(function(c) { return c.isDaily; });
  var livePart = mergedSourceCandles.filter(function(c) { return !c.isDaily; });
  var groupedLive = groupCandles(livePart, tfObj.factor);
  // For 1D timeframe, group live candles into a single day candle if any exist
  var combinedGrouped = histPart.concat(groupedLive);
  // Keep all candles, not just last 200 — zoom controls the visible range
  const allChartCandles = combinedGrouped.map((c, i) => ({
    t: c.isDaily ? (c.t || `${i}`) : (c.t ? new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `${i}`),
    rawT: c.t || 0,
    o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
  }));
  // Reset zoom when symbol changes (chartZoom state declared at top with other hooks)
  const defaultShow = Math.min(120, allChartCandles.length);
  const zoomStart = chartZoom ? chartZoom[0] : Math.max(0, allChartCandles.length - defaultShow);
  const zoomEnd = chartZoom ? chartZoom[1] : allChartCandles.length;
  const chartCandles = allChartCandles.slice(zoomStart, zoomEnd);
  const chartZoomPct = allChartCandles.length > 0 ? Math.round((chartCandles.length / allChartCandles.length) * 100) : 100;

  chartZoomRef.current = { allLen: allChartCandles.length, zoomStart: zoomStart, zoomEnd: zoomEnd };

  function onChartWheel(e) {
    // Fallback for React (won't preventDefault in passive mode, but keeps logic)
    var len = allChartCandles.length;
    if (len < 10) return;
    var rect = e.currentTarget.getBoundingClientRect();
    var mouseX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var s = zoomStart, en = zoomEnd;
    var span = en - s;
    var anchor = s + span * mouseX;
    var factor = e.deltaY > 0 ? 1.25 : 0.75;
    var ns = Math.round(span * factor);
    ns = Math.max(10, Math.min(len, ns));
    var nStart = Math.round(anchor - ns * mouseX);
    var nEnd = nStart + ns;
    if (nStart < 0) { nStart = 0; nEnd = Math.min(ns, len); }
    if (nEnd > len) { nEnd = len; nStart = Math.max(0, len - ns); }
    if (nEnd - nStart >= len) { setChartZoom(null); return; }
    setChartZoom([nStart, nEnd]);
  }

  function historyTimestamp(h) {
    if (!h) return null;
    if (Number.isFinite(h.t)) return h.t;
    if (h.time) {
      const ts = new Date(h.time).getTime();
      return Number.isFinite(ts) ? ts : null;
    }
    if (h.day) {
      const ts = new Date(h.day + "T00:00:00Z").getTime();
      return Number.isFinite(ts) ? ts : null;
    }
    return null;
  }

  function historyDayKey(h) {
    if (h && h.day) return String(h.day).slice(0, 10);
    const ts = historyTimestamp(h);
    return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null;
  }

  // Comparison chart: merge portfolio histories by day and keep each portfolio's
  // last value for that day. Mixing daily backtest-seeded histories with dense
  // live/DMA intraday histories made the right side consume most of the chart.
  const compDateMap = {};
  const compareStartDay = compareStart || null;
  pfStats.forEach(pf => {
    const latestByDay = {};
    (pf.history || []).forEach(h => {
      const ts = historyTimestamp(h);
      const day = historyDayKey(h);
      if (!Number.isFinite(ts)) return;
      if (!day || (compareStartDay && day < compareStartDay)) return;
      if (!latestByDay[day] || ts >= latestByDay[day].ts) latestByDay[day] = { ts: ts, value: h.value };
    });
    Object.keys(latestByDay).forEach(day => {
      if (!compDateMap[day]) compDateMap[day] = { t: new Date(day + "T00:00:00Z").getTime(), label: day };
      compDateMap[day][pf.id] = latestByDay[day].value;
    });
  });
  const compData = Object.values(compDateMap).sort((a, b) => a.t - b.t);

  // Simulation: run backtest for all 4 profiles
  const simProfiles = [
    { id: "conservative", name: "Conservative", color: "#3b82f6" },
    { id: "moderate", name: "Moderate", color: "#22c55e" },
    { id: "aggressive", name: "Aggressive", color: "#f59e0b" },
    { id: "yolo", name: "YOLO", color: "#ef4444" },
    { id: "dma", name: "KRAL Trend", color: "#8b5cf6" },
  ];
  const cryptoSymbols = Object.entries(COINS_META).filter(([, c]) => c.type === "crypto").map(([s]) => s);
  const allSymbolsMeta = Object.keys(prices);

  function buildSimulationChartData(results) {
    if (!results) return [];
    const dateMap = {};
    results.forEach((res, i) => {
      const pid = simProfiles[i].id;
      (res.equityCurve || []).forEach(pt => {
        if (!dateMap[pt.date]) dateMap[pt.date] = { date: pt.date };
        dateMap[pt.date][pid] = pt.value;
      });
    });
    // Add buy & hold reference: normalize to 100k start
    const firstResult = results[0];
    const startCash = (firstResult && firstResult.metrics) ? firstResult.metrics.startCash : 100000;
    const bhReturn = (firstResult && firstResult.metrics) ? firstResult.metrics.buyHoldReturn / 100 : 0;
    const dates = Object.keys(dateMap).sort();
    if (dates.length > 1) {
      const bhStart = startCash;
      const bhEnd = startCash * (1 + bhReturn);
      dates.forEach((d, i) => {
        dateMap[d].buyHold = +(bhStart + (bhEnd - bhStart) * (i / (dates.length - 1))).toFixed(2);
      });
    }
    return dates.map(d => dateMap[d]);
  }

  function startSimulationReplay(chartData, startIndex) {
    stopSimulationReplay();
    const data = chartData || [];
    setSimReplayData(data);
    const firstFrame = Math.min(data.length, Math.max(2, startIndex || 2));
    setSimReplayIndex(firstFrame);
    if (data.length <= 2) return;
    setSimReplayPlaying(true);
    const step = Math.max(1, Math.ceil(data.length / 180));
    simReplayTimerRef.current = setInterval(function() {
      setSimReplayIndex(function(cur) {
        const next = Math.min(data.length, cur + step);
        if (next >= data.length) {
          if (simReplayTimerRef.current) {
            clearInterval(simReplayTimerRef.current);
            simReplayTimerRef.current = null;
          }
          setSimReplayPlaying(false);
        }
        return next;
      });
    }, 70);
  }

  function playSimulationReplay() {
    if (!simReplayData.length) return;
    var startAt = simReplayIndex >= simReplayData.length ? 2 : simReplayIndex;
    startSimulationReplay(simReplayData, startAt);
  }

  function showFullSimulationReplay() {
    stopSimulationReplay();
    setSimReplayIndex(simReplayData.length);
  }

  function runSimulation() {
    if (!compareStart) return;
    setSimLoading(true);
    setSimError(null);
    setSimResults(null);
    stopSimulationReplay();
    setSimReplayData([]);
    setSimReplayIndex(0);
    Promise.all(simProfiles.map(p =>
      adminFetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: p.id, symbols: allSymbolsMeta, startDate: compareStart }),
      }).then(r => r.json())
    )).then(results => {
      setSimLoading(false);
      const err = results.find(r => r.error);
      if (err) { setSimError(err.error); return; }
      setSimResults(results);
      startSimulationReplay(buildSimulationChartData(results));
    }).catch(e => { setSimLoading(false); setSimError(e.message || 'Simulation failed'); });
  }

  function clearSimulation() {
    stopSimulationReplay();
    setSimResults(null);
    setSimError(null);
    setSimLoading(false);
    setSimReplayData([]);
    setSimReplayIndex(0);
  }

  // Note: click Simulate button to run comparison

  // Build simulation chart data by merging equity curves by date, then replay it progressively.
  const simChartDataFull = simReplayData.length ? simReplayData : buildSimulationChartData(simResults);
  const simReplayVisibleIndex = simResults ? Math.max(2, Math.min(simReplayIndex || simChartDataFull.length, simChartDataFull.length)) : 0;
  const simChartData = simResults ? simChartDataFull.slice(0, simReplayVisibleIndex) : [];
  const simReplayPct = simChartDataFull.length ? Math.round((simChartData.length / simChartDataFull.length) * 100) : 0;

  return (
    <div style={{ "--m": "'JetBrains Mono',monospace", "--h": "'Space Grotesk',sans-serif", minHeight: "100vh", background: "#0a0e17", color: "#e2e8f0", fontFamily: "'Space Grotesk',sans-serif" }}>

      {/* HEADER */}
      <div style={{ padding: isMobile ? "8px 12px" : "10px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(10,14,23,0.95)", flexWrap: "wrap", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#22c55e" : "#ef4444", boxShadow: `0 0 8px ${connected ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)"}`, animation: "pulse 2s infinite" }} />
          <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: "#f8fafc" }}>TRADE<span style={{ color: "#f59e0b" }}>SIMBOT</span></span>
          <span style={{ fontSize: 10, color: "#22c55e", background: "rgba(34,197,94,0.1)", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)", fontWeight: 600 }}>{connected ? "LIVE" : "OFFLINE"} · SERVER</span>
          {state.serverTime && <span style={{ fontSize: 9, color: "#4b5563", fontFamily: "var(--m)" }}>{new Date(state.serverTime).toLocaleTimeString()}</span>}
        </div>
        {!isMobile && <div style={{ display: "flex", gap: 12, fontFamily: "var(--m)", fontSize: 11 }}>
          {pfStats.map(pf => (
            <span key={pf.id}>
              <span style={{ color: pf.color, fontWeight: 600 }}>{pf.icon} </span>
              <span style={{ color: pf.pnl >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)}</span>
            </span>
          ))}
        </div>}
      </div>

      {/* TABS */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#0d1117", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        {[["compare", "Compare"], ["chart", "Chart"], ["portfolios", "Portfolios"], ["log", "Log"], ["backtest", "Backtest"], ["docs", "Docs"], ["settings", "Settings"], ["releases", "v1.21"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: isMobile ? "8px 12px" : "9px 20px", fontSize: isMobile ? 11 : 12, fontWeight: 500, background: "none", border: "none", cursor: "pointer", color: tab === k ? "#f8fafc" : "#6b7280", borderBottom: tab === k ? "2px solid #f59e0b" : "2px solid transparent", fontFamily: "var(--h)", whiteSpace: "nowrap", flexShrink: 0 }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 85px)" }}>
        {/* MOBILE SIDEBAR TOGGLE */}
        {isMobile && <button onClick={() => setShowSidebar(!showSidebar)} style={{ position: "fixed", bottom: 16, right: 16, zIndex: 100, width: 44, height: 44, borderRadius: "50%", background: "#f59e0b", color: "#0a0e17", border: "none", fontSize: 20, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 12px rgba(245,158,11,0.4)" }}>{showSidebar ? "✕" : "☰"}</button>}
        {/* SIDEBAR */}
        <div style={{ width: isMobile ? (showSidebar ? "100%" : 0) : 210, borderRight: showSidebar ? "1px solid rgba(255,255,255,0.06)" : "none", overflow: showSidebar ? "auto" : "hidden", background: "#0d1117", flexShrink: 0, transition: "width 0.2s", position: isMobile ? "fixed" : "relative", zIndex: isMobile ? 50 : "auto", height: isMobile ? "calc(100vh - 85px)" : "auto", top: isMobile ? 85 : "auto", left: 0 }}>
          {/* Asset filter tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
            {[["ALL", "#f8fafc"], ["CRYPTO", "#f59e0b"], ["STOCKS", "#a5b4fc"], ["GOLD", "#ffd700"]].map(([f, c]) => (
              <button key={f} onClick={() => setAssetFilter(f)} style={{ flex: 1, padding: "6px 0", fontSize: 8, fontWeight: 700, fontFamily: "var(--h)", letterSpacing: "0.05em", background: "none", border: "none", cursor: "pointer", color: assetFilter === f ? c : "#4b5563", borderBottom: assetFilter === f ? "2px solid " + c : "2px solid transparent" }}>{f}</button>
            ))}
          </div>
          {[{ label: "CRYPTO", filter: "crypto" }, { label: "COMMODITIES", filter: "commodity" }, { label: "STOCKS", filter: "stock" }].filter(section => {
            if (assetFilter === "ALL") return true;
            if (assetFilter === "CRYPTO") return section.filter === "crypto";
            if (assetFilter === "STOCKS") return section.filter === "stock";
            if (assetFilter === "GOLD") return section.filter === "commodity";
            return true;
          }).map(section => (
            <div key={section.filter}>
              <div style={{ padding: "8px 14px", fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 700, letterSpacing: "0.1em", borderBottom: "1px solid rgba(255,255,255,0.04)", background: "rgba(255,255,255,0.02)" }}>{section.label}</div>
              {Object.entries(COINS_META).filter(([sym, c]) => {
                if (c.type !== section.filter) return false;
                if (assetFilter === "GOLD" && section.filter === "commodity") return sym === "GOLD";
                return true;
              }).sort(([symA], [symB]) => {
                const tradesA = pfStats.reduce((s, pf) => s + (pf.orders || []).filter(o => o.sym === symA).length, 0);
                const tradesB = pfStats.reduce((s, pf) => s + (pf.orders || []).filter(o => o.sym === symB).length, 0);
                return tradesB - tradesA;
              }).map(([sym, c]) => {
                const p = prices[sym]?.cur || 0;
                const open = prices[sym]?.candles?.[0]?.o || p;
                const d = p - open; const dp = open > 0 ? d / open : 0;
                return (
                  <div key={sym} className="sr" onClick={() => { setSelected(sym); setTab("chart"); if (isMobile) setShowSidebar(false); }}
                    style={{ padding: "8px 14px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.03)", background: selected === sym ? "rgba(245,158,11,0.08)" : "transparent", borderLeft: selected === sym ? "2px solid #f59e0b" : "2px solid transparent" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontFamily: "var(--m)", fontWeight: 700, fontSize: 13, color: symColor(sym) }}>{sym}</div>
                        <div style={{ fontSize: 9, color: "#6b7280" }}>{c.name}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: "var(--m)", fontSize: 12, fontWeight: 600, color: "#f8fafc" }}>${fmt(p)}</div>
                        <div style={{ fontFamily: "var(--m)", fontSize: 9, color: d >= 0 ? "#22c55e" : "#ef4444" }}>{pc(dp)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 6 }}>INDICATORS · {selected}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <IndBadge label="RSI" value={sd.rsi?.toFixed(1)} color={sd.rsi < 30 ? "#22c55e" : sd.rsi > 70 ? "#ef4444" : "#f8fafc"} />
              <IndBadge label="MACD" value={sd.macd?.hist?.toFixed(2)} color={sd.macd?.hist > 0 ? "#22c55e" : "#ef4444"} />
              <IndBadge label="EMA9" value={`$${fmt(sd.ema9 || 0)}`} color="#22d3ee" />
              <IndBadge label="EMA21" value={`$${fmt(sd.ema21 || 0)}`} color="#f59e0b" />
              <IndBadge label="Stoch" value={sd.stoch?.k?.toFixed(0)} color={sd.stoch?.k < 20 ? "#22c55e" : sd.stoch?.k > 80 ? "#ef4444" : "#f8fafc"} />
              <IndBadge label="ADX" value={sd.adx?.toFixed(0)} color={sd.adx > 25 ? "#f59e0b" : "#6b7280"} />
              <IndBadge label="Candles" value={`${(sd.candles || []).length}`} color="#6b7280" />
            </div>
          </div>
        </div>

        {/* MAIN */}
        <div style={{ flex: 1, overflow: "auto" }}>

          {/* COMPARE */}
          {tab === "compare" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 4 }}>Portfolio Race</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 16 }}>5 risk profiles trading on real market data · Server-side 24/7</div>

              <DataQualityPanel data={dataQuality} loading={dataQualityLoading} error={dataQualityError} onRefresh={loadDataQuality} isMobile={isMobile} />

              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600 }}>{simResults ? "SIMULATED BACKTEST COMPARISON" : "PORTFOLIO VALUE OVER TIME"}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {!simResults && <>
                      <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600 }}>FROM</span>
                      <input type="date" value={compareStart} onChange={e => setCompareStart(e.target.value)} style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 10, fontFamily: "var(--m)", outline: "none" }} />
                      {compareStart && <button onClick={runSimulation} disabled={simLoading} style={{ padding: "3px 8px", borderRadius: 4, border: "none", background: simLoading ? "#374151" : "#f59e0b", color: simLoading ? "#9ca3af" : "#0a0e17", fontSize: 9, cursor: simLoading ? "not-allowed" : "pointer", fontFamily: "var(--m)", fontWeight: 700 }}>{simLoading ? "Running..." : "Simulate"}</button>}
                    </>}
                    {(simResults || simLoading) && <button onClick={() => { clearSimulation(); setCompareStart(""); }} style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "var(--m)" }}>Clear</button>}
                    {!simResults && !simLoading && compareStart && <button onClick={() => setCompareStart("")} style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "var(--m)" }}>Reset</button>}
                  </div>
                </div>
                {simError && <div style={{ padding: "8px 12px", marginBottom: 8, borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", fontSize: 11, fontFamily: "var(--m)" }}>{simError}</div>}
                {simLoading ? (
                  <div style={{ height: 280, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                    <div style={{ display: "inline-block", width: 32, height: 32, border: "3px solid #1e293b", borderTop: "3px solid #f59e0b", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                    <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--m)" }}>Running 5 backtests from {compareStart}...</div>
                  </div>
                ) : simResults && simChartData.length > 2 ? (
                  <ZoomChart dataKey="date" dataLength={simChartData.length}>
                  <ResponsiveContainer width="100%" height={320}>
                    <LineChart data={simChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#6b7280" }} tickFormatter={d => d ? d.slice(5) : ""} interval={Math.max(1, Math.floor(simChartData.length / 8))} />
                      <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={v => `$${fK(v)}`} />
                      <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} labelFormatter={d => d} formatter={(v, name) => [`$${fK(v)}`, name]} />
                      {simProfiles.map(p => (
                        <Line key={p.id} type="monotone" dataKey={p.id} name={p.name} stroke={p.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                      ))}
                      <Line type="monotone" dataKey="buyHold" name="Buy & Hold" stroke="#6b7280" strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                  </ZoomChart>
                ) : compData.length > 2 ? (
                  <ZoomChart dataKey="t" dataLength={compData.length}>
                  <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={compData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="t" hide />
                      <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={v => `$${fK(v)}`} />
                      <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} labelFormatter={(v, payload) => payload && payload[0] && payload[0].payload ? payload[0].payload.label : ""} formatter={(v) => [`$${fK(v)}`, ""]} />
                      {pfStats.map(pf => (
                        <Area key={pf.id} type="monotone" dataKey={pf.id} name={pf.name} stroke={pf.color} fill={pf.color} fillOpacity={0.08} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={true} />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                  </ZoomChart>
                ) : (
                  <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>Warming up... strategies trigger on candle close</div>
                )}
                {simResults && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", justifyContent: "center", alignItems: "center" }}>
                    {simProfiles.map(p => (
                      <span key={p.id} style={{ fontSize: 9, fontFamily: "var(--m)", color: p.color, fontWeight: 600 }}>{"\u25CF"} {p.name}</span>
                    ))}
                    <span style={{ fontSize: 9, fontFamily: "var(--m)", color: "#6b7280", fontWeight: 600 }}>{"\u25CF"} Buy & Hold (dashed)</span>
                    <span style={{ fontSize: 9, fontFamily: "var(--m)", color: "#818cf8", fontWeight: 700, marginLeft: 6 }}>Replay {simReplayPct}%</span>
                    <button onClick={simReplayPlaying ? stopSimulationReplay : playSimulationReplay} className="bt" style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#94a3b8", fontSize: 9, fontFamily: "var(--m)", fontWeight: 700, cursor: "pointer" }}>{simReplayPlaying ? "Pause" : "Play"}</button>
                    <button onClick={showFullSimulationReplay} className="bt" style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#6b7280", fontSize: 9, fontFamily: "var(--m)", fontWeight: 700, cursor: "pointer" }}>Full</button>
                  </div>
                )}
              </div>

              {/* Simulation comparison table */}
              {simResults && (
                <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ padding: "10px 16px", fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>BACKTEST COMPARISON · {compareStart} to present</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "var(--m)" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                          {["Profile", "Total Return", "Win Rate", "Max Drawdown", "Sharpe", "Total Trades", "Final Equity"].map(h => (
                            <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#6b7280", fontSize: 9, fontFamily: "var(--h)", fontWeight: 600 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {simResults.map((res, i) => {
                          const m = res.metrics || {};
                          const p = simProfiles[i];
                          return (
                            <tr key={p.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                              <td style={{ padding: "8px 12px", color: p.color, fontWeight: 700 }}>{p.name}</td>
                              <td style={{ padding: "8px 12px", color: m.totalReturn >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{m.totalReturn >= 0 ? "+" : ""}{m.totalReturn}%</td>
                              <td style={{ padding: "8px 12px", color: "#94a3b8" }}>{m.winRate}%</td>
                              <td style={{ padding: "8px 12px", color: "#ef4444" }}>{m.maxDrawdown}%</td>
                              <td style={{ padding: "8px 12px", color: m.sharpe >= 1 ? "#22c55e" : m.sharpe >= 0 ? "#f59e0b" : "#ef4444" }}>{m.sharpe}</td>
                              <td style={{ padding: "8px 12px", color: "#94a3b8" }}>{m.totalTrades}</td>
                              <td style={{ padding: "8px 12px", color: "#f8fafc", fontWeight: 600 }}>${fK(m.finalEquity)}</td>
                            </tr>
                          );
                        })}
                        <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                          <td style={{ padding: "8px 12px", color: "#6b7280", fontWeight: 600 }}>Buy & Hold</td>
                          <td style={{ padding: "8px 12px", color: (simResults[0]?.metrics?.buyHoldReturn || 0) >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{(simResults[0]?.metrics?.buyHoldReturn || 0) >= 0 ? "+" : ""}{simResults[0]?.metrics?.buyHoldReturn || 0}%</td>
                          <td colSpan="5" style={{ padding: "8px 12px", color: "#4b5563", fontSize: 9 }}>Equal-weight crypto basket</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
                {[...pfStats].sort((a, b) => b.pnl - a.pnl).map((pf, rank) => {
                  const wr = pf.wins + pf.losses > 0 ? (pf.wins / (pf.wins + pf.losses) * 100).toFixed(0) : "--";
                  return (
                    <div key={pf.id} style={{ background: "#0f172a", borderRadius: 10, padding: 16, border: `1px solid ${rank === 0 && pf.pnl > 0 ? pf.color + "66" : "rgba(255,255,255,0.04)"}`, position: "relative" }}>
                      {rank === 0 && pf.pnl > 0 && <div style={{ position: "absolute", top: 8, right: 10, fontSize: 8, background: "rgba(245,158,11,0.2)", color: "#f59e0b", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)", fontWeight: 700 }}>LEADING</div>}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <span style={{ fontSize: 20 }}>{pf.icon}</span>
                        <div>
                          <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 15, color: pf.color, display: "flex", alignItems: "center", gap: 6 }}>{pf.name} <span style={{ fontSize: 8, padding: "1px 6px", borderRadius: 3, fontWeight: 700, fontFamily: "var(--m)", background: pf.state === "STOPPED" ? "rgba(239,68,68,0.2)" : pf.state === "DEGRADED" ? "rgba(234,179,8,0.2)" : "rgba(34,197,94,0.2)", color: pf.state === "STOPPED" ? "#ef4444" : pf.state === "DEGRADED" ? "#eab308" : "#22c55e" }}>{pf.state || "RUNNING"}</span></div>
                          <div style={{ fontSize: 9, color: "#6b7280" }}>{pf.desc}</div>
                        </div>
                      </div>
                      <div style={{ fontFamily: "var(--m)", fontSize: 24, fontWeight: 700, color: "#f8fafc", marginBottom: 4 }}>${fK(pf.totalValue)}</div>
                      <div style={{ fontFamily: "var(--m)", fontSize: 14, color: pf.pnl >= 0 ? "#22c55e" : "#ef4444", marginBottom: 12 }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)} ({pc(pf.pnl / pf.startCash)})</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 10, fontFamily: "var(--m)" }}>
                        {[{ l: "CASH", v: `$${fK(pf.cash)}` }, { l: "POSITIONS", v: `$${fK(pf.hVal)}` }, { l: "TRADES", v: pf.tradeCount }, { l: "WIN %", v: `${wr}%` }, { l: "COMMISSION", v: `$${fK(pf.totalCommission || 0)}` }, { l: "NET P&L", v: `$${fK(pf.pnl)}` }].map((s, i) => (
                          <div key={i} style={{ background: "#0a0e17", borderRadius: 4, padding: "6px 8px" }}>
                            <div style={{ color: "#6b7280", fontSize: 8 }}>{s.l}</div>
                            <div style={{ color: "#94a3b8" }}>{s.v}</div>
                          </div>
                        ))}
                      </div>
                      {pf.holdings && Object.keys(pf.holdings).length > 0 && (
                        <div style={{ marginTop: 8, display: "flex", gap: 3, flexWrap: "wrap" }}>
                          {Object.entries(pf.holdings).slice(0, 8).map(([sym, h]) => {
                            const sc = (state.scores && state.scores[pf.id] && state.scores[pf.id][sym]) || {};
                            return <span key={sym} style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "rgba(255,255,255,0.04)", color: symColor(sym), fontFamily: "var(--m)", fontWeight: 600 }}>{sym} {sc.regime ? `[${sc.regime}]` : ''}</span>;
                          })}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                        <a href={"/api/portfolio/" + pf.id + "/export/csv"} download className="bt" style={{ flex: 1, padding: "5px 0", borderRadius: 4, border: "1px solid #22c55e", background: "transparent", color: "#22c55e", fontSize: 9, fontWeight: 600, fontFamily: "var(--h)", textAlign: "center", textDecoration: "none" }}>CSV</a>
                        <a href={"/api/portfolio/" + pf.id + "/export/json"} download className="bt" style={{ flex: 1, padding: "5px 0", borderRadius: 4, border: "1px solid #6366f1", background: "transparent", color: "#6366f1", fontSize: 9, fontWeight: 600, fontFamily: "var(--h)", textAlign: "center", textDecoration: "none" }}>JSON</a>
                        {pf.state === "STOPPED" && <button onClick={() => sendWs({ type: 'resume', id: pf.id })} style={{ flex: 1, padding: "5px 0", borderRadius: 4, border: "1px solid #eab308", background: "rgba(234,179,8,0.1)", color: "#eab308", fontSize: 9, fontWeight: 600, fontFamily: "var(--h)", cursor: "pointer" }}>RESUME</button>}
                        <button onClick={() => { if (confirm('Reset ' + pf.name + '?')) resetPf(pf.id); }} style={{ flex: 1, padding: "5px 0", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#6b7280", fontSize: 9, fontWeight: 600, fontFamily: "var(--h)", cursor: "pointer" }}>RESET</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Leaderboard */}
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", overflow: "hidden" }}>
                <div style={{ padding: "10px 16px", fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>LEADERBOARD</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "24px 1fr 70px 70px" : "30px 1fr 90px 90px 90px 70px 60px", padding: "6px 16px", fontSize: 9, color: "#4b5563", fontFamily: "var(--h)", fontWeight: 600 }}>
                  <span>#</span><span>PORTFOLIO</span><span>VALUE</span><span>P&L</span>{!isMobile && <><span>P&L %</span><span>TRADES</span><span>WIN %</span></>}
                </div>
                {[...pfStats].sort((a, b) => b.pnl - a.pnl).map((pf, i) => {
                  const wr = pf.wins + pf.losses > 0 ? (pf.wins / (pf.wins + pf.losses) * 100).toFixed(0) : "--";
                  return (
                    <div key={pf.id} style={{ display: "grid", gridTemplateColumns: isMobile ? "24px 1fr 70px 70px" : "30px 1fr 90px 90px 90px 70px 60px", padding: "8px 16px", fontSize: isMobile ? 10 : 11, fontFamily: "var(--m)", borderTop: "1px solid rgba(255,255,255,0.02)", background: i === 0 ? "rgba(245,158,11,0.03)" : "transparent" }}>
                      <span style={{ color: i === 0 ? "#f59e0b" : "#6b7280", fontWeight: 700 }}>{i + 1}</span>
                      <span style={{ color: pf.color, fontWeight: 600 }}>{pf.icon} {isMobile ? "" : pf.name}</span>
                      <span style={{ color: "#f8fafc" }}>${fK(pf.totalValue)}</span>
                      <span style={{ color: pf.pnl >= 0 ? "#22c55e" : "#ef4444" }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)}</span>
                      {!isMobile && <><span style={{ color: pf.pnl >= 0 ? "#22c55e" : "#ef4444" }}>{pc(pf.pnl / pf.startCash)}</span>
                      <span style={{ color: "#94a3b8" }}>{pf.tradeCount}</span>
                      <span style={{ color: wr !== "--" && parseInt(wr) >= 50 ? "#22c55e" : "#ef4444" }}>{wr}%</span></>}
                    </div>
                  );
                })}
              </div>

              {/* RECENT TRADES on Compare page */}
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", overflow: "hidden", marginTop: 12 }}>
                <div style={{ padding: "10px 16px", fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between" }}>
                  <span>RECENT TRADES</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <a href="/api/logs" download style={{ padding: "2px 8px", borderRadius: 3, border: "1px solid #22c55e", color: "#22c55e", fontSize: 9, fontWeight: 600, textDecoration: "none" }}>CSV</a>
                    <a href="/api/logs/json" download style={{ padding: "2px 8px", borderRadius: 3, border: "1px solid #6366f1", color: "#6366f1", fontSize: 9, fontWeight: 600, textDecoration: "none" }}>JSON</a>
                  </div>
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  {(() => {
                    const allOrders = pfStats.flatMap(pf => (pf.orders || []).slice(0, 20).map(o => ({ ...o, pfColor: pf.color, pfIcon: pf.icon })));
                    allOrders.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
                    return allOrders.slice(0, 30).map((o, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: isMobile ? 4 : 6, padding: isMobile ? "3px 8px" : "4px 12px", borderBottom: "1px solid rgba(255,255,255,0.02)", fontFamily: "var(--m)", fontSize: isMobile ? 9 : 10 }}>
                        <span style={{ fontSize: 10 }}>{o.pfIcon}</span>
                        <span style={{ color: "#4b5563", minWidth: 40, fontSize: 8 }}>{o.time ? fmtTime(o.time) : "--"}</span>
                        <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: o.side === "buy" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: o.side === "buy" ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{o.side === "buy" ? "BUY" : "SELL"}</span>
                        <span style={{ color: symColor(o.sym), fontWeight: 700 }}>{o.sym}</span>
                        <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fK(o.total || (o.price || 0) * (o.qty || 0))}</span>
                        {o.pnl !== undefined && o.pnl !== 0 && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: o.pnl > 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: o.pnl > 0 ? "#22c55e" : "#ef4444" }}>{o.pnl > 0 ? "+" : ""}${fK(o.pnl)}</span>}
                        {o.score && <span style={{ fontSize: 8, color: "#f59e0b" }}>{o.score}</span>}
                        {o.why && <span style={{ color: "#a78bfa", fontSize: 8 }}>{o.why}</span>}
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* CHART */}
          {tab === "chart" && (() => {
            const maxVol = Math.max(...chartCandles.map(c => c.v || 0), 1);
            const avgVol = chartCandles.length > 0 ? chartCandles.reduce((s, c) => s + (c.v || 0), 0) / chartCandles.length : 1;
            return (
            <div style={{ padding: isMobile ? "10px 8px" : "16px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                  <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 24, color: symColor(selected) }}>{selected}/{COINS_META[selected]?.type === "crypto" ? "USDT" : "USD"}</span>
                  <div style={{ display: "flex", gap: 2 }}>
                    {TIMEFRAMES.map(t => (
                      <button key={t.label} onClick={() => setTf(t.label)} style={{ padding: "2px 8px", borderRadius: 4, border: tf === t.label ? "1px solid #f59e0b" : "1px solid #1e293b", background: tf === t.label ? "rgba(245,158,11,0.15)" : "transparent", color: tf === t.label ? "#f59e0b" : "#6b7280", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>{t.label}</button>
                    ))}
                  </div>
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

              {/* Loading indicator for historical data */}
              {histLoading && (
                <div style={{ position: "relative", height: 20, marginBottom: 4 }}>
                  <div style={{ position: "absolute", top: 0, right: 0, display: "flex", alignItems: "center", gap: 6, background: "rgba(15,23,42,0.9)", padding: "3px 10px", borderRadius: 4, zIndex: 10 }}>
                    <div style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #1e293b", borderTop: "2px solid #a78bfa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                    <span style={{ fontSize: 9, color: "#a78bfa", fontFamily: "var(--m)" }}>Loading history...</span>
                  </div>
                </div>
              )}
              {histData && histData.symbol === selected && !histLoading && (
                <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--m)", marginBottom: 4, textAlign: "right" }}>{histData.candles.length} daily + {(sd.candles || []).length} live candles</div>
              )}

              {chartCandles.length > 2 ? (
                <div ref={chartRef} style={{ cursor: "crosshair", position: "relative" }}>
                {chartZoom && <div style={{ position: "absolute", top: 4, right: 8, zIndex: 10, display: "flex", gap: 4 }}>
                  <span style={{ fontSize: 9, color: "#818cf8", fontFamily: "var(--m)", background: "rgba(99,102,241,0.15)", padding: "2px 6px", borderRadius: 3 }}>{chartZoomPct}%</span>
                  <span onClick={() => setChartZoom(null)} style={{ fontSize: 9, color: "#ef4444", cursor: "pointer", fontFamily: "var(--m)", background: "rgba(239,68,68,0.1)", padding: "2px 6px", borderRadius: 3 }}>Reset</span>
                </div>}
                {chartType === "candle" ? (
                  <div ref={el => {
                    if (!el) return;
                    const W = el.offsetWidth - 16;
                    const H = 380;
                    const ml = 65, mr = 12, mt = 12, mb = 32;
                    const pw = W - ml - mr, ph = H - mt - mb;
                    const allP = chartCandles.flatMap(c => [c.h, c.l]);
                    const pad = (Math.max(...allP) - Math.min(...allP)) * 0.05 || 1;
                    const minP = Math.min(...allP) - pad, maxP = Math.max(...allP) + pad;
                    const range = maxP - minP || 1;
                    const yS = v => mt + ph - ((v - minP) / range) * ph;
                    const n = chartCandles.length;
                    const bw = Math.max(Math.min(pw / n * 0.6, 12), 3);
                    const xS = i => ml + (i + 0.5) * (pw / n);
                    const bbU = sd.bb?.upper || 0, bbL = sd.bb?.lower || 0;
                    // c.t is already formatted "HH:MM" string from chartCandles

                    let s = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">`;
                    // Background
                    s += `<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="#0a0e17" rx="4"/>`;
                    // Grid + Y axis (6 levels)
                    for (let j = 0; j <= 5; j++) {
                      const v = minP + range * j / 5, y = yS(v);
                      s += `<line x1="${ml}" y1="${y}" x2="${ml + pw}" y2="${y}" stroke="#1e293b" stroke-width="0.5"/>`;
                      s += `<text x="${ml - 6}" y="${y + 3}" fill="#64748b" font-size="9" font-family="'JetBrains Mono',monospace" text-anchor="end">$${fmt(v)}</text>`;
                    }
                    // X axis time labels
                    const step = Math.max(1, Math.floor(n / 7));
                    for (let i = 0; i < n; i += step) {
                      const c = chartCandles[i], x = xS(i);
                      const t = c.t || '';
                      if (!t) continue;
                      s += `<line x1="${x}" y1="${mt + ph}" x2="${x}" y2="${mt + ph + 5}" stroke="#334155" stroke-width="0.5"/>`;
                      s += `<text x="${x}" y="${mt + ph + 18}" fill="#64748b" font-size="9" font-family="'JetBrains Mono',monospace" text-anchor="middle">${t}</text>`;
                    }
                    // EMA lines as smooth paths
                    const ema9pts = [], ema21pts = [];
                    chartCandles.forEach((c, i) => { if (i >= 9) ema9pts.push(`${xS(i)},${yS(c.c)}`); if (i >= 21) ema21pts.push(`${xS(i)},${yS(c.c)}`); });
                    // BB band fill
                    if (bbU > 0 && bbL > 0) {
                      s += `<rect x="${ml}" y="${yS(bbU)}" width="${pw}" height="${Math.abs(yS(bbL) - yS(bbU))}" fill="rgba(99,102,241,0.04)" rx="2"/>`;
                      s += `<line x1="${ml}" y1="${yS(bbU)}" x2="${ml+pw}" y2="${yS(bbU)}" stroke="#6366f1" stroke-dasharray="4 2" stroke-width="0.7" opacity="0.4"/>`;
                      s += `<line x1="${ml}" y1="${yS(bbL)}" x2="${ml+pw}" y2="${yS(bbL)}" stroke="#6366f1" stroke-dasharray="4 2" stroke-width="0.7" opacity="0.4"/>`;
                    }
                    if (sd.ema9 > 0) s += `<line x1="${ml}" y1="${yS(sd.ema9)}" x2="${ml+pw}" y2="${yS(sd.ema9)}" stroke="#22d3ee" stroke-dasharray="3 2" stroke-width="0.7" opacity="0.5"/>`;
                    if (sd.ema21 > 0) s += `<line x1="${ml}" y1="${yS(sd.ema21)}" x2="${ml+pw}" y2="${yS(sd.ema21)}" stroke="#f59e0b" stroke-dasharray="3 2" stroke-width="0.7" opacity="0.5"/>`;
                    // Candles with glow
                    chartCandles.forEach((c, i) => {
                      const x = xS(i), g = c.c >= c.o;
                      const col = g ? "#22c55e" : "#ef4444";
                      const colDim = g ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)";
                      const oY = yS(c.o), cY = yS(c.c), hY = yS(c.h), lY = yS(c.l);
                      const top = Math.min(oY, cY), bot = Math.max(oY, cY), bh = Math.max(bot - top, 1);
                      // Wick
                      s += `<line x1="${x}" y1="${hY}" x2="${x}" y2="${lY}" stroke="${col}" stroke-width="1" opacity="0.7"/>`;
                      // Body glow
                      s += `<rect x="${x - bw/2 - 1}" y="${top - 1}" width="${bw + 2}" height="${bh + 2}" fill="${colDim}" rx="2"/>`;
                      // Body
                      s += `<rect x="${x - bw/2}" y="${top}" width="${bw}" height="${bh}" fill="${col}" rx="1"/>`;
                    });
                    // Current price line
                    const curY = yS(sd.cur);
                    s += `<line x1="${ml}" y1="${curY}" x2="${ml+pw}" y2="${curY}" stroke="#f59e0b" stroke-dasharray="2 2" stroke-width="0.8" opacity="0.8"/>`;
                    s += `<rect x="${ml+pw+2}" y="${curY - 8}" width="50" height="16" fill="#f59e0b" rx="3"/>`;
                    s += `<text x="${ml+pw+27}" y="${curY + 4}" fill="#0a0e17" font-size="8" font-family="'JetBrains Mono',monospace" text-anchor="middle" font-weight="600">$${fmt(sd.cur)}</text>`;
                    // EMA labels
                    if (sd.ema9 > 0) { const ey = yS(sd.ema9); s += `<text x="${ml + 4}" y="${ey - 4}" fill="#22d3ee" font-size="7" font-family="'JetBrains Mono',monospace" opacity="0.7">EMA9</text>`; }
                    if (sd.ema21 > 0) { const ey = yS(sd.ema21); s += `<text x="${ml + 4}" y="${ey - 4}" fill="#f59e0b" font-size="7" font-family="'JetBrains Mono',monospace" opacity="0.7">EMA21</text>`; }
                    s += `</svg>`;
                    el.innerHTML = s;
                  }} style={{ background: "#0f172a", borderRadius: 10, padding: "8px", border: "1px solid rgba(255,255,255,0.06)" }} />
                ) : (
                  <ResponsiveContainer width="100%" height={340}>
                    <ComposedChart data={chartCandles} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
                      <XAxis dataKey="t" tick={{ fontSize: 9, fill: "#4b5563" }} interval="preserveStartEnd" />
                      <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "#4b5563" }} tickFormatter={v => `$${fmt(v)}`} />
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} formatter={(v, name) => [`$${fmt(v)}`, name === "c" ? "Close" : name]} />
                      <Line type="monotone" dataKey="c" stroke={ch >= 0 ? "#22c55e" : "#ef4444"} strokeWidth={2} dot={false} isAnimationActive={false} name="c" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
                </div>
              ) : (
                <div style={{ height: 340, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>Loading candle data...</div>
              )}

              {chartCandles.length > 2 && (
                <div style={{ marginTop: 8, background: "#0f172a", borderRadius: 6, padding: "8px 12px", border: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600 }}>VOLUME</span>
                    <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--m)" }}>avg: {fK(avgVol)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 40 }}>
                    {chartCandles.map((c, i) => {
                      const pct = (c.v || 0) / maxVol;
                      const isHigh = (c.v || 0) > avgVol * 1.5;
                      return (
                        <div key={i} title={`Vol: ${fK(c.v || 0)}`} style={{ flex: 1, height: `${Math.max(pct * 100, 2)}%`, borderRadius: "2px 2px 0 0", background: isHigh ? (c.c >= c.o ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)") : "rgba(99,102,241,0.2)", transition: "height 0.2s" }} />
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <IndBadge label="RSI(14)" value={sd.rsi?.toFixed(1)} color={sd.rsi < 30 ? "#22c55e" : sd.rsi > 70 ? "#ef4444" : "#f8fafc"} />
                <IndBadge label="MACD" value={sd.macd?.hist?.toFixed(2)} color={sd.macd?.hist > 0 ? "#22c55e" : "#ef4444"} />
                <IndBadge label="BB" value={`${fmt(sd.bb?.lower || 0)} — ${fmt(sd.bb?.upper || 0)}`} color="#a5b4fc" />
                <IndBadge label="EMA9" value={`$${fmt(sd.ema9 || 0)}`} color="#22d3ee" />
                <IndBadge label="EMA21" value={`$${fmt(sd.ema21 || 0)}`} color="#f59e0b" />
                <IndBadge label="Stoch" value={sd.stoch?.k?.toFixed(0)} color={sd.stoch?.k < 20 ? "#22c55e" : sd.stoch?.k > 80 ? "#ef4444" : "#f8fafc"} />
                <IndBadge label="ADX" value={sd.adx?.toFixed(0)} color={sd.adx > 25 ? "#f59e0b" : "#6b7280"} />
              </div>
            </div>
            );
          })()}

          {/* PORTFOLIOS */}
          {tab === "portfolios" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 16 }}>Portfolio Details</div>
              {pfStats.map(pf => {
                // Build allocation data for donut chart
                const holdingEntries = Object.entries(pf.holdings || {}).filter(([,h]) => h && h.qty > 0);
                const allocData = holdingEntries.map(([sym, h]) => {
                  const p = prices[sym]?.cur || 0;
                  return { name: sym, value: +(h.qty * p).toFixed(2), color: symColor(sym) };
                }).sort((a, b) => b.value - a.value);
                if (pf.cash > 0) allocData.push({ name: 'Cash', value: +pf.cash.toFixed(2), color: '#4b5563' });
                const allocTotal = allocData.reduce((s, d) => s + d.value, 0);
                return (
                <div key={pf.id} style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{pf.icon}</span>
                      <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: pf.color }}>{pf.name}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <a href={"/api/portfolio/" + pf.id + "/export/csv"} download className="bt" style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #22c55e", background: "transparent", color: "#22c55e", fontSize: 9, fontWeight: 600, fontFamily: "var(--m)", textDecoration: "none" }}>CSV</a>
                      <a href={"/api/portfolio/" + pf.id + "/export/json"} download className="bt" style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #6366f1", background: "transparent", color: "#6366f1", fontSize: 9, fontWeight: 600, fontFamily: "var(--m)", textDecoration: "none" }}>JSON</a>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: "var(--m)", fontSize: 18, fontWeight: 600, color: "#f8fafc" }}>${fK(pf.totalValue)}</div>
                        <div style={{ fontFamily: "var(--m)", fontSize: 12, color: pf.pnl >= 0 ? "#22c55e" : "#ef4444" }}>{pf.pnl >= 0 ? "+" : ""}${fK(pf.pnl)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Donut Chart - Asset Allocation */}
                  {allocData.length > 1 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
                      <div style={{ width: 160, height: 160, flexShrink: 0 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={allocData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={1} isAnimationActive={false}>
                              {allocData.map((entry, idx) => (
                                <Cell key={idx} fill={entry.color} stroke="none" />
                              ))}
                            </Pie>
                            <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} formatter={(v, name) => ["$" + fK(v) + " (" + (allocTotal > 0 ? ((v / allocTotal) * 100).toFixed(1) : 0) + "%)", name]} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                        {allocData.slice(0, 10).map(d => (
                          <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontFamily: "var(--m)" }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
                            <span style={{ color: d.color, fontWeight: 600, minWidth: 36 }}>{d.name}</span>
                            <span style={{ color: "#94a3b8" }}>${fK(d.value)}</span>
                            <span style={{ color: "#6b7280", fontSize: 9 }}>{allocTotal > 0 ? ((d.value / allocTotal) * 100).toFixed(1) : 0}%</span>
                          </div>
                        ))}
                        {allocData.length > 10 && <span style={{ fontSize: 9, color: "#4b5563" }}>+{allocData.length - 10} more</span>}
                      </div>
                    </div>
                  )}

                  {!pf.holdings || Object.keys(pf.holdings).length === 0 ? (
                    <div style={{ fontSize: 11, color: "#374151", textAlign: "center", padding: 8 }}>No positions yet</div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6 }}>
                      {holdingEntries.map(([sym, h]) => {
                        const p = prices[sym]?.cur || 0;
                        const v = h.qty * p;
                        const pl = (p - h.avgCost) * h.qty;
                        const lots = h.lots || [];
                        return (
                          <div key={sym} style={{ background: "#0a0e17", borderRadius: 6, padding: "8px 10px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: lots.length > 0 ? 4 : 0 }}>
                              <div>
                                <span style={{ fontFamily: "var(--m)", fontWeight: 600, fontSize: 12, color: symColor(sym) }}>{sym}</span>
                                <span style={{ fontSize: 9, color: "#6b7280", marginLeft: 4 }}>{h.qty < 1 ? h.qty.toFixed(4) : h.qty.toFixed(2)}</span>
                              </div>
                              <div style={{ textAlign: "right" }}>
                                <div style={{ fontFamily: "var(--m)", fontSize: 10, color: "#f8fafc" }}>${fmt(v)}</div>
                                <div style={{ fontFamily: "var(--m)", fontSize: 9, color: pl >= 0 ? "#22c55e" : "#ef4444" }}>{pl >= 0 ? "+" : ""}${fmt(pl)}</div>
                              </div>
                            </div>
                            {lots.length > 0 && (
                              <div style={{ borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 3, marginTop: 2 }}>
                                {lots.map((lot, li) => {
                                  const lotPnl = (p - lot.cost) * lot.qty;
                                  const lotPnlPct = lot.cost > 0 ? ((p - lot.cost) / lot.cost) * 100 : 0;
                                  return (
                                    <div key={li} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 8, fontFamily: "var(--m)", color: "#6b7280", padding: "1px 0" }}>
                                      <span>Lot {li + 1}: {lot.qty < 1 ? lot.qty.toFixed(4) : lot.qty.toFixed(2)} @ ${fmt(lot.cost)}</span>
                                      <span style={{ color: lotPnl >= 0 ? "#22c55e" : "#ef4444" }}>{lotPnl >= 0 ? "+" : ""}${fmt(lotPnl)} ({lotPnlPct >= 0 ? "+" : ""}{lotPnlPct.toFixed(1)}%)</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}

          {/* LOG */}
          {tab === "log" && (
            <div style={{ padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc" }}>Trade Log</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <a href="/api/logs" download style={{ padding: "5px 12px", borderRadius: 4, border: "1px solid #22c55e", background: "transparent", color: "#22c55e", fontSize: 10, fontWeight: 600, fontFamily: "var(--m)", textDecoration: "none", cursor: "pointer" }}>CSV</a>
                  <a href="/api/logs/json" download style={{ padding: "5px 12px", borderRadius: 4, border: "1px solid #6366f1", background: "transparent", color: "#6366f1", fontSize: 10, fontWeight: 600, fontFamily: "var(--m)", textDecoration: "none", cursor: "pointer" }}>JSON</a>
                </div>
              </div>
              {pfStats.map(pf => (
                <div key={pf.id} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 14 }}>{pf.icon}</span>
                    <span style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 13, color: pf.color }}>{pf.name}</span>
                    <span style={{ fontSize: 9, color: "#6b7280" }}>{pf.tradeCount} trades</span>
                  </div>
                  {!pf.orders || pf.orders.length === 0 ? (
                    <div style={{ fontSize: 11, color: "#374151", padding: 8 }}>No trades yet</div>
                  ) : (
                    <div style={{ background: "#0f172a", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)", maxHeight: 200, overflowY: "auto" }}>
                      {pf.orders.map((o, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: isMobile ? 4 : 6, padding: isMobile ? "4px 6px" : "5px 10px", borderBottom: "1px solid rgba(255,255,255,0.02)", fontFamily: "var(--m)", fontSize: isMobile ? 9 : 10, flexWrap: isMobile ? "wrap" : "nowrap" }}>
                          <span style={{ color: "#4b5563", minWidth: isMobile ? 40 : 52, fontSize: isMobile ? 8 : 10 }}>{o.time ? fmtTime(o.time) : "--"}</span>
                          <span style={{ fontSize: isMobile ? 8 : 9, padding: "1px 6px", borderRadius: 3, background: o.side === "buy" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: o.side === "buy" ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{o.side === "buy" ? "BUY" : "SELL"}</span>
                          <span style={{ color: symColor(o.sym), fontWeight: 700 }}>{o.sym}</span>
                          <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fK((o.price || 0) * (o.qty || 0))}</span>
                          {o.pnl !== undefined && o.pnl !== 0 && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: o.pnl > 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: o.pnl > 0 ? "#22c55e" : "#ef4444" }}>{o.pnl > 0 ? "+" : ""}${fK(o.pnl)}</span>}
                          <span style={{ color: "#6366f1", fontWeight: 600 }}>{o.strat}</span>
                          {o.why && !isMobile && <span style={{ color: "#a78bfa", fontWeight: 600 }}>| {o.why}</span>}
                          {o.score && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: "rgba(245,158,11,0.1)", color: "#f59e0b", fontFamily: "var(--m)" }}>score:{o.score}</span>}
                          {o.regime && !isMobile && <span style={{ fontSize: 8, color: "#4b5563" }}>[{o.regime}]</span>}
                          {o.side === "buy" && o.bracketTP && o.bracketSL && <span style={{ fontSize: 8, color: "#6b7280", fontFamily: "var(--m)" }}>TP: <span style={{ color: "#22c55e" }}>${fK(o.bracketTP)}</span> | SL: <span style={{ color: "#ef4444" }}>${fK(o.bracketSL)}</span></span>}
                          {isMobile && o.why && <div style={{ width: "100%", color: "#a78bfa", fontSize: 8 }}>{o.why}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* BACKTEST */}
          {tab === "backtest" && (() => {
            return <BacktestTab isMobile={isMobile} />;
          })()}

          {/* DOCS / STRATEGY GUIDE */}
          {tab === "docs" && (
            <div style={{ padding: isMobile ? "16px 12px" : "20px 24px", maxWidth: 760 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 22, color: "#f8fafc", marginBottom: 4 }}>Trading Strategies</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 20 }}>Two independent trading modules run in parallel, each with its own portfolio and logic.</div>

              {/* Module 1: Signal Scoring */}
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: isMobile ? 14 : 20, marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 18 }}>&#x1F9E0;</span>
                  <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: "#f59e0b" }}>Module 1: Signal Scoring System</span>
                  <span style={{ fontSize: 9, color: "#6b7280", background: "rgba(255,255,255,0.04)", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--m)" }}>31 signals</span>
                </div>

                <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "var(--m)", lineHeight: 1.7 }}>
                  <div style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#e2e8f0", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>How it works</div>
                  <div style={{ padding: "0 0 0 12px", borderLeft: "2px solid rgba(245,158,11,0.2)", marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>31 technical analysis signals each produce a weighted score</div>
                    <div style={{ marginBottom: 4 }}>Signals categorized: <span style={{ color: "#818cf8" }}>trend</span>, <span style={{ color: "#22c55e" }}>mean-reversion</span>, <span style={{ color: "#f59e0b" }}>momentum</span>, <span style={{ color: "#fb923c" }}>pattern</span>, <span style={{ color: "#e879f9" }}>combo</span></div>
                    <div style={{ marginBottom: 4 }}>Market regime (ADX) adjusts weights: trending boosts trend signals, ranging boosts mean-reversion</div>
                    <div style={{ marginBottom: 4 }}>Buy when total score &gt;= threshold, sell when sell score &gt;= threshold</div>
                    <div>Risk signals (TP/SL/Trailing) execute immediately regardless of score</div>
                  </div>

                  <div style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#e2e8f0", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Profiles</div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                    {[
                      { name: "Conservative", color: "#3b82f6", icon: "\u{1F6E1}\u{FE0F}", desc: "Few trades, tight risk" },
                      { name: "Moderate", color: "#22c55e", icon: "\u2696\u{FE0F}", desc: "Balanced, trend-following" },
                      { name: "Aggressive", color: "#f59e0b", icon: "\u{1F525}", desc: "Wide stops, big moves" },
                      { name: "YOLO", color: "#ef4444", icon: "\u{1F680}", desc: "Max trend capture" },
                    ].map(function(p) {
                      return (
                        <div key={p.name} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 6, padding: "8px 10px", border: "1px solid " + p.color + "22" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: p.color, fontFamily: "var(--h)" }}>{p.icon} {p.name}</div>
                          <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>{p.desc}</div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#e2e8f0", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Risk Controls</div>
                  <div style={{ padding: "0 0 0 12px", borderLeft: "2px solid rgba(239,68,68,0.2)" }}>
                    <div style={{ marginBottom: 4 }}>Circuit breaker: stops trading at 10-30% drawdown (profile-dependent)</div>
                    <div style={{ marginBottom: 4 }}>Daily trade limits and 5% daily loss cap</div>
                    <div style={{ marginBottom: 4 }}>Black swan filter: blocks buys during 3%+ crashes</div>
                    <div>Multi-timeframe gate: 15min trend filters 1min signals</div>
                  </div>
                </div>
              </div>

              {/* Module 2: KRAL Trend */}
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(139,92,246,0.3)", padding: isMobile ? 14 : 20, marginBottom: 16, position: "relative" }}>
                <div style={{ position: "absolute", top: 10, right: 12, fontSize: 8, fontWeight: 700, color: "#8b5cf6", background: "rgba(139,92,246,0.15)", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--h)", letterSpacing: "0.05em" }}>NEW</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 18 }}>&#x1F4C8;</span>
                  <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 16, color: "#8b5cf6" }}>Module 2: KRAL Trend</span>
                </div>

                <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "var(--m)", lineHeight: 1.7 }}>
                  <div style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#e2e8f0", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>How it works</div>
                  <div style={{ padding: "0 0 0 12px", borderLeft: "2px solid rgba(139,92,246,0.3)", marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>Watches <span style={{ color: "#8b5cf6", fontWeight: 600 }}>EMA21</span> and <span style={{ color: "#8b5cf6", fontWeight: 600 }}>EMA50</span> for each asset</div>
                    <div style={{ marginBottom: 4 }}>When EMA21 crosses <span style={{ color: "#22c55e", fontWeight: 600 }}>ABOVE</span> EMA50 &rarr; BUY (uptrend confirmed)</div>
                    <div style={{ marginBottom: 4 }}>When EMA21 crosses <span style={{ color: "#ef4444", fontWeight: 600 }}>BELOW</span> EMA50 &rarr; SELL (downtrend over)</div>
                    <div style={{ marginBottom: 4 }}>No other indicators. Pure trend following.</div>
                    <div>Max 8 simultaneous positions, 15% capital per position</div>
                  </div>

                  <div style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#e2e8f0", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Why it works</div>
                  <div style={{ padding: "0 0 0 12px", borderLeft: "2px solid rgba(34,197,94,0.2)", marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>Catches big trends (crypto rallies of 100%+)</div>
                    <div style={{ marginBottom: 4 }}>Exits before major crashes</div>
                    <div style={{ marginBottom: 4 }}>Very few trades = minimal commission drag</div>
                    <div>Backtest: +504% average across 41 assets (50% capital deployment)</div>
                  </div>

                  <div style={{ fontFamily: "var(--h)", fontWeight: 600, fontSize: 11, color: "#e2e8f0", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>When it fails</div>
                  <div style={{ padding: "0 0 0 12px", borderLeft: "2px solid rgba(239,68,68,0.2)" }}>
                    <div style={{ marginBottom: 4 }}>Choppy/sideways markets &rarr; frequent false crossovers</div>
                    <div>Assets with low volatility &rarr; small gains eaten by commission</div>
                  </div>
                </div>
              </div>

              {/* Commission note */}
              <div style={{ background: "rgba(245,158,11,0.05)", borderRadius: 8, border: "1px solid rgba(245,158,11,0.15)", padding: "12px 16px", fontSize: 11, color: "#d4a574", fontFamily: "var(--m)", lineHeight: 1.6 }}>
                <span style={{ fontWeight: 700 }}>Commission:</span> Both modules charge 0.1% per trade (buy and sell). This matches typical crypto exchange fees. Slippage is modeled at 0.05% for scoring profiles but not applied to DMA (which trades on daily candle closes).
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {tab === "settings" && (
            <div style={{ padding: 20 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 4 }}>Strategy Settings</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 16 }}>Scoring system: signals vote buy (+weight) or sell (-weight). Trade executes when score meets threshold. Risk signals (TP/SL/Trailing) always execute immediately.</div>

              {/* Signal scores live view */}
              {state.scores && (
                <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 8 }}>LIVE SIGNAL SCORES</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
                    {pfStats.map(pf => (
                      <div key={pf.id} style={{ background: "#0a0e17", borderRadius: 6, padding: 10 }}>
                        <div style={{ color: pf.color, fontWeight: 700, fontSize: 12, fontFamily: "var(--h)", marginBottom: 6 }}>{pf.icon} {pf.name}</div>
                        {state.scores[pf.id] && Object.entries(state.scores[pf.id]).map(([sym, sc]) => (
                          <div key={sym} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, fontFamily: "var(--m)", marginBottom: 3 }}>
                            <span style={{ color: symColor(sym), fontWeight: 600, minWidth: 35 }}>{sym}</span>
                            <span style={{ color: "#22c55e" }}>B:{sc.buy}</span>
                            <span style={{ color: "#ef4444" }}>S:{sc.sell}</span>
                            <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: sc.regime === 'trending' ? "rgba(245,158,11,0.15)" : sc.regime === 'ranging' ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.05)", color: sc.regime === 'trending' ? "#f59e0b" : sc.regime === 'ranging' ? "#a5b4fc" : "#6b7280" }}>{sc.regime}</span>
                            <span style={{ fontSize: 8, color: "#4b5563" }}>vol:{sc.volatility}%</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Profile configs */}
              {(state.profiles || []).map(prof => {
                const pf = pfStats.find(p => p.id === prof.id);
                const isEditing = editProfile === prof.id;
                return (
                  <div key={prof.id} style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>{pf?.icon}</span>
                        <span style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 14, color: pf?.color }}>{pf?.name}</span>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => setEditProfile(isEditing ? null : prof.id)} style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid #1e293b", background: isEditing ? "rgba(245,158,11,0.15)" : "transparent", color: isEditing ? "#f59e0b" : "#6b7280", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>{isEditing ? "CLOSE" : "EDIT"}</button>
                        <button onClick={() => { if (confirm('Reset ' + (pf?.name || prof.id) + '?')) resetPf(prof.id); }} style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid #ef4444", background: "transparent", color: "#ef4444", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>RESET</button>
                      </div>
                    </div>

                    {/* Summary */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(34,197,94,0.1)", color: "#22c55e", fontFamily: "var(--m)" }}>Buy Threshold: {prof.buyThreshold}</span>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(239,68,68,0.1)", color: "#ef4444", fontFamily: "var(--m)" }}>Sell Threshold: {prof.sellThreshold}</span>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(99,102,241,0.1)", color: "#a5b4fc", fontFamily: "var(--m)" }}>Position: {(prof.cashPct * 100).toFixed(0)}%</span>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(255,255,255,0.05)", color: "#6b7280", fontFamily: "var(--m)" }}>Assets: {prof.assets.length}/{allSymbols.length}</span>
                    </div>

                    {/* Editable params */}
                    {isEditing && (
                      <div style={{ marginTop: 8 }}>
                        {/* Asset toggles */}
                        <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 6 }}>TRADEABLE ASSETS ({prof.assets.length}/{allSymbols.length})</div>
                        <div style={{ display: "flex", gap: 2, flexWrap: "wrap", marginBottom: 10 }}>
                          <button onClick={() => sendWs({ type: 'updateConfig', id: prof.id, assets: allSymbols })} style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1e293b", background: "rgba(34,197,94,0.1)", color: "#22c55e", fontSize: 8, cursor: "pointer", fontFamily: "var(--m)", fontWeight: 600 }}>ALL</button>
                          <button onClick={() => sendWs({ type: 'updateConfig', id: prof.id, assets: [] })} style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1e293b", background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 8, cursor: "pointer", fontFamily: "var(--m)", fontWeight: 600 }}>NONE</button>
                          <button onClick={() => sendWs({ type: 'updateConfig', id: prof.id, assets: allSymbols.filter(s => (state.prices[s]||{}).type === 'crypto') })} style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1e293b", background: "rgba(245,158,11,0.1)", color: "#f59e0b", fontSize: 8, cursor: "pointer", fontFamily: "var(--m)", fontWeight: 600 }}>CRYPTO</button>
                          <button onClick={() => sendWs({ type: 'updateConfig', id: prof.id, assets: allSymbols.filter(s => (state.prices[s]||{}).type === 'stock') })} style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1e293b", background: "rgba(99,102,241,0.1)", color: "#a5b4fc", fontSize: 8, cursor: "pointer", fontFamily: "var(--m)", fontWeight: 600 }}>STOCKS</button>
                        </div>
                        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 12 }}>
                          {allSymbols.map(sym => {
                            const active = prof.assets.includes(sym);
                            const type = (state.prices[sym]||{}).type;
                            const tc = type === 'crypto' ? '#f59e0b' : type === 'stock' ? '#a5b4fc' : '#22c55e';
                            return (
                              <button key={sym} onClick={() => {
                                const newAssets = active ? prof.assets.filter(a => a !== sym) : [...prof.assets, sym];
                                sendWs({ type: 'updateConfig', id: prof.id, assets: newAssets });
                              }} style={{ padding: "3px 7px", borderRadius: 4, border: active ? `1px solid ${tc}` : "1px solid #1e293b", background: active ? `${tc}15` : "transparent", color: active ? tc : "#4b5563", fontSize: 9, cursor: "pointer", fontFamily: "var(--m)", fontWeight: active ? 600 : 400, opacity: active ? 1 : 0.5 }}>{sym}</button>
                            );
                          })}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
                          {[["buyThreshold", "Buy Threshold", prof.buyThreshold], ["sellThreshold", "Sell Threshold", prof.sellThreshold], ["cashPct", "Position %", prof.cashPct]].map(([key, label, val]) => (
                            <div key={key} style={{ background: "#0a0e17", borderRadius: 4, padding: 6 }}>
                              <div style={{ fontSize: 8, color: "#6b7280", marginBottom: 3 }}>{label}</div>
                              <input type="number" step={key === "cashPct" ? "0.05" : "0.5"} defaultValue={val} style={{ width: "100%", padding: "3px 6px", borderRadius: 3, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 11, fontFamily: "var(--m)", outline: "none" }}
                                onBlur={(e) => {
                                  const v = parseFloat(e.target.value);
                                  if (!isNaN(v)) { const msg = { type: 'updateConfig', id: prof.id, overrides: {} }; msg[key] = v; sendWs(msg); }
                                }} />
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 6 }}>SIGNAL THRESHOLDS</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 4 }}>
                          {Object.entries(prof.overrides || {}).map(([key, val]) => {
                            const sig = (state.signals || []).find(s => s.id === key);
                            return (
                              <div key={key} style={{ display: "flex", alignItems: "center", gap: 4, background: "#0a0e17", borderRadius: 4, padding: "4px 6px" }}>
                                <span style={{ fontSize: 8, color: sig?.side === "buy" ? "#22c55e" : "#ef4444", flex: 1, fontFamily: "var(--m)" }}>{sig?.label || key}</span>
                                <input type="number" step="0.1" defaultValue={val} style={{ width: 50, padding: "2px 4px", borderRadius: 3, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 10, fontFamily: "var(--m)", outline: "none", textAlign: "right" }}
                                  onBlur={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v)) { const overrides = {}; overrides[key] = v; sendWs({ type: 'updateConfig', id: prof.id, overrides: overrides }); }
                                  }} />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {/* RELEASES */}
          {tab === "releases" && (
            <div style={{ padding: isMobile ? "16px 12px" : "20px 24px", maxWidth: 700 }}>
              <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 16 }}>Release Notes</div>
              {[
                { v: "1.21.0", date: "2026-06-02", changes: [
                  "KRAL Trend now warm-starts from its own 1-year DMA backtest instead of starting from the first live tick",
                  "Portfolio histories are normalized by day on load, save, export, and API responses",
                  "Legacy dense KRAL history points no longer compress the yearly chart range",
                ]},
                { v: "1.20.0", date: "2026-06-02", changes: [
                  "Portfolio race chart now buckets histories by day and uses the latest value per portfolio per day",
                  "Dense DMA/live history points no longer stretch the right side of the yearly comparison chart",
                ]},
                { v: "1.19.0", date: "2026-06-02", changes: [
                  "Portfolio race chart now aligns history by timestamp instead of array index",
                  "Shorter portfolio histories are no longer padded with the last value, removing fake flat lines on the right edge",
                  "The From date filter now reads server history timestamps correctly",
                ]},
                { v: "1.18.0", date: "2026-06-02", changes: [
                  "Polygon live pricing now follows the POL market/source ids while preserving the internal MATIC key for historical compatibility",
                  "Data quality now separates real missing live feeds from missing Twelve Data configuration",
                  "Live feed rows expose source symbols so Binance/CoinGecko/Twelve Data mappings are easier to audit",
                  "Twelve Data startup batches now show pending/rate-limit states and warm up remaining stock batches safely",
                ]},
                { v: "1.17.0", date: "2026-06-02", changes: [
                  "Risk sizing now uses current portfolio equity instead of fixed starting cash",
                  "Position deployment scales up in aligned trends and scales down in ranging/downtrend regimes",
                  "Added a trend-follow continuation signal so strong trends can still score after the original crossover",
                  "Backtest diagnostics now report exposure, cash utilization, per-symbol P&L, exit P&L, and missed trends",
                  "Backtest JSON exports include diagnostics for deeper strategy review",
                ]},
                { v: "1.16.0", date: "2026-06-02", changes: [
                  "Backtest audit panel now explains selected buy/sell decisions from the saved decision snapshot",
                  "Data manifest rows now show source range, freshness, and status in the backtest UI",
                  "Data quality endpoint and test added for live source freshness plus historical candle anomalies",
                  "Portfolio simulation chart now replays results progressively instead of drawing the full curve at once",
                ]},
                { v: "1.15.0", date: "2026-06-02", changes: [
                  "client.html reduced to shell and script loader",
                  "Shared helpers, BacktestTab, App, and bootstrap moved into client/*.jsx modules",
                  "Frontend module loading now uses scoped /client/*.jsx server route",
                ]},
                { v: "1.14.0", date: "2026-06-02", changes: [
                  "Trade and backtest records now include compact decision snapshots",
                  "Backtest metadata now includes a per-symbol data manifest with source ranges",
                  "CSV/JSON exports include decision metadata for easier audit and debugging",
                ]},
                { v: "1.13.0", date: "2026-06-02", changes: [
                  "Backtest quality panel moved into a separate frontend module",
                  "Server now serves scoped /client/*.jsx frontend module files",
                  "Main client.html is smaller and ready for incremental component extraction",
                ]},
                { v: "1.12.0", date: "2026-06-02", changes: [
                  "Backtest results now include a stable parameter hash for reproducibility",
                  "Added in-sample/out-of-sample split metrics and 4-window walk-forward summaries",
                  "Backtest UI and JSON/CSV exports now expose quality metadata",
                ]},
                { v: "1.11.0", date: "2026-06-02", changes: [
                  "Exit logic expanded with profit-lock, signal-reversal, and time-based risk exits",
                  "Risk exits now bypass symbol cooldown while normal score buys/sells still respect cooldown",
                  "Live trading, portfolio seeding, API backtests, and CLI backtests now pass position age into the shared decision engine",
                ]},
                { v: "1.10.0", date: "2026-06-02", changes: [
                  "ATR-based risk plan added for volatility-aware position sizing",
                  "Live trading, portfolio seeding, API backtests, and CLI backtests now share buildRiskPlan",
                  "Buy records now include ATR, risk %, stop %, target %, and bracket TP/SL metadata",
                ]},
                { v: "1.9.0", date: "2026-06-02", changes: [
                  "Trade decision engine centralized in engine-core.evaluateTradeDecision",
                  "Live trading, API backtests, seed helpers, and CLI backtests now share the same buy/sell/risk-sell decision path",
                  "Decision metadata now preserves scores, reasons, regime, exposure, trend, and block reasons in one object",
                ]},
                { v: "1.8.0", date: "2026-06-02", changes: [
                  "Backtests now run in a short-lived worker process to keep live ticks and WebSocket updates responsive",
                  "Admin token controls added for protected actions and backtest requests",
                  "Health endpoint now separates system health from portfolio risk state",
                  "Project docs, env template, and startup scripts updated to match the current server architecture",
                ]},
                { v: "1.7.0", date: "2026-03-25", changes: [
                  "All prices now real: Twelve Data API for 20 stocks + Gold (XAU/USD)",
                  "Smart API usage: market hours vs off-hours batching (~500/800 daily credits)",
                  "Removed unavailable commodities (Silver, Platinum, Copper, Oil, NatGas)",
                  "API key secured in .env file, never pushed to GitHub",
                ]},
                { v: "1.6.0", date: "2026-03-25", changes: [
                  "Fixed regime 'unknown' → always resolves to trending/ranging/mixed",
                  "Fixed candlestick chart time labels (no more Invalid Date)",
                  "Improved candlestick rendering with proper axes",
                  "Trade reasons moved to left side for visibility",
                  "Conservative buyThreshold 4→3, sell threshold lowered for all profiles",
                  "Exposure limit: Conservative 80%, Aggressive 90%, YOLO 95%",
                  "Cooldowns adjusted: Conservative 3min, Moderate 2min, Aggressive/YOLO 1min",
                  "Conservative TP recalibrated to 1.6% (1.6:1 R:R after commission)",
                ]},
                { v: "1.5.0", date: "2026-03-24", changes: [
                  "Gold (XAU/USD) via Twelve Data",
                  "Mobile responsive UI - sidebar, charts, trade log",
                  "Enriched trade logs: P&L, indicators, exposure, cash flow per trade",
                  "CSV/JSON export with all fields",
                ]},
                { v: "1.4.0", date: "2026-03-24", changes: [
                  "Buy/sell imbalance fix - lowered sell thresholds",
                  "Portfolio exposure limit per profile (50-90%)",
                  "EMA50 Bounce confirmation candle requirement",
                  "Ranging vs downtrend detection (EMA21 gate)",
                ]},
                { v: "1.3.0", date: "2026-03-23", changes: [
                  "Scoring/voting system - signals vote, not independent trades",
                  "Market regime detection (trending/ranging/mixed)",
                  "Category cap (max 3.0 per category) prevents signal inflation",
                  "Multi-timeframe filter (15min trend gates 1min signals)",
                  "Black swan filter (3%+ crash blocks buys + 3 candle cooldown)",
                  "Circuit breaker (20% drawdown stops trading)",
                  "Daily trade/loss limits per profile",
                ]},
                { v: "1.2.0", date: "2026-03-23", changes: [
                  "Dynamic position sizing (% of cash, not fixed qty)",
                  "Trade reasons visible in log with purple highlight",
                  "Dollar amount per trade shown",
                ]},
                { v: "1.1.0", date: "2026-03-23", changes: [
                  "Node.js server with WebSocket real-time updates",
                  "Binance WebSocket for live crypto prices",
                  "4 risk profiles: Conservative, Moderate, Aggressive, YOLO",
                  "Candlestick + line chart with Bollinger Bands, EMA overlays",
                  "State persistence (survives restart)",
                  "Cloudflare Tunnel (tradesimbot.com)",
                ]},
                { v: "1.0.0", date: "2026-03-22", changes: [
                  "Initial release - client-side trading simulator",
                  "31 technical analysis signals",
                  "BTC + ETH with simulated prices",
                ]},
              ].map(r => (
                <div key={r.v} style={{ marginBottom: 16, background: "#0f172a", borderRadius: 8, padding: isMobile ? 12 : 16, border: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontFamily: "var(--m)", fontWeight: 700, fontSize: 14, color: "#f59e0b" }}>v{r.v}</span>
                    <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "var(--m)" }}>{r.date}</span>
                  </div>
                  {r.changes.map((c, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#94a3b8", fontFamily: "var(--m)", padding: "2px 0 2px 12px", borderLeft: "2px solid rgba(245,158,11,0.2)" }}>{c}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
