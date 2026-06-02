window.DataQualityPanel = function DataQualityPanel({ data, loading, error, onRefresh, isMobile }) {
  function colorFor(status) {
    if (status === "ok") return "#22c55e";
    if (status === "stale" || status === "unconfigured" || status === "missing-key" || status === "attention") return "#f59e0b";
    return "#ef4444";
  }
  function labelFor(status) {
    if (status === "unconfigured" || status === "missing-key") return "CONFIG";
    return (status || "unknown").replace("-", " ").toUpperCase();
  }
  function displaySymbolFor(s) {
    if (!s) return "";
    if (s.displaySymbol && s.displaySymbol !== s.symbol) return s.displaySymbol + " (" + s.symbol + ")";
    return s.symbol;
  }
  function fmtDate(value) {
    if (!value) return "n/a";
    try { return new Date(value).toLocaleString(); } catch (e) { return value; }
  }
  function fmtAgeSec(sec) {
    if (sec === null || sec === undefined) return "n/a";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    if (sec < 86400) return Math.round(sec / 3600) + "h";
    return Math.round(sec / 86400) + "d";
  }

  const summary = (data && data.summary) || {};
  const live = (data && data.live) || {};
  const historical = (data && data.historical) || {};
  const liveSymbols = live.symbols || [];
  const historicalSymbols = historical.symbols || [];
  const liveAttention = liveSymbols.filter(function(s) { return s.status !== "ok"; });
  const liveUnconfigured = liveAttention.filter(function(s) { return s.status === "unconfigured" || s.status === "missing-key"; });
  const liveSourceAttention = liveAttention.filter(function(s) { return s.status !== "unconfigured" && s.status !== "missing-key"; });
  const historicalAttention = historicalSymbols.filter(function(s) { return s.status !== "ok"; });
  const stockGoldRows = liveSymbols.filter(function(s) { return s.type === "stock" || s.type === "commodity"; }).slice(0, isMobile ? 6 : 10);

  return (
    <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.05)", padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 700 }}>DATA QUALITY</div>
          <div style={{ fontSize: 9, color: "#4b5563", fontFamily: "var(--m)", marginTop: 2 }}>
            Stock/Gold source: Twelve Data · Crypto source: Binance + CoinGecko fallback
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {data && <span style={{ fontSize: 9, color: colorFor(summary.status), fontFamily: "var(--m)", fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: colorFor(summary.status) + "18" }}>{labelFor(summary.status)}</span>}
          <button onClick={onRefresh} disabled={loading} className="bt" style={{ padding: "4px 9px", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: loading ? "#4b5563" : "#94a3b8", fontSize: 9, fontFamily: "var(--m)", fontWeight: 700, cursor: loading ? "not-allowed" : "pointer" }}>{loading ? "Checking..." : "Refresh"}</button>
        </div>
      </div>

      {error && <div style={{ padding: "7px 10px", borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#ef4444", fontSize: 10, fontFamily: "var(--m)", marginBottom: 10 }}>{error}</div>}

      {!data && !error && (
        <div style={{ height: 48, display: "flex", alignItems: "center", color: "#4b5563", fontSize: 11, fontFamily: "var(--m)" }}>
          {loading ? "Checking data feeds..." : "No quality snapshot yet"}
        </div>
      )}

      {data && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8, marginBottom: 10 }}>
            {[
              { label: "Live Feed", value: labelFor(summary.liveStatus), color: colorFor(summary.liveStatus) },
              { label: "Live M/S/Config", value: (summary.liveMissing || 0) + " / " + (summary.liveStale || 0) + " / " + (summary.liveUnconfigured || 0), color: summary.liveMissing ? "#ef4444" : ((summary.liveStale || summary.liveUnconfigured) ? "#f59e0b" : "#22c55e") },
              { label: "History Stale", value: "" + (summary.historicalStale || 0), color: summary.historicalStale ? "#f59e0b" : "#22c55e" },
              { label: "History Last", value: summary.lastHistoricalUpdateAt || "n/a", color: "#94a3b8" },
            ].map(function(m) {
              return (
                <div key={m.label} style={{ background: "#0a0e17", borderRadius: 6, padding: "8px 9px", border: "1px solid rgba(255,255,255,0.03)" }}>
                  <div style={{ fontSize: 8, color: "#4b5563", fontFamily: "var(--h)", fontWeight: 700, marginBottom: 3 }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: m.color, fontFamily: "var(--m)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.value}</div>
                </div>
              );
            })}
          </div>

          {(liveAttention.length > 0 || historicalAttention.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ color: "#f59e0b", fontSize: 9, fontFamily: "var(--h)", fontWeight: 700, marginBottom: 5 }}>LIVE ATTENTION</div>
                {liveUnconfigured.length > 0 && (
                  <div style={{ color: "#f59e0b", fontSize: 10, fontFamily: "var(--m)", marginBottom: 6 }}>
                    Twelve Data key missing: {liveUnconfigured.length} stock/GOLD assets are config-only warnings.
                  </div>
                )}
                {liveSourceAttention.length === 0 ? (
                  <div style={{ color: "#22c55e", fontSize: 10, fontFamily: "var(--m)" }}>All live source timestamps are fresh.</div>
                ) : liveSourceAttention.slice(0, 8).map(function(s) {
                  return (
                    <div key={s.symbol} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, fontFamily: "var(--m)", marginBottom: 3 }}>
                      <span style={{ color: symColor(s.symbol), fontWeight: 700, minWidth: 72 }}>{displaySymbolFor(s)}</span>
                      <span style={{ color: colorFor(s.status), fontWeight: 700 }}>{labelFor(s.status)}</span>
                      <span style={{ color: "#6b7280" }}>{fmtAgeSec(s.updateAgeSec)}</span>
                      <span style={{ color: "#4b5563", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sourceSymbol || s.activeSource}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.18)", borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ color: "#818cf8", fontSize: 9, fontFamily: "var(--h)", fontWeight: 700, marginBottom: 5 }}>HISTORICAL ATTENTION</div>
                {historicalAttention.length === 0 ? (
                  <div style={{ color: "#22c55e", fontSize: 10, fontFamily: "var(--m)" }}>No missing, duplicate, invalid, or stale historical candles.</div>
                ) : historicalAttention.slice(0, 8).map(function(s) {
                  return (
                    <div key={s.symbol} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, fontFamily: "var(--m)", marginBottom: 3 }}>
                      <span style={{ color: symColor(s.symbol), fontWeight: 700, minWidth: 42 }}>{s.symbol}</span>
                      <span style={{ color: colorFor(s.status), fontWeight: 700 }}>{labelFor(s.status)}</span>
                      <span style={{ color: "#6b7280" }}>last {s.last || "n/a"}</span>
                      <span style={{ color: "#4b5563" }}>{s.lastAgeDays !== null ? s.lastAgeDays + "d" : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "var(--m)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  {["Asset", "Type", "Source", "Last Live", "Status"].map(function(h) {
                    return <th key={h} style={{ textAlign: "left", padding: "5px 7px", color: "#4b5563", fontSize: 8, fontFamily: "var(--h)", fontWeight: 700 }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {stockGoldRows.map(function(s) {
                  return (
                    <tr key={s.symbol} style={{ borderBottom: "1px solid rgba(255,255,255,0.025)" }}>
                      <td style={{ padding: "5px 7px", color: symColor(s.symbol), fontWeight: 700 }}>{displaySymbolFor(s)}</td>
                      <td style={{ padding: "5px 7px", color: "#94a3b8" }}>{s.type}</td>
                      <td style={{ padding: "5px 7px", color: "#6b7280" }}>{s.configuredSource || s.activeSource}</td>
                      <td style={{ padding: "5px 7px", color: "#94a3b8" }}>{fmtDate(s.updatedAt)}</td>
                      <td style={{ padding: "5px 7px", color: colorFor(s.status), fontWeight: 700 }}>{labelFor(s.status)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
