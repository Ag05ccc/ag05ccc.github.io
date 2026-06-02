#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const { COINS } = require('../engine-core');
const { inspectHistoricalData } = require('../data-quality');

function fetchJson(url, timeoutMs) {
  timeoutMs = timeoutMs || 4000;
  return new Promise(function(resolve, reject) {
    var req = http.get(url, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, function() {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function statusIcon(status) {
  if (status === 'ok') return 'PASS';
  if (status === 'stale' || status === 'attention') return 'WARN';
  return 'FAIL';
}

async function main() {
  var historical = inspectHistoricalData({
    dataDir: path.join(__dirname, 'data'),
    coins: COINS,
    nowMs: Date.now(),
  });

  console.log('Historical data quality: ' + statusIcon(historical.summary.status));
  console.log('  symbols=' + historical.summary.symbols +
    ' ok=' + historical.summary.ok +
    ' stale=' + historical.summary.stale +
    ' anomalies=' + historical.summary.anomalies +
    ' missing=' + historical.summary.missing +
    ' lastUpdated=' + (historical.summary.lastUpdatedAt || 'n/a'));

  var hard = historical.symbols.filter(function(s) { return s.status === 'missing' || s.status === 'anomaly'; });
  var stale = historical.symbols.filter(function(s) { return s.status === 'stale'; });

  if (hard.length) {
    console.log('\nHard historical data problems:');
    hard.slice(0, 12).forEach(function(s) {
      console.log('  FAIL ' + s.symbol + ' status=' + s.status +
        ' rows=' + s.rows +
        ' invalid=' + s.invalidRows +
        ' duplicates=' + s.duplicateDates +
        ' missingCandles=' + s.missingExpectedCandles);
    });
  }

  if (stale.length) {
    console.log('\nStale historical files (warning):');
    stale.slice(0, 12).forEach(function(s) {
      console.log('  WARN ' + s.symbol + ' last=' + s.last + ' ageDays=' + s.lastAgeDays);
    });
    if (stale.length > 12) console.log('  ... +' + (stale.length - 12) + ' more');
  }

  var endpointUrl = process.env.DATA_QUALITY_URL || ('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/data-quality');
  if (process.env.CHECK_DATA_QUALITY_ENDPOINT !== '0') {
    try {
      var response = await fetchJson(endpointUrl, 5000);
      var data = response.body || {};
      var summary = data.summary || {};
      console.log('\nLive data-quality endpoint: ' + statusIcon(summary.status || 'attention'));
      console.log('  http=' + response.statusCode +
        ' live=' + (summary.liveStatus || 'n/a') +
        ' liveStale=' + (summary.liveStale || 0) +
        ' liveMissing=' + (summary.liveMissing || 0) +
        ' historical=' + (summary.historicalStatus || 'n/a') +
        ' lastLive=' + (summary.lastLiveUpdateAt || 'n/a'));
      if (response.statusCode >= 500 || !data.live || !data.historical) {
        hard.push({ symbol: 'endpoint', status: 'missing' });
      }
    } catch (e) {
      console.log('\nLive data-quality endpoint: WARN');
      console.log('  ' + endpointUrl + ' unavailable (' + e.message + ')');
    }
  }

  if (hard.length) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

main().catch(function(e) {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
