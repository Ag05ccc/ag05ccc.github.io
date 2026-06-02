window.BacktestAuditPanel = function BacktestAuditPanel({ result, selectedTrade, onSelectTrade, isMobile }) {
  if (!result) return null;

  function statusColor(status) {
    if (status === "ok") return "#22c55e";
    if (status === "stale") return "#f59e0b";
    return "#ef4444";
  }
  function pctBar(label, value, color) {
    var n = Math.abs(parseFloat(value) || 0);
    var width = Math.max(4, Math.min(100, (n / 10) * 100));
    return (
      <div style={{ marginBottom: 7 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#6b7280", fontFamily: "var(--m)", marginBottom: 3 }}>
          <span>{label}</span><span style={{ color: color, fontWeight: 700 }}>{value || 0}</span>
        </div>
        <div style={{ height: 5, background: "#111827", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: width + "%", background: color, borderRadius: 3 }} />
        </div>
      </div>
    );
  }
  function reasonItems(trade, decision) {
    var raw = [];
    if (decision && decision.buyReasons && decision.buyReasons.length) raw = raw.concat(decision.buyReasons);
    if (decision && decision.sellReasons && decision.sellReasons.length) raw = raw.concat(decision.sellReasons);
    if (!raw.length && trade && trade.reason) raw = String(trade.reason).split(',');
    if (!raw.length && decision && decision.reason) raw = [decision.reason];
    return raw.map(function(r) { return String(r || '').trim(); }).filter(Boolean).slice(0, 8);
  }
  function actionSentence(trade, decision) {
    if (!trade) return "Select a trade to inspect the decision snapshot.";
    var side = trade.side === "buy" ? "BUY" : "SELL";
    if (decision && decision.action === "riskSell") return "Risk exit executed because " + (decision.riskSellTriggered || decision.reason || trade.reason || "a protective exit was triggered") + ".";
    if (side === "BUY") return "BUY executed because the buy score reached the profile threshold and risk gates allowed a new position.";
    return "SELL executed because exit/risk conditions or sell score justified closing the position.";
  }

  const meta = result.metadata || {};
  const manifest = meta.dataManifest || {};
  const manifestRows = manifest.symbols || [];
  const trades = result.trades || [];
  const auditTrade = selectedTrade || trades.find(function(t) { return t.decision; }) || trades[0] || null;
  const d = (auditTrade && auditTrade.decision) || {};
  const reasons = reasonItems(auditTrade, d);
  const blocked = []
    .concat(d.buyBlockedReasons || [])
    .concat(d.sellBlockedReasons || [])
    .map(function(r) { return String(r || '').trim(); })
    .filter(Boolean);
  const recentTrades = trades.slice(-10).reverse();

  return (
    <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(129,140,248,0.2)", padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <div style={{ color: "#818cf8", fontFamily: "var(--h)", fontWeight: 700, fontSize: 11 }}>DECISION AUDIT</div>
          <div style={{ color: "#4b5563", fontSize: 9, fontFamily: "var(--m)", marginTop: 2 }}>Decision snapshot + data manifest translated into trade rationale.</div>
        </div>
        {meta.parameterHash ? <div style={{ color: "#6b7280", fontSize: 10, fontFamily: "var(--m)" }}>Param <span style={{ color: "#818cf8", fontWeight: 700 }}>{meta.parameterHash}</span></div> : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.15fr 1fr", gap: 12 }}>
        <div style={{ background: "#0a0e17", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
            <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 700 }}>WHY THIS TRADE</div>
            {auditTrade && <span style={{ fontSize: 9, color: symColor(auditTrade.symbol), fontFamily: "var(--m)", fontWeight: 700 }}>{auditTrade.date} · {auditTrade.symbol}</span>}
          </div>
          {auditTrade ? (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 4, background: auditTrade.side === "buy" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: auditTrade.side === "buy" ? "#22c55e" : "#ef4444", fontFamily: "var(--m)", fontWeight: 700 }}>{auditTrade.side === "buy" ? "BUY" : "SELL"}</span>
                <span style={{ color: "#f8fafc", fontSize: 12, fontFamily: "var(--m)", fontWeight: 700 }}>${fmt(auditTrade.price || 0)}</span>
                {auditTrade.pnl !== undefined && auditTrade.pnl !== 0 ? <span style={{ color: auditTrade.pnl > 0 ? "#22c55e" : "#ef4444", fontSize: 10, fontFamily: "var(--m)", fontWeight: 700 }}>{auditTrade.pnl > 0 ? "+" : ""}${fK(auditTrade.pnl)} {auditTrade.pnlPct ? "(" + (auditTrade.pnlPct > 0 ? "+" : "") + auditTrade.pnlPct + "%)" : ""}</span> : null}
                {d.regime ? <span style={{ color: "#94a3b8", fontSize: 9, fontFamily: "var(--m)" }}>Regime {d.regime}</span> : null}
              </div>
              <div style={{ color: "#cbd5e1", fontSize: 12, fontFamily: "var(--m)", lineHeight: 1.5, marginBottom: 10 }}>{actionSentence(auditTrade, d)}</div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  {pctBar("Buy score", d.buyScore || 0, "#22c55e")}
                  {pctBar("Sell score", d.sellScore || 0, "#ef4444")}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 9, fontFamily: "var(--m)" }}>
                  {[
                    ["Exposure", d.exposurePct !== undefined ? d.exposurePct + "%" : "n/a"],
                    ["Holding", d.holdingBars !== undefined && d.holdingBars !== null ? d.holdingBars + "/" + (d.maxHoldBars || "-") : "n/a"],
                    ["Exit", d.exitTriggered || d.riskSellTriggered || "none"],
                    ["Action", d.action || auditTrade.side],
                  ].map(function(item) {
                    return (
                      <div key={item[0]} style={{ background: "#111827", borderRadius: 5, padding: "6px 7px" }}>
                        <div style={{ color: "#4b5563", fontSize: 8, marginBottom: 2 }}>{item[0]}</div>
                        <div style={{ color: "#94a3b8", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item[1]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {reasons.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, fontFamily: "var(--h)", fontWeight: 700, marginBottom: 5 }}>SIGNALS / REASONS</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {reasons.map(function(r, i) {
                      return <span key={i} style={{ fontSize: 9, color: "#a78bfa", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.16)", borderRadius: 4, padding: "2px 6px", fontFamily: "var(--m)" }}>{r}</span>;
                    })}
                  </div>
                </div>
              )}
              {blocked.length > 0 && (
                <div style={{ color: "#f59e0b", fontSize: 10, fontFamily: "var(--m)", lineHeight: 1.5 }}>
                  Blocked alternatives: {blocked.slice(0, 5).join(" · ")}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#374151", fontSize: 11, fontFamily: "var(--m)", padding: 16 }}>No trades available for audit.</div>
          )}
        </div>

        <div style={{ background: "#0a0e17", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", padding: 12 }}>
          <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "var(--h)", fontWeight: 700, marginBottom: 8 }}>DATA MANIFEST</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 9, fontFamily: "var(--m)", marginBottom: 9 }}>
            <span style={{ color: "#6b7280" }}>Source <span style={{ color: "#94a3b8" }}>{manifest.source || meta.dataSource || "n/a"}</span></span>
            <span style={{ color: "#6b7280" }}>Timeframe <span style={{ color: "#94a3b8" }}>{manifest.timeframe || result.timeframe || "n/a"}</span></span>
            <span style={{ color: "#6b7280" }}>Generated <span style={{ color: "#94a3b8" }}>{meta.generatedAt ? meta.generatedAt.slice(0, 19).replace("T", " ") : "n/a"}</span></span>
          </div>
          <div style={{ maxHeight: 184, overflowY: "auto", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            {manifestRows.map(function(row) {
              return (
                <div key={row.symbol} style={{ display: "grid", gridTemplateColumns: "48px 46px 1fr 54px", gap: 6, alignItems: "center", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.025)", fontSize: 9, fontFamily: "var(--m)" }}>
                  <span style={{ color: symColor(row.symbol), fontWeight: 700 }}>{row.symbol}</span>
                  <span style={{ color: "#6b7280" }}>{row.rows}r</span>
                  <span style={{ color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.first || "?"} - {row.last || "?"}</span>
                  <span style={{ color: statusColor(row.status), fontWeight: 700, textAlign: "right" }}>{(row.status || "ok").toUpperCase()}</span>
                </div>
              );
            })}
            {manifestRows.length === 0 && <div style={{ color: "#374151", fontSize: 11, fontFamily: "var(--m)", padding: 12 }}>No manifest rows.</div>}
          </div>
        </div>
      </div>

      {recentTrades.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", gap: 4, flexWrap: "wrap" }}>
          {recentTrades.map(function(t, i) {
            var active = auditTrade === t;
            return (
              <button key={i} onClick={function() { if (onSelectTrade) onSelectTrade(t); }} className="bt" style={{ padding: "3px 7px", borderRadius: 4, border: active ? "1px solid #818cf8" : "1px solid #1e293b", background: active ? "rgba(129,140,248,0.14)" : "transparent", color: active ? "#c4b5fd" : "#6b7280", fontSize: 9, fontFamily: "var(--m)", fontWeight: 700, cursor: "pointer" }}>
                {t.side === "buy" ? "B" : "S"} {t.symbol} {t.date}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
