window.BacktestDiagnosticsPanel = function BacktestDiagnosticsPanel({ diagnostics, isMobile }) {
  if (!diagnostics) return null;

  function pnlColor(v) {
    return (v || 0) >= 0 ? "#22c55e" : "#ef4444";
  }
  function label(key) {
    var map = {
      profitLock: "Profit Lock",
      signalReversal: "Signal Reversal",
      timeExit: "Time Exit",
      trailingStop: "Trailing",
      stopLoss: "Stop Loss",
      circuitBreaker: "Circuit Breaker",
      forcedClose: "Forced Close",
      scoreSell: "Score Sell",
      riskOther: "Risk Other",
      dma: "DMA",
    };
    return map[key] || key;
  }

  const e = diagnostics.exposure || {};
  const perSymbol = diagnostics.perSymbol || [];
  const exits = diagnostics.exitReasons || [];
  const missed = diagnostics.missedTrends || [];

  return (
    <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(34,197,94,0.16)", padding: 16, marginBottom: 16 }}>
      <div style={{ color: "#22c55e", fontFamily: "var(--h)", fontWeight: 700, fontSize: 11, marginBottom: 10 }}>PERFORMANCE DIAGNOSTICS</div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(5, 1fr)", gap: 8, marginBottom: 12 }}>
        {[
          ["Avg Exposure", (e.avgExposurePct || 0) + "%", "#22c55e"],
          ["Avg Cash", (e.avgCashPct || 0) + "%", e.avgCashPct > 50 ? "#f59e0b" : "#94a3b8"],
          ["Max Exposure", (e.maxExposurePct || 0) + "%", "#818cf8"],
          ["Avg Positions", e.avgOpenPositions || 0, "#a5b4fc"],
          ["Idle Time", (e.idlePct || 0) + "%", e.idlePct > 40 ? "#f59e0b" : "#94a3b8"],
        ].map(function(card) {
          return (
            <div key={card[0]} style={{ background: "#0a0e17", borderRadius: 6, padding: "8px 9px", border: "1px solid rgba(255,255,255,0.03)" }}>
              <div style={{ fontSize: 8, color: "#4b5563", fontFamily: "var(--h)", fontWeight: 700, marginBottom: 3 }}>{card[0]}</div>
              <div style={{ color: card[2], fontFamily: "var(--m)", fontWeight: 700, fontSize: 13 }}>{card[1]}</div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 10 }}>
        <div style={{ background: "#0a0e17", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", padding: 10 }}>
          <div style={{ color: "#6b7280", fontSize: 9, fontFamily: "var(--h)", fontWeight: 700, marginBottom: 7 }}>EXIT P&L</div>
          {exits.length === 0 ? <div style={{ color: "#374151", fontSize: 10 }}>No sell exits.</div> : exits.slice(0, 6).map(function(row) {
            return (
              <div key={row.key} style={{ display: "grid", gridTemplateColumns: "1fr 64px 42px", gap: 6, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.025)", fontSize: 10, fontFamily: "var(--m)" }}>
                <span style={{ color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label(row.key)}</span>
                <span style={{ color: pnlColor(row.pnl), fontWeight: 700, textAlign: "right" }}>{row.pnl >= 0 ? "+" : "-"}${fK(Math.abs(row.pnl))}</span>
                <span style={{ color: "#4b5563", textAlign: "right" }}>{row.count}x</span>
              </div>
            );
          })}
        </div>

        <div style={{ background: "#0a0e17", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", padding: 10 }}>
          <div style={{ color: "#6b7280", fontSize: 9, fontFamily: "var(--h)", fontWeight: 700, marginBottom: 7 }}>SYMBOL P&L</div>
          {perSymbol.length === 0 ? <div style={{ color: "#374151", fontSize: 10 }}>No symbol P&L.</div> : perSymbol.slice(0, 6).map(function(row) {
            return (
              <div key={row.symbol} style={{ display: "grid", gridTemplateColumns: "45px 1fr 46px", gap: 6, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.025)", fontSize: 10, fontFamily: "var(--m)" }}>
                <span style={{ color: symColor(row.symbol), fontWeight: 700 }}>{row.symbol}</span>
                <span style={{ color: pnlColor(row.pnl), fontWeight: 700 }}>{row.pnl >= 0 ? "+" : "-"}${fK(Math.abs(row.pnl))}</span>
                <span style={{ color: "#4b5563", textAlign: "right" }}>{row.winRate}%</span>
              </div>
            );
          })}
        </div>

        <div style={{ background: "#0a0e17", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", padding: 10 }}>
          <div style={{ color: "#6b7280", fontSize: 9, fontFamily: "var(--h)", fontWeight: 700, marginBottom: 7 }}>MISSED TRENDS</div>
          {missed.length === 0 ? <div style={{ color: "#22c55e", fontSize: 10, fontFamily: "var(--m)" }}>No large unowned trend windows detected.</div> : missed.slice(0, 6).map(function(row) {
            var reason = row.topReasons && row.topReasons[0] ? row.topReasons[0].reason : "n/a";
            return (
              <div key={row.symbol} style={{ padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.025)", fontSize: 10, fontFamily: "var(--m)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <span style={{ color: symColor(row.symbol), fontWeight: 700 }}>{row.symbol}</span>
                  <span style={{ color: "#f59e0b", fontWeight: 700 }}>{row.days}d · +{row.avgTrendReturnPct}%</span>
                </div>
                <div style={{ color: "#4b5563", fontSize: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
