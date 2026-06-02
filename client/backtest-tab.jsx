function BacktestTab({ isMobile }) {
  const [btAssets, setBtAssets] = useState([]);
  const [btProfile, setBtProfile] = useState("moderate");
  const [btSymbols, setBtSymbols] = useState([]);
  const [btStartDate, setBtStartDate] = useState("2022-01-01");
  const [btTimeframe, setBtTimeframe] = useState("1d");
  const [btLoading, setBtLoading] = useState(false);
  const [btResult, setBtResult] = useState(null);
  const [btError, setBtError] = useState(null);
  const [btTradeFilter, setBtTradeFilter] = useState("all");
  const [btChartSym, setBtChartSym] = useState("");
  const [btAuditTrade, setBtAuditTrade] = useState(null);
  const [btProgress, setBtProgress] = useState(0);
  // Expose setter globally so WebSocket handler in App can update progress
  useEffect(function() { window._setBtProgress = setBtProgress; return function() { window._setBtProgress = null; }; }, []);

  // Load available assets on mount
  useEffect(function() {
    fetch('/api/backtest/assets')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        setBtAssets(data || []);
        // Default select all
        setBtSymbols((data || []).map(function(a) { return a.symbol; }));
      })
      .catch(function() {});
  }, []);

  useEffect(function() {
    if (!btResult) {
      setBtAuditTrade(null);
      return;
    }
    var firstAuditTrade = (btResult.trades || []).find(function(t) { return t.decision; }) || (btResult.trades || [])[0] || null;
    setBtAuditTrade(firstAuditTrade);
  }, [btResult]);

  function toggleSymbol(sym) {
    setBtSymbols(function(prev) {
      if (prev.indexOf(sym) >= 0) return prev.filter(function(s) { return s !== sym; });
      return prev.concat([sym]);
    });
  }

  function selectAll() { setBtSymbols(btAssets.map(function(a) { return a.symbol; })); }
  function selectNone() { setBtSymbols([]); }

  function runBacktest() {
    if (btSymbols.length === 0) { setBtError("Select at least one asset"); return; }
    setBtLoading(true);
    setBtError(null);
    setBtResult(null);
    setBtProgress(0);
    // All timeframes use standard JSON response. Progress sent via WebSocket.
    adminFetch('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: btProfile, symbols: btSymbols, startDate: btStartDate, timeframe: btTimeframe }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      setBtLoading(false);
      if (data.error) { setBtError(data.error); return; }
      setBtResult(data);
    })
    .catch(function(e) { setBtLoading(false); setBtError(e.message || 'Backtest failed'); });
  }

  var m = btResult && btResult.metrics;
  var q = btResult && btResult.quality;
  var meta = btResult && btResult.metadata;
  var filteredTrades = btResult ? (btResult.trades || []) : [];
  if (btTradeFilter === "buy") filteredTrades = filteredTrades.filter(function(t) { return t.side === 'buy'; });
  else if (btTradeFilter === "sell") filteredTrades = filteredTrades.filter(function(t) { return t.side === 'sell'; });
  else if (btTradeFilter === "wins") filteredTrades = filteredTrades.filter(function(t) { return t.pnl > 0; });
  else if (btTradeFilter === "losses") filteredTrades = filteredTrades.filter(function(t) { return t.pnl < 0; });

  // Downsample equity curve for chart (max 500 points)
  var eqData = btResult ? (btResult.equityCurve || []) : [];
  if (eqData.length > 500) {
    var step = Math.ceil(eqData.length / 500);
    var sampled = [];
    for (var si = 0; si < eqData.length; si += step) sampled.push(eqData[si]);
    if (sampled[sampled.length - 1] !== eqData[eqData.length - 1]) sampled.push(eqData[eqData.length - 1]);
    eqData = sampled;
  }

  var profileColors = { conservative: "#3b82f6", moderate: "#22c55e", aggressive: "#f59e0b", yolo: "#ef4444", dma: "#8b5cf6" };
  var profileNames = { conservative: "Conservative", moderate: "Moderate", aggressive: "Aggressive", yolo: "YOLO", dma: "KRAL Trend" };

  return (
    <div style={{ padding: isMobile ? "12px 8px" : "20px 24px" }}>
      <div style={{ fontFamily: "var(--h)", fontWeight: 700, fontSize: 20, color: "#f8fafc", marginBottom: 4 }}>Backtest Engine</div>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 16 }}>Test strategies against historical data (daily or 1-minute) using the same signals and scoring system as live trading.</div>

      {/* Configuration Panel */}
      <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 10 }}>CONFIGURATION</div>

        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr auto 1fr 1fr", gap: 12, marginBottom: 12 }}>
          {/* Profile selector */}
          <div>
            <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 4, fontFamily: "var(--h)", fontWeight: 600 }}>PROFILE</div>
            <select value={btProfile} onChange={function(e) { setBtProfile(e.target.value); }} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 12, fontFamily: "var(--m)", outline: "none", cursor: "pointer" }}>
              <option value="conservative">Conservative</option>
              <option value="moderate">Moderate</option>
              <option value="aggressive">Aggressive</option>
              <option value="yolo">YOLO</option>
              <option value="dma">KRAL Trend (EMA200 Band)</option>
            </select>
          </div>
          {/* Timeframe selector */}
          <div>
            <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 4, fontFamily: "var(--h)", fontWeight: 600 }}>TIMEFRAME</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {["1d", "1m", "5m", "15m", "1h", "4h"].map(function(tf) {
                var active = btTimeframe === tf;
                var tfColor = tf === "1d" ? "#22c55e" : "#f59e0b";
                return (
                  <button key={tf} onClick={function() { setBtTimeframe(tf); }} className="bt" style={{ padding: "8px 10px", borderRadius: 6, border: active ? "1px solid " + tfColor : "1px solid #1e293b", background: active ? (tf === "1d" ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)") : "#0a0e17", color: active ? tfColor : "#6b7280", fontSize: 12, fontWeight: 700, fontFamily: "var(--m)", cursor: "pointer", minWidth: 36, textAlign: "center" }}>{tf.toUpperCase()}</button>
                );
              })}
            </div>
          </div>
          {/* Start date */}
          <div>
            <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 4, fontFamily: "var(--h)", fontWeight: 600 }}>START DATE</div>
            <input type="date" value={btStartDate} onChange={function(e) { setBtStartDate(e.target.value); }} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #1e293b", background: "#0a0e17", color: "#f8fafc", fontSize: 12, fontFamily: "var(--m)", outline: "none" }} />
          </div>
          {/* Run button */}
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button onClick={runBacktest} disabled={btLoading} className="bt" style={{ width: "100%", padding: "8px 16px", borderRadius: 6, border: "none", background: btLoading ? "#374151" : (profileColors[btProfile] || "#22c55e"), color: btLoading ? "#9ca3af" : "#0a0e17", fontSize: 13, fontWeight: 700, fontFamily: "var(--h)", cursor: btLoading ? "not-allowed" : "pointer" }}>
              {btLoading ? "Running..." : "Run Backtest"}
            </button>
          </div>
        </div>
        {btTimeframe !== "1d" && (
          <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 6, padding: "6px 12px", marginBottom: 12, fontSize: 11, color: "#f59e0b", fontFamily: "var(--m)" }}>{btTimeframe.toUpperCase()} uses 1-minute candle data{btTimeframe !== "1m" ? " (grouped from 1m)" : ""} and may take longer to process</div>
        )}

        {/* Asset selection */}
        <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 4, fontFamily: "var(--h)", fontWeight: 600 }}>ASSETS ({btSymbols.length}/{btAssets.length} selected)</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
          <button onClick={selectAll} className="bt" style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #1e293b", background: "rgba(34,197,94,0.1)", color: "#22c55e", fontSize: 9, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>ALL</button>
          <button onClick={selectNone} className="bt" style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #1e293b", background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 9, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>NONE</button>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {btAssets.map(function(a) {
            var active = btSymbols.indexOf(a.symbol) >= 0;
            var col = symColor(a.symbol);
            return (
              <button key={a.symbol} onClick={function() { toggleSymbol(a.symbol); }} className="bt" style={{ padding: "4px 8px", borderRadius: 4, border: active ? "1px solid " + col : "1px solid #1e293b", background: active ? col + "15" : "transparent", color: active ? col : "#4b5563", fontSize: 10, cursor: "pointer", fontFamily: "var(--m)", fontWeight: active ? 600 : 400, opacity: active ? 1 : 0.5 }}>
                {a.symbol}
                <span style={{ fontSize: 7, color: "#4b5563", marginLeft: 3 }}>{a.rows}d</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Loading spinner + progress bar */}
      {btLoading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ display: "inline-block", width: 32, height: 32, border: "3px solid #1e293b", borderTop: "3px solid " + (profileColors[btProfile] || "#f59e0b"), borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ color: "#6b7280", fontSize: 12, marginTop: 8, fontFamily: "var(--m)" }}>Running backtest on {btSymbols.length} assets...</div>
          {btTimeframe !== "1d" && btProgress > 0 && (
            <div style={{ marginTop: 16, maxWidth: 320, marginLeft: "auto", marginRight: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#8b5cf6", fontFamily: "var(--m)", marginBottom: 4 }}>
                <span>Processing {btTimeframe.toUpperCase()} candles...</span>
                <span>{btProgress}%</span>
              </div>
              <div style={{ height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: btProgress + "%", background: "linear-gradient(90deg, #8b5cf6, #a78bfa)", borderRadius: 3, transition: "width 0.3s" }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {btError && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#ef4444", fontSize: 12, fontFamily: "var(--m)", marginBottom: 16 }}>{btError}</div>
      )}

      {/* No results yet */}
      {!btResult && !btLoading && !btError && (
        <div style={{ textAlign: "center", padding: 60, color: "#374151" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>&#x1f4ca;</div>
          <div style={{ fontSize: 14, fontFamily: "var(--h)", fontWeight: 600 }}>Select assets and click Run Backtest</div>
          <div style={{ fontSize: 11, color: "#4b5563", marginTop: 4 }}>Historical data available for {btAssets.length} assets (daily + 1m)</div>
        </div>
      )}

      {/* Results */}
      {btResult && m && (
        <div>
          {/* Metrics Cards */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { label: "TOTAL RETURN", value: (m.totalReturn >= 0 ? "+" : "") + m.totalReturn + "%", color: m.totalReturn >= 0 ? "#22c55e" : "#ef4444" },
              { label: "WIN RATE", value: m.winRate + "%", color: m.winRate >= 50 ? "#22c55e" : "#ef4444" },
              { label: "MAX DRAWDOWN", value: "-" + m.maxDrawdown + "%", color: m.maxDrawdown > 30 ? "#ef4444" : m.maxDrawdown > 15 ? "#f59e0b" : "#22c55e" },
              { label: "SHARPE RATIO", value: m.sharpe.toFixed(2), color: m.sharpe > 1 ? "#22c55e" : m.sharpe > 0 ? "#f59e0b" : "#ef4444" },
              { label: "TOTAL TRADES", value: m.totalTrades + " (" + m.wins + "W / " + m.losses + "L)", color: "#a5b4fc" },
              { label: "BUY & HOLD", value: (m.buyHoldReturn >= 0 ? "+" : "") + m.buyHoldReturn + "%", color: m.totalReturn > m.buyHoldReturn ? "#22c55e" : "#ef4444" },
            ].map(function(card, i) {
              return (
                <div key={i} style={{ background: "#0f172a", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 4 }}>{card.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--m)", color: card.color }}>{card.value}</div>
                </div>
              );
            })}
          </div>

          {/* Summary bar */}
          <div style={{ background: "#0f172a", borderRadius: 8, padding: "10px 14px", border: "1px solid rgba(255,255,255,0.04)", marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, fontFamily: "var(--m)" }}>
            <span style={{ color: "#6b7280" }}>Profile: <span style={{ color: profileColors[btResult.profile] || "#f8fafc", fontWeight: 600 }}>{profileNames[btResult.profile] || btResult.profile}</span></span>
            <span style={{ color: "#6b7280" }}>Timeframe: <span style={{ color: btResult.timeframe !== "1d" ? "#f59e0b" : "#f8fafc", fontWeight: 600 }}>{({"1d":"Daily","1m":"1 Minute","5m":"5 Minute","15m":"15 Minute","1h":"1 Hour","4h":"4 Hour"})[btResult.timeframe] || btResult.timeframe}</span></span>
            <span style={{ color: "#6b7280" }}>Period: <span style={{ color: "#f8fafc" }}>{btResult.startDate} to {eqData.length > 0 ? eqData[eqData.length - 1].date : "?"}</span></span>
            <span style={{ color: "#6b7280" }}>{btResult.timeframe !== "1d" ? "Candles" : "Days"}: <span style={{ color: "#f8fafc" }}>{m.days}</span></span>
            {m.processedCandles ? <span style={{ color: "#6b7280" }}>1m Candles: <span style={{ color: "#f8fafc" }}>{m.processedCandles.toLocaleString()}</span></span> : null}
            <span style={{ color: "#6b7280" }}>Assets: <span style={{ color: "#f8fafc" }}>{(btResult.symbols || []).length}</span></span>
            <span style={{ color: "#6b7280" }}>Commission: <span style={{ color: "#f59e0b" }}>${fK(m.totalCommission)}</span></span>
            <span style={{ color: "#6b7280" }}>Final: <span style={{ color: m.finalEquity >= m.startCash ? "#22c55e" : "#ef4444", fontWeight: 700 }}>${fK(m.finalEquity)}</span></span>
            {meta && meta.parameterHash ? <span style={{ color: "#6b7280" }}>Param: <span style={{ color: "#818cf8", fontWeight: 700 }}>{meta.parameterHash}</span></span> : null}
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button onClick={() => {
                var csv = "date,side,symbol,price,signalPrice,qty,total,pnl,pnlPct,reason,regime,commission,bracketTP,bracketSL,decisionAction,decisionType,decisionReason\n";
                (btResult.trades || []).forEach(t => {
                  var d = t.decision || {};
                  csv += [t.date,t.side,t.symbol,t.price,t.signalPrice||"",t.qty,t.total,t.pnl||0,t.pnlPct||0,'"'+(t.reason||"").replace(/"/g,'""')+'"',t.regime||"",t.commission||0,t.bracketTP||"",t.bracketSL||"",d.action||"",d.type||"","\""+(d.reason||"").replace(/"/g,'""')+"\""].join(",") + "\n";
                });
                csv += "\n# Metrics\n# Return:"+m.totalReturn+"%,WinRate:"+m.winRate+"%,MaxDD:"+m.maxDrawdown+"%,Sharpe:"+m.sharpe+",Trades:"+m.totalTrades+",Commission:"+m.totalCommission+",BuyHold:"+m.buyHoldReturn+"%\n";
                if (q) csv += "# Quality,InSampleReturn:"+q.inSample.totalReturn+"%,OOSReturn:"+q.outOfSample.totalReturn+"%,OOSSharpe:"+q.outOfSample.sharpe+",ParamHash:"+((meta&&meta.parameterHash)||"")+"\n";
                var blob = new Blob([csv], {type:"text/csv"});
                var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "backtest-"+btResult.profile+"-"+btResult.startDate+".csv"; a.click();
              }} className="bt" style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #1e293b", background: "rgba(34,197,94,0.1)", color: "#22c55e", fontSize: 9, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>Export CSV</button>
              <button onClick={() => {
                var blob = new Blob([JSON.stringify({metrics:btResult.metrics, quality:btResult.quality, metadata:btResult.metadata, trades:btResult.trades, equityCurve:btResult.equityCurve, profile:btResult.profile, symbols:btResult.symbols, startDate:btResult.startDate}, null, 2)], {type:"application/json"});
                var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "backtest-"+btResult.profile+"-"+btResult.startDate+".json"; a.click();
              }} className="bt" style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #1e293b", background: "rgba(99,102,241,0.1)", color: "#818cf8", fontSize: 9, fontWeight: 600, cursor: "pointer", fontFamily: "var(--m)" }}>Export JSON</button>
            </span>
          </div>

          <BacktestQualityPanel quality={q} metadata={meta} isMobile={isMobile} />
          <BacktestAuditPanel result={btResult} selectedTrade={btAuditTrade} onSelectTrade={setBtAuditTrade} isMobile={isMobile} />

          {btResult.skippedSymbols && btResult.skippedSymbols.length > 0 && (
            <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 6, padding: "6px 12px", marginBottom: 12, fontSize: 11, color: "#f59e0b", fontFamily: "var(--m)" }}>Skipped (no 1m data): {btResult.skippedSymbols.join(", ")}</div>
          )}

          {/* Equity Curve Chart */}
          <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 8 }}>EQUITY CURVE</div>
            {eqData.length > 2 ? (
              <ZoomChart dataKey="date" dataLength={eqData.length}>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={eqData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#4b5563" }} interval={Math.floor(eqData.length / 6)} />
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "#4b5563" }} tickFormatter={function(v) { return "$" + fK(v); }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} formatter={function(v) { return ["$" + fK(v), "Equity"]; }} />
                  <ReferenceLine y={m.startCash} stroke="#6b7280" strokeDasharray="3 3" label={{ value: "Start $" + fK(m.startCash), fill: "#6b7280", fontSize: 9 }} />
                  <Area type="monotone" dataKey="value" stroke={m.totalReturn >= 0 ? "#22c55e" : "#ef4444"} fill={m.totalReturn >= 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.08} strokeWidth={2} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
              </ZoomChart>
            ) : (
              <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>Not enough data for chart</div>
            )}
          </div>

          {/* Drawdown Chart */}
          {eqData.length > 2 && (function() {
            var ddData = [];
            var peak = 0;
            for (var di = 0; di < eqData.length; di++) {
              var v = eqData[di].value;
              if (v > peak) peak = v;
              var dd = peak > 0 ? -((peak - v) / peak) * 100 : 0;
              ddData.push({ date: eqData[di].date, dd: +dd.toFixed(2) });
            }
            return (
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 8 }}>DRAWDOWN</div>
                <ZoomChart dataKey="date" dataLength={ddData.length}>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={ddData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#4b5563" }} interval={Math.floor(ddData.length / 6)} />
                    <YAxis domain={["auto", 0]} tick={{ fontSize: 9, fill: "#4b5563" }} tickFormatter={function(v) { return v.toFixed(1) + "%"; }} />
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} formatter={function(v) { return [v.toFixed(2) + "%", "Drawdown"]; }} />
                    <Area type="monotone" dataKey="dd" stroke="#ef4444" fill="#ef4444" fillOpacity={0.25} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
                </ZoomChart>
              </div>
            );
          })()}

          {/* Extended Statistics */}
          {btResult && m && (function() {
            var allTrades = btResult.trades || [];
            var sells = allTrades.filter(function(t) { return t.side === 'sell'; });
            var winTrades = sells.filter(function(t) { return t.pnl > 0; });
            var lossTrades = sells.filter(function(t) { return t.pnl < 0; });
            var avgWin = winTrades.length > 0 ? winTrades.reduce(function(s, t) { return s + t.pnl; }, 0) / winTrades.length : 0;
            var avgLoss = lossTrades.length > 0 ? lossTrades.reduce(function(s, t) { return s + Math.abs(t.pnl); }, 0) / lossTrades.length : 0;
            var grossProfit = winTrades.reduce(function(s, t) { return s + t.pnl; }, 0);
            var grossLoss = lossTrades.reduce(function(s, t) { return s + Math.abs(t.pnl); }, 0);
            var profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
            var bestTrade = sells.length > 0 ? Math.max.apply(null, sells.map(function(t) { return t.pnl; })) : 0;
            var worstTrade = sells.length > 0 ? Math.min.apply(null, sells.map(function(t) { return t.pnl; })) : 0;

            // Avg hold time: pair buys to sells by symbol
            var holdTimes = [];
            var openBuys = {}; // { sym: [dates] }
            allTrades.forEach(function(t) {
              if (t.side === 'buy') {
                if (!openBuys[t.symbol]) openBuys[t.symbol] = [];
                openBuys[t.symbol].push(t.date);
              } else if (t.side === 'sell' && openBuys[t.symbol] && openBuys[t.symbol].length > 0) {
                var buyDate = openBuys[t.symbol].shift();
                var days = Math.round((new Date(t.date) - new Date(buyDate)) / 86400000);
                if (days >= 0) holdTimes.push(days);
              }
            });
            var avgHoldTime = holdTimes.length > 0 ? (holdTimes.reduce(function(a, b) { return a + b; }, 0) / holdTimes.length).toFixed(1) : "--";

            // Consecutive wins/losses
            var maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
            sells.forEach(function(t) {
              if (t.pnl > 0) { cw++; cl = 0; if (cw > maxConsecWins) maxConsecWins = cw; }
              else { cl++; cw = 0; if (cl > maxConsecLosses) maxConsecLosses = cl; }
            });

            var wr = sells.length > 0 ? winTrades.length / sells.length : 0;
            var expectancy = (wr * avgWin) - ((1 - wr) * avgLoss);

            var stats = [
              { label: "Avg Win", value: "$" + fK(avgWin), color: "#22c55e" },
              { label: "Avg Loss", value: "-$" + fK(avgLoss), color: "#ef4444" },
              { label: "Profit Factor", value: profitFactor >= 999 ? "INF" : profitFactor.toFixed(2), color: profitFactor >= 1.5 ? "#22c55e" : profitFactor >= 1 ? "#f59e0b" : "#ef4444" },
              { label: "Avg Hold Time", value: avgHoldTime + " days", color: "#a5b4fc" },
              { label: "Best Trade", value: "+$" + fK(bestTrade), color: "#22c55e" },
              { label: "Worst Trade", value: "-$" + fK(Math.abs(worstTrade)), color: "#ef4444" },
              { label: "Max Consec Wins", value: "" + maxConsecWins, color: "#22c55e" },
              { label: "Max Consec Losses", value: "" + maxConsecLosses, color: "#ef4444" },
              { label: "Expectancy", value: (expectancy >= 0 ? "+$" : "-$") + fK(Math.abs(expectancy)), color: expectancy >= 0 ? "#22c55e" : "#ef4444" },
            ];

            return (
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 10 }}>EXTENDED STATISTICS</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(3, 1fr)", gap: 8 }}>
                  {stats.map(function(s, i) {
                    return (
                      <div key={i} style={{ background: "#0a0e17", borderRadius: 6, padding: "8px 12px", border: "1px solid rgba(255,255,255,0.03)" }}>
                        <div style={{ fontSize: 8, color: "#4b5563", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 3 }}>{s.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "var(--m)", color: s.color }}>{s.value}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Monthly Returns Heatmap */}
          {btResult && (function() {
            var eq = btResult.equityCurve || [];
            if (eq.length < 30) return null;
            // Group equity by year-month, compute monthly returns
            var monthlyData = {}; // { "2022": { 0: pct, 1: pct, ... } }
            var prevMonthEnd = eq[0].value;
            var curMonth = eq[0].date.slice(0, 7);
            for (var mi = 1; mi < eq.length; mi++) {
              var m2 = eq[mi].date.slice(0, 7);
              if (m2 !== curMonth) {
                var yr = curMonth.slice(0, 4);
                var mo = parseInt(curMonth.slice(5, 7), 10) - 1;
                if (!monthlyData[yr]) monthlyData[yr] = {};
                var endVal = eq[mi - 1].value;
                monthlyData[yr][mo] = prevMonthEnd > 0 ? ((endVal - prevMonthEnd) / prevMonthEnd) * 100 : 0;
                prevMonthEnd = endVal;
                curMonth = m2;
              }
            }
            // Last month
            var lastYr = curMonth.slice(0, 4);
            var lastMo = parseInt(curMonth.slice(5, 7), 10) - 1;
            if (!monthlyData[lastYr]) monthlyData[lastYr] = {};
            var lastEndVal = eq[eq.length - 1].value;
            monthlyData[lastYr][lastMo] = prevMonthEnd > 0 ? ((lastEndVal - prevMonthEnd) / prevMonthEnd) * 100 : 0;

            var years = Object.keys(monthlyData).sort();
            var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

            function heatColor(val) {
              if (val === undefined || val === null) return "transparent";
              if (val >= 0) {
                var g = Math.min(val / 15, 1);
                return "rgba(34,197,94," + (0.15 + g * 0.6) + ")";
              }
              var r = Math.min(Math.abs(val) / 15, 1);
              return "rgba(239,68,68," + (0.15 + r * 0.6) + ")";
            }

            return (
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, marginBottom: 10 }}>MONTHLY RETURNS</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 9, fontFamily: "var(--m)" }}>
                    <thead>
                      <tr>
                        <th style={{ padding: "4px 6px", color: "#4b5563", fontWeight: 600, textAlign: "left" }}>Year</th>
                        {months.map(function(mo) { return <th key={mo} style={{ padding: "4px 4px", color: "#4b5563", fontWeight: 600, textAlign: "center", minWidth: 36 }}>{mo}</th>; })}
                      </tr>
                    </thead>
                    <tbody>
                      {years.map(function(yr) {
                        return (
                          <tr key={yr}>
                            <td style={{ padding: "3px 6px", color: "#94a3b8", fontWeight: 600 }}>{yr}</td>
                            {[0,1,2,3,4,5,6,7,8,9,10,11].map(function(mo) {
                              var val = monthlyData[yr][mo];
                              var hasVal = val !== undefined && val !== null;
                              return (
                                <td key={mo} style={{ padding: "3px 2px", textAlign: "center", background: heatColor(val), borderRadius: 3, color: hasVal ? (val >= 0 ? "#4ade80" : "#f87171") : "#1e293b", fontWeight: 600 }}>
                                  {hasVal ? (val >= 0 ? "+" : "") + val.toFixed(1) + "%" : ""}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* Historical Price Chart */}
          {btResult && btResult.priceHistory && (function() {
            var availSyms = Object.keys(btResult.priceHistory);
            var activeSym = btChartSym && btResult.priceHistory[btChartSym] ? btChartSym : (availSyms[0] || "");
            var priceData = activeSym ? (btResult.priceHistory[activeSym] || []) : [];
            // Add buy/sell markers to price data
            var symTrades = (btResult.trades || []).filter(function(t) { return t.symbol === activeSym; });
            var tradesByDate = {};
            symTrades.forEach(function(t) { tradesByDate[t.date] = t; });
            var chartData = priceData.map(function(p) {
              var tr = tradesByDate[p.date];
              return {
                date: p.date, close: p.c, high: p.h, low: p.l, open: p.o,
                buy: tr && tr.side === 'buy' ? p.c : null,
                sell: tr && tr.side === 'sell' ? p.c : null,
              };
            });
            return (
              <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600 }}>PRICE CHART — {activeSym}</div>
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                    {availSyms.map(function(s) {
                      var isActive = s === activeSym;
                      return (
                        <button key={s} onClick={function() { setBtChartSym(s); }} className="bt" style={{ padding: "2px 8px", borderRadius: 4, border: isActive ? "1px solid " + symColor(s) : "1px solid #1e293b", background: isActive ? symColor(s) + "20" : "transparent", color: isActive ? symColor(s) : "#4b5563", fontSize: 9, cursor: "pointer", fontFamily: "var(--m)", fontWeight: isActive ? 700 : 400 }}>{s}</button>
                      );
                    })}
                  </div>
                </div>
                {chartData.length > 2 ? (
                  <ZoomChart dataKey="date" dataLength={chartData.length}>
                  <ResponsiveContainer width="100%" height={350}>
                    <ComposedChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#4b5563" }} interval={Math.floor(chartData.length / 6)} />
                      <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "#4b5563" }} tickFormatter={function(v) { return "$" + fK(v); }} />
                      <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11, fontFamily: "var(--m)" }} formatter={function(v, name) { return ["$" + fmt(v), name === "close" ? "Price" : name === "buy" ? "BUY" : "SELL"]; }} />
                      <Area type="monotone" dataKey="close" stroke={symColor(activeSym)} fill={symColor(activeSym)} fillOpacity={0.05} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Scatter dataKey="buy" fill="#22c55e" shape="triangle" isAnimationActive={false} />
                      <Scatter dataKey="sell" fill="#ef4444" shape="diamond" isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                  </ZoomChart>
                ) : (
                  <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" }}>No price data</div>
                )}
                <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 9, color: "#6b7280", fontFamily: "var(--m)" }}>
                  <span><span style={{ color: "#22c55e" }}>▲</span> Buy signals</span>
                  <span><span style={{ color: "#ef4444" }}>◆</span> Sell signals</span>
                  <span>Trades on {activeSym}: {symTrades.length} ({symTrades.filter(function(t){return t.side==='buy';}).length}B / {symTrades.filter(function(t){return t.side==='sell';}).length}S)</span>
                </div>
              </div>
            );
          })()}

          {/* Trade List */}
          <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span>TRADES ({filteredTrades.length})</span>
              <div style={{ display: "flex", gap: 3 }}>
                {[["all", "All"], ["buy", "Buys"], ["sell", "Sells"], ["wins", "Wins"], ["losses", "Losses"]].map(function(f) {
                  var active = btTradeFilter === f[0];
                  return (
                    <button key={f[0]} onClick={function() { setBtTradeFilter(f[0]); }} style={{ padding: "2px 8px", borderRadius: 3, border: active ? "1px solid #f59e0b" : "1px solid #1e293b", background: active ? "rgba(245,158,11,0.15)" : "transparent", color: active ? "#f59e0b" : "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "var(--m)", fontWeight: 600 }}>{f[1]}</button>
                  );
                })}
              </div>
            </div>
            {/* Table header */}
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "65px 35px 40px 55px 55px 50px" : "80px 45px 50px 70px 50px 70px 65px 1fr 60px", padding: "6px 12px", fontSize: 8, color: "#4b5563", fontFamily: "var(--h)", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <span>DATE</span><span>SIDE</span><span>SYM</span><span>PRICE</span><span>QTY</span><span>TOTAL</span>{!isMobile && <><span>P&L</span><span>REASON</span><span>REGIME</span></>}
            </div>
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
              {filteredTrades.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", color: "#374151", fontSize: 11 }}>No trades match filter</div>
              )}
              {filteredTrades.slice(0, 200).map(function(t, i) {
                var pnlColor = t.pnl > 0 ? "#22c55e" : t.pnl < 0 ? "#ef4444" : "#6b7280";
                var isSelectedAudit = btAuditTrade === t;
                return (
                  <div key={i} className="sr" onClick={function() { setBtAuditTrade(t); }} title="Show decision audit" style={{ display: "grid", gridTemplateColumns: isMobile ? "65px 35px 40px 55px 55px 50px" : "80px 45px 50px 70px 50px 70px 65px 1fr 60px", padding: "5px 12px", fontSize: isMobile ? 9 : 10, fontFamily: "var(--m)", borderBottom: "1px solid rgba(255,255,255,0.02)", cursor: "pointer", background: isSelectedAudit ? "rgba(129,140,248,0.12)" : (t.pnl > 0 ? "rgba(34,197,94,0.02)" : t.pnl < 0 ? "rgba(239,68,68,0.02)" : "transparent"), boxShadow: isSelectedAudit ? "inset 2px 0 0 #818cf8" : "none" }}>
                    <span style={{ color: "#6b7280" }}>{t.date}</span>
                    <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: t.side === "buy" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: t.side === "buy" ? "#22c55e" : "#ef4444", fontWeight: 700, textAlign: "center", alignSelf: "center" }}>{t.side === "buy" ? "BUY" : "SELL"}</span>
                    <span style={{ color: symColor(t.symbol), fontWeight: 600 }}>{t.symbol}</span>
                    <span style={{ color: "#e2e8f0" }}>${fmt(t.price)}</span>
                    <span style={{ color: "#94a3b8" }}>{t.qty < 1 ? t.qty.toFixed(4) : t.qty.toFixed(2)}</span>
                    <span style={{ color: "#f8fafc", fontWeight: 600 }}>${fK(t.total)}</span>
                    {!isMobile && <><span style={{ color: pnlColor, fontWeight: 600 }}>{t.pnl !== 0 ? (t.pnl > 0 ? "+" : "") + "$" + fK(t.pnl) : "--"}{t.pnlPct !== 0 ? " (" + (t.pnlPct > 0 ? "+" : "") + t.pnlPct + "%)" : ""}</span>
                    <span style={{ color: "#a78bfa", fontSize: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.reason}{t.side === "buy" && t.bracketTP && t.bracketSL ? " | TP: $" + fK(t.bracketTP) + " SL: $" + fK(t.bracketSL) : ""}</span>
                    <span style={{ fontSize: 8, color: "#4b5563" }}>{t.regime}</span></>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
