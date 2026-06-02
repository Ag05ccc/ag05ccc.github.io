window.BacktestQualityPanel = function BacktestQualityPanel({ quality: q, metadata: meta, isMobile }) {
  if (!q) return null;
  const splitPct = Math.round((q.splitRatio || 0.7) * 100);
  return (
    <div style={{ background: "#0f172a", borderRadius: 8, padding: "10px 14px", border: "1px solid rgba(129,140,248,0.18)", marginBottom: 16, fontSize: 11, fontFamily: "var(--m)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ color: "#818cf8", fontFamily: "var(--h)", fontWeight: 700, fontSize: 10 }}>BACKTEST QUALITY</div>
        {meta && meta.parameterHash ? <div style={{ color: "#6b7280", fontSize: 10 }}>Param <span style={{ color: "#818cf8", fontWeight: 700 }}>{meta.parameterHash}</span></div> : null}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ color: "#6b7280" }}>In-sample: <span style={{ color: q.inSample.totalReturn >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{q.inSample.totalReturn >= 0 ? "+" : ""}{q.inSample.totalReturn}%</span> <span style={{ color: "#4b5563" }}>DD {q.inSample.maxDrawdown}%</span></span>
        <span style={{ color: "#6b7280" }}>Out-of-sample: <span style={{ color: q.outOfSample.totalReturn >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{q.outOfSample.totalReturn >= 0 ? "+" : ""}{q.outOfSample.totalReturn}%</span> <span style={{ color: "#4b5563" }}>Sharpe {q.outOfSample.sharpe}</span></span>
        <span style={{ color: "#6b7280" }}>Split: <span style={{ color: "#f8fafc" }}>{splitPct}% / {100 - splitPct}%</span></span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 6 }}>
        {(q.walkForward || []).map(function(w) {
          return (
            <div key={w.window} style={{ background: "#0a0e17", borderRadius: 6, padding: "7px 8px", border: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ color: "#6b7280", fontSize: 9, marginBottom: 3 }}>W{w.window} {w.startDate} - {w.endDate}</div>
              <div style={{ color: w.totalReturn >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{w.totalReturn >= 0 ? "+" : ""}{w.totalReturn}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
