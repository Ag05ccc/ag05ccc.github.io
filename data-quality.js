'use strict';

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateMs(value) {
  if (!value) return null;
  var s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) s = s.slice(0, 10) + 'T00:00:00Z';
  var ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function expectedTradingDay(type, ms) {
  if (type === 'stock' || type === 'commodity') {
    var day = new Date(ms).getUTCDay();
    return day !== 0 && day !== 6;
  }
  return true;
}

function parseDailyCsv(content) {
  var lines = String(content || '').split('\n').filter(function(line) {
    return line.trim().length > 0;
  });
  var candles = [];
  var invalidRows = 0;

  lines.forEach(function(line) {
    var parts = line.split(',');
    if (parts.length < 7) return;
    var date = (parts[1] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return;
    var open = parseFloat(parts[3]);
    var high = parseFloat(parts[4]);
    var low = parseFloat(parts[5]);
    var close = parseFloat(parts[6]);
    var volume = parseFloat(parts[7]);
    var valid = [open, high, low, close].every(function(v) { return Number.isFinite(v) && v > 0; }) && high >= low;
    if (!valid) invalidRows++;
    candles.push({
      date: date.slice(0, 10),
      open: Number.isFinite(open) ? open : 0,
      high: Number.isFinite(high) ? high : 0,
      low: Number.isFinite(low) ? low : 0,
      close: Number.isFinite(close) ? close : 0,
      volume: Number.isFinite(volume) ? volume : 0,
      valid: valid,
    });
  });

  candles.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { candles: candles, invalidRows: invalidRows };
}

function inspectDailyCsv(symbol, filePath, meta, nowMs) {
  meta = meta || {};
  nowMs = nowMs || Date.now();
  var type = meta.type || 'unknown';
  var base = {
    symbol: symbol,
    type: type,
    source: meta.source || 'backtest/data/*_daily.csv',
    file: path.basename(filePath),
    rows: 0,
    first: null,
    last: null,
    lastAgeDays: null,
    invalidRows: 0,
    duplicateDates: 0,
    missingExpectedCandles: 0,
    missingRatio: 0,
    status: 'missing',
  };

  if (!fs.existsSync(filePath)) return base;

  var parsed = parseDailyCsv(fs.readFileSync(filePath, 'utf8'));
  var candles = parsed.candles;
  base.rows = candles.length;
  base.invalidRows = parsed.invalidRows;
  if (!candles.length) {
    base.status = 'missing';
    return base;
  }

  var seen = {};
  var duplicates = 0;
  candles.forEach(function(c) {
    if (seen[c.date]) duplicates++;
    seen[c.date] = true;
  });

  var first = candles[0].date;
  var last = candles[candles.length - 1].date;
  var firstMs = parseDateMs(first);
  var lastMs = parseDateMs(last);
  var expected = 0;
  var missing = 0;

  if (firstMs && lastMs && lastMs >= firstMs) {
    for (var ms = firstMs; ms <= lastMs; ms += DAY_MS) {
      if (!expectedTradingDay(type, ms)) continue;
      expected++;
      if (!seen[isoDate(ms)]) missing++;
    }
  }

  base.first = first;
  base.last = last;
  base.lastAgeDays = lastMs ? Math.max(0, Math.floor((nowMs - lastMs) / DAY_MS)) : null;
  base.duplicateDates = duplicates;
  base.missingExpectedCandles = missing;
  base.missingRatio = expected > 0 ? +(missing / expected).toFixed(4) : 0;

  var staleAfterDays = type === 'crypto' ? 3 : 7;
  if (base.rows < 30) base.status = 'missing';
  else if (base.invalidRows > 0 || base.duplicateDates > 0 || base.missingRatio > 0.15) base.status = 'anomaly';
  else if (base.lastAgeDays !== null && base.lastAgeDays > staleAfterDays) base.status = 'stale';
  else base.status = 'ok';

  return base;
}

function inspectHistoricalData(opts) {
  opts = opts || {};
  var dataDir = opts.dataDir || path.join(__dirname, 'backtest', 'data');
  var coins = opts.coins || {};
  var nowMs = opts.nowMs || Date.now();
  var symbols = (opts.symbols || Object.keys(coins)).filter(function(sym) { return coins[sym]; });
  var rows = symbols.map(function(sym) {
    var meta = coins[sym] || {};
    return inspectDailyCsv(sym, path.join(dataDir, sym + '_daily.csv'), {
      type: meta.type || 'unknown',
      source: meta.type === 'crypto' ? 'Binance daily CSV' : (meta.tdSymbol ? 'Yahoo/TwelveData daily CSV' : 'daily CSV'),
    }, nowMs);
  });

  rows.sort(function(a, b) {
    var ta = a.type || '';
    var tb = b.type || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });

  var badStatuses = { missing: true, anomaly: true };
  var stale = rows.filter(function(r) { return r.status === 'stale'; });
  var hard = rows.filter(function(r) { return badStatuses[r.status]; });
  var lastUpdatedAt = null;
  rows.forEach(function(r) {
    if (r.last && (!lastUpdatedAt || r.last > lastUpdatedAt)) lastUpdatedAt = r.last;
  });

  return {
    source: dataDir,
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      status: hard.length ? 'attention' : stale.length ? 'stale' : 'ok',
      symbols: rows.length,
      ok: rows.filter(function(r) { return r.status === 'ok'; }).length,
      stale: stale.length,
      anomalies: rows.filter(function(r) { return r.status === 'anomaly'; }).length,
      missing: rows.filter(function(r) { return r.status === 'missing'; }).length,
      lastUpdatedAt: lastUpdatedAt,
    },
    symbols: rows,
  };
}

module.exports = {
  DAY_MS: DAY_MS,
  parseDateMs: parseDateMs,
  parseDailyCsv: parseDailyCsv,
  inspectDailyCsv: inspectDailyCsv,
  inspectHistoricalData: inspectHistoricalData,
};
