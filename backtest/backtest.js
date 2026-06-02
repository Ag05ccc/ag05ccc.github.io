#!/usr/bin/env node
/**
 * TradeSimBot Backtest Engine
 * Tests all 30 signals + scoring system against historical data
 * Outputs: win rate, P&L, max drawdown, Sharpe ratio per profile
 */

const fs = require('fs');
const path = require('path');
// Shared strategy logic — the SAME module the live server (server.js) uses — so this
// backtest provably reflects live trading instead of a drifted hand-copy.
const {
  COINS, ema, calcRSI, calcMACD, calcBB, calcStoch, calcADX, calcATR,
  PROFILES, evaluateTradeDecision, buildRiskPlan,
} = require('../engine-core');

const COMMISSION_RATE = 0.001;
const DEFAULT_CASH = 100000;
// The live server uses ms-based cooldowns; the backtest is bar-stepped, so it uses
// an equivalent expressed in bars.
const COOLDOWN_BARS = { conservative: 5, moderate: 3, aggressive: 2, yolo: 2 };
const MAX_HOLD_BARS = { conservative: 90, moderate: 60, aggressive: 45, yolo: 30 };

function compactDecisionSnapshot(decision) {
  return {
    action: decision.action,
    type: decision.type,
    reason: decision.reason || decision.riskSellTriggered || '',
    buyScore: +(decision.buyScore || 0).toFixed(2),
    sellScore: +(decision.sellScore || 0).toFixed(2),
    regime: decision.regime && decision.regime.type,
    exposurePct: +((decision.exposurePct || 0) * 100).toFixed(2),
    exitTriggered: decision.exitTriggered || null,
    riskSellTriggered: decision.riskSellTriggered || null,
    holdingBars: decision.holdingBars,
    maxHoldBars: decision.maxHoldBars,
    pnlPct: +((decision.pnlPct || 0) * 100).toFixed(2),
  };
}

// ─── LOAD CSV DATA ───
function loadCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('http') && !l.startsWith('Unix,'));
  const candles = lines.map(l => {
    const p = l.split(',');
    // Format: Unix,Date,Symbol,Open,High,Low,Close,Volume BTC,Volume USDT,tradecount
    return {
      t: parseInt(p[0]),
      date: p[1],
      o: parseFloat(p[3]),
      h: parseFloat(p[4]),
      l: parseFloat(p[5]),
      c: parseFloat(p[6]),
      v: parseFloat(p[7]) || 0,
    };
  }).filter(c => !isNaN(c.o) && c.o > 0);
  // Sort ascending by time
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

// ─── COMPUTE INDICATORS FOR A CANDLE WINDOW ───
function computeIndicators(candles) {
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;

  // VWAP — matches the live engine's definition (simple mean of the close window,
  // labelled 'vwap'); NOT a 20-bar volume-weighted VWAP (that was a divergence).
  const vwap = closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : lastCandle.c;

  const prevMacdHist = candles.length > 26
    ? calcMACD(closes.slice(0, -1)).hist
    : 0;

  return {
    cur: lastCandle.c,
    candles: candles,
    rsi: calcRSI(closes),
    macd: calcMACD(closes),
    prevMacdHist,
    bb: calcBB(closes),
    ema9: ema(closes, 9) || lastCandle.c,
    ema21: ema(closes, 21) || lastCandle.c,
    ema50: ema(closes, 50) || 0,
    ema200: ema(closes, 200) || 0,
    stoch: calcStoch(highs, lows, closes),
    adx: calcADX(highs, lows, closes),
    atr: calcATR(highs, lows, closes),
    vwap,
  };
}

// ─── BLACK SWAN FILTER ───
function isBlackSwan(candles) {
  if (candles.length < 5) return false;
  const recent = candles.slice(-5);
  const drop = ((recent[recent.length - 1].c - recent[0].o) / recent[0].o) * 100;
  return drop <= -3;
}

// ─── BACKTEST ENGINE ───
function runBacktest(candles, profile, symbolName) {
  const overrides = profile.overrides;
  let cash = DEFAULT_CASH;
  let holdings = {}; // { qty, avgCost }
  let peaks = {};
  let trades = [];
  let lastTradeBar = -999;
  let maxValue = DEFAULT_CASH;
  let maxDrawdown = 0;
  let dailyReturns = [];
  let prevValue = DEFAULT_CASH;
  const WINDOW = 200; // lookback window for indicators

  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - WINDOW), i + 1);
    const sd = computeIndicators(window);
    const price = sd.cur;
    const sym = symbolName;
    const pos = holdings[sym] || null;
    const peakPrice = peaks[sym] || price;

    // Update peak
    if (price > peakPrice) peaks[sym] = price;

    // Portfolio value
    const hVal = pos ? pos.qty * price : 0;
    const totalValue = cash + hVal;

    // Track drawdown
    if (totalValue > maxValue) maxValue = totalValue;
    const dd = ((maxValue - totalValue) / maxValue) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Daily return tracking (every bar)
    dailyReturns.push((totalValue - prevValue) / prevValue);
    prevValue = totalValue;

    // Circuit breaker: stop if drawdown > 20%
    if (dd > 20) continue;

    // Cooldown blocks new scoring entries/exits, but risk exits are still allowed.
    const inCooldown = i - lastTradeBar < (COOLDOWN_BARS[profile.id] || 3);

    // Black swan filter
    const blackSwan = isBlackSwan(window);

    const exposure = totalValue > 0 ? hVal / totalValue : 0;
    const decision = evaluateTradeDecision({
      sd, pos, peakPrice, profile, symbol: sym,
      blackSwan, exposurePct: exposure,
      scoreExposureLimit: 0.85, buyExposureLimit: 0.85,
      inCooldown,
      holdingBars: pos && pos.openedBar !== undefined ? i - pos.openedBar : null,
      maxHoldBars: MAX_HOLD_BARS[profile.id] || 60,
      requireAboveEma200ForBuy: false, requireBelowEma200ForSell: false,
      sellMustBeatBuy: true,
    });
    const regime = decision.regime;
    const buyScore = decision.buyScore, sellScore = decision.sellScore;
    const buyReasons = decision.buyReasons, sellReasons = decision.sellReasons;
    const slippage = (profile.overrides && profile.overrides.slippage) || 0.0005;

    // Risk signals (TP/SL/Trailing) bypass scoring -> immediate sell (with slippage)
    if (decision.action === 'riskSell') {
      const sellFillPrice = price * (1 - slippage);
      const sellQty = pos.qty;
      const total = sellQty * sellFillPrice;
      const commission = total * COMMISSION_RATE;
      const pnl = (sellFillPrice - pos.avgCost) * sellQty - commission;
      cash += total - commission;
      trades.push({ bar: i, date: candles[i].date, side: 'sell', price: sellFillPrice, qty: sellQty, total, pnl, reason: decision.riskSellTriggered, regime: regime.type, decision: compactDecisionSnapshot(decision), score: 0, type: 'risk' });
      delete holdings[sym];
      delete peaks[sym];
      lastTradeBar = i;
      continue;
    }

    // Scoring decision
    if (decision.action === 'buy') {
      const buyFillPrice = price * (1 + slippage); // slippage: buy fills higher
      const minCashReserve = DEFAULT_CASH * 0.02;
      const availableCash = Math.max(0, cash - minCashReserve);
      const maxPerPosition = { conservative: 0.30, moderate: 0.25, aggressive: 0.22, yolo: 0.30 }[profile.id] || 0.10;
      const riskPlan = buildRiskPlan({
        sd, profile, symbol: sym, price: buyFillPrice,
        cash, availableCash, startCash: DEFAULT_CASH,
        portfolioValue: totalValue, cashPct: profile.cashPct, maxPerPosition,
        regime,
      });
      const tradeValue = riskPlan.tradeValue;
      if (tradeValue < 10) continue;
      const qty = riskPlan.qty;
      const commission = tradeValue * COMMISSION_RATE;
      if (tradeValue + commission > availableCash) continue;
      cash -= tradeValue + commission;

      if (!holdings[sym]) holdings[sym] = { qty: 0, avgCost: buyFillPrice, openedBar: i };
      const h = holdings[sym];
      if (h.openedBar === undefined) h.openedBar = i;
      h.avgCost = ((h.avgCost * h.qty) + (buyFillPrice * qty)) / (h.qty + qty);
      h.qty += qty;
      peaks[sym] = price;

      trades.push({
        bar: i, date: candles[i].date, side: 'buy', price: buyFillPrice,
        bracketTP: riskPlan.takeProfitPrice, bracketSL: riskPlan.stopPrice,
        qty, total: tradeValue, pnl: 0, reason: buyReasons.join(', '),
        regime: regime.type, decision: compactDecisionSnapshot(decision), score: buyScore, type: 'score',
        atr: sd.atr || 0, riskPct: riskPlan.riskPct,
        stopPct: riskPlan.stopPct, targetPct: riskPlan.targetPct,
      });
      lastTradeBar = i;

    } else if (decision.action === 'sell') {
      const sellFillPrice = price * (1 - slippage);
      const sellQty = pos.qty;
      const total = sellQty * sellFillPrice;
      const commission = total * COMMISSION_RATE;
      const pnl = (sellFillPrice - pos.avgCost) * sellQty - commission;
      cash += total - commission;

      trades.push({ bar: i, date: candles[i].date, side: 'sell', price: sellFillPrice, qty: sellQty, total, pnl, reason: sellReasons.join(', '), regime: regime.type, decision: compactDecisionSnapshot(decision), score: -sellScore, type: 'score' });
      delete holdings[sym];
      delete peaks[sym];
      lastTradeBar = i;
    }
  }

  // Final portfolio value
  const finalPos = holdings[symbolName];
  const finalHVal = finalPos ? finalPos.qty * candles[candles.length - 1].c : 0;
  const finalValue = cash + finalHVal;

  // Calculate metrics
  const wins = trades.filter(t => t.side === 'sell' && t.pnl > 0).length;
  const losses = trades.filter(t => t.side === 'sell' && t.pnl <= 0).length;
  const totalSells = wins + losses;
  const winRate = totalSells > 0 ? (wins / totalSells * 100) : 0;
  const totalPnL = finalValue - DEFAULT_CASH;
  const totalReturn = (totalPnL / DEFAULT_CASH) * 100;
  const totalCommission = trades.reduce((s, t) => s + (t.total * COMMISSION_RATE), 0);

  // Sharpe ratio (annualized, assuming daily bars)
  const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 1;
  const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  // Buy-and-hold comparison
  const buyHoldReturn = ((candles[candles.length - 1].c - candles[WINDOW].c) / candles[WINDOW].c) * 100;

  // Signal frequency analysis
  const signalCounts = {};
  trades.forEach(t => {
    t.reason.split(', ').forEach(r => {
      signalCounts[r] = (signalCounts[r] || 0) + 1;
    });
  });

  return {
    profile: profile.id,
    symbol: symbolName,
    period: (candles[WINDOW] ? candles[WINDOW].date : '?') + ' → ' + (candles[candles.length - 1] ? candles[candles.length - 1].date : '?'),
    bars: candles.length - WINDOW,
    finalValue: finalValue.toFixed(0),
    totalReturn: totalReturn.toFixed(2) + '%',
    buyHoldReturn: buyHoldReturn.toFixed(2) + '%',
    alpha: (totalReturn - buyHoldReturn).toFixed(2) + '%',
    totalTrades: trades.length,
    buys: trades.filter(t => t.side === 'buy').length,
    sells: trades.filter(t => t.side === 'sell').length,
    winRate: winRate.toFixed(1) + '%',
    wins, losses,
    maxDrawdown: maxDrawdown.toFixed(2) + '%',
    sharpe: sharpe.toFixed(3),
    totalCommission: '$' + totalCommission.toFixed(0),
    avgTradePnL: totalSells > 0 ? '$' + (trades.filter(t => t.side === 'sell').reduce((s, t) => s + t.pnl, 0) / totalSells).toFixed(2) : 'N/A',
    topSignals: Object.entries(signalCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
    openPosition: finalPos ? { qty: finalPos.qty.toFixed(6), avgCost: finalPos.avgCost.toFixed(2), unrealizedPnL: ((candles[candles.length - 1].c - finalPos.avgCost) * finalPos.qty).toFixed(2) } : null,
    // Last 10 trades for inspection
    recentTrades: trades.slice(-10).map(t => ({
      date: t.date, side: t.side, price: t.price.toFixed(2),
      pnl: t.pnl ? t.pnl.toFixed(2) : '0', reason: t.reason,
      regime: t.regime, score: t.score.toFixed(1)
    })),
  };
}

// ─── MAIN ───
function main() {
  const dataDir = path.join(__dirname, 'data');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TradeSimBot Backtest Engine');
  console.log('  Profiles: ' + PROFILES.map(p => p.id).join(', '));
  console.log('  Data files: ' + files.join(', '));
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allResults = [];

  // Only use daily files for now (1h would take too long)
  const dailyFiles = files.filter(f => f.includes('daily'));

  for (const file of dailyFiles) {
    const sym = file.replace('_daily.csv', '').replace('_1h.csv', '');
    const candles = loadCSV(path.join(dataDir, file));
    console.log('\n' + sym + ': ' + candles.length + ' candles (' + (candles[0] ? candles[0].date : '?') + ' -> ' + (candles[candles.length - 1] ? candles[candles.length - 1].date : '?') + ')');

    for (const profile of PROFILES) {
      const result = runBacktest(candles, profile, sym);
      allResults.push(result);

      const emoji = parseFloat(result.totalReturn) > 0 ? '✅' : '❌';
      const beat = parseFloat(result.alpha) > 0 ? '🏆' : '📉';
      console.log(`  ${emoji} ${profile.id.padEnd(14)} Return: ${result.totalReturn.padStart(8)} | B&H: ${result.buyHoldReturn.padStart(8)} | Alpha: ${result.alpha.padStart(8)} ${beat} | WR: ${result.winRate.padStart(5)} | Trades: ${result.totalTrades} | MaxDD: ${result.maxDrawdown.padStart(6)} | Sharpe: ${result.sharpe}`);
    }
  }

  // Summary
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY BY PROFILE (averaged across all symbols)');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const profile of PROFILES) {
    const results = allResults.filter(r => r.profile === profile.id);
    if (results.length === 0) continue;

    const avgReturn = results.reduce((s, r) => s + parseFloat(r.totalReturn), 0) / results.length;
    const avgAlpha = results.reduce((s, r) => s + parseFloat(r.alpha), 0) / results.length;
    const avgWinRate = results.reduce((s, r) => s + parseFloat(r.winRate), 0) / results.length;
    const avgMaxDD = results.reduce((s, r) => s + parseFloat(r.maxDrawdown), 0) / results.length;
    const avgSharpe = results.reduce((s, r) => s + parseFloat(r.sharpe), 0) / results.length;
    const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);

    console.log(`\n  ${profile.id.toUpperCase()}`);
    console.log(`    Avg Return:    ${avgReturn.toFixed(2)}%`);
    console.log(`    Avg Alpha:     ${avgAlpha.toFixed(2)}%`);
    console.log(`    Avg Win Rate:  ${avgWinRate.toFixed(1)}%`);
    console.log(`    Avg Max DD:    ${avgMaxDD.toFixed(2)}%`);
    console.log(`    Avg Sharpe:    ${avgSharpe.toFixed(3)}`);
    console.log(`    Total Trades:  ${totalTrades}`);
  }

  // Signal Analysis
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  SIGNAL FREQUENCY ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════');

  const globalSignals = {};
  allResults.forEach(r => {
    r.topSignals.forEach(([sig, count]) => {
      globalSignals[sig] = (globalSignals[sig] || 0) + count;
    });
  });
  const sorted = Object.entries(globalSignals).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 15).forEach(([sig, count], i) => {
    console.log(`  ${(i + 1 + '.').padEnd(4)} ${sig.padEnd(20)} ${count} trades`);
  });

  // Save detailed results to JSON
  const outPath = path.join(__dirname, 'backtest_results.json');
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\n\n📁 Detailed results saved to: ${outPath}`);

  // Also run 1-hour backtest on BTC for more granular analysis
  const btc1h = path.join(dataDir, 'BTC_1h.csv');
  if (fs.existsSync(btc1h)) {
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('  1-HOUR BTC BACKTEST (more granular)');
    console.log('═══════════════════════════════════════════════════════════════');

    const candles1h = loadCSV(btc1h);
    console.log('  ' + candles1h.length + ' hourly candles (' + (candles1h[0] ? candles1h[0].date : '?') + ' -> ' + (candles1h[candles1h.length - 1] ? candles1h[candles1h.length - 1].date : '?') + ')');

    for (const profile of PROFILES) {
      const result = runBacktest(candles1h, profile, 'BTC');
      const emoji = parseFloat(result.totalReturn) > 0 ? '✅' : '❌';
      console.log(`  ${emoji} ${profile.id.padEnd(14)} Return: ${result.totalReturn.padStart(8)} | B&H: ${result.buyHoldReturn.padStart(8)} | Alpha: ${result.alpha.padStart(8)} | WR: ${result.winRate.padStart(5)} | Trades: ${result.totalTrades} | MaxDD: ${result.maxDrawdown.padStart(6)} | Sharpe: ${result.sharpe}`);
    }
  }
}

main();
