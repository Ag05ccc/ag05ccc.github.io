#!/usr/bin/env node
/**
 * Binance Historical Data Collector
 * Downloads 1-minute candle data for all traded crypto assets
 *
 * Usage:
 *   node collect_historical_data.js          # Full download (resumes from last saved)
 *   node collect_historical_data.js --test    # Short test (2 coins, 5 requests each)
 *   node collect_historical_data.js --status  # Show download status
 *   node collect_historical_data.js --coin BTC # Download only BTC
 */

var https = require('https');
var fs = require('fs');
var path = require('path');

// All 20 crypto pairs we trade
var PAIRS = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT',
  XRP: 'XRPUSDT', ADA: 'ADAUSDT', AVAX: 'AVAXUSDT', DOGE: 'DOGEUSDT',
  DOT: 'DOTUSDT', LINK: 'LINKUSDT', MATIC: 'MATICUSDT', UNI: 'UNIUSDT',
  ATOM: 'ATOMUSDT', LTC: 'LTCUSDT', NEAR: 'NEARUSDT', APT: 'APTUSDT',
  ARB: 'ARBUSDT', OP: 'OPUSDT', SUI: 'SUIUSDT', FIL: 'FILUSDT',
  GOLD: 'PAXGUSDT',
};

var DATA_DIR = path.join(__dirname, 'data', '1m');
var CANDLES_PER_REQUEST = 1000;
var REQUEST_DELAY_MS = 150;       // 150ms between requests (~6.6 req/sec)
var BATCH_PAUSE_MS = 2000;        // 2s pause every 10 requests
var BATCH_SIZE = 10;

// Parse args
var args = process.argv.slice(2);
var TEST_MODE = args.indexOf('--test') >= 0;
var STATUS_MODE = args.indexOf('--status') >= 0;
var COIN_ONLY = null;
var coinIdx = args.indexOf('--coin');
if (coinIdx >= 0 && args[coinIdx + 1]) COIN_ONLY = args[coinIdx + 1].toUpperCase();

// Test mode limits
var TEST_MAX_REQUESTS = 5; // Only 5 requests per coin in test mode
var TEST_COINS = ['BTC', 'ETH']; // Only 2 coins in test mode

// Ensure data directory exists
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  var parent = path.dirname(dir);
  if (!fs.existsSync(parent)) mkdirp(parent);
  fs.mkdirSync(dir);
}
mkdirp(DATA_DIR);

// Fetch JSON from URL
function fetchJSON(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'TradeSimBot/1.0' } }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// Sleep helper
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Get last saved timestamp for a coin
function getLastTimestamp(sym) {
  var filePath = path.join(DATA_DIR, sym + '.jsonl');
  if (!fs.existsSync(filePath)) return null;

  // Read last line
  var content = fs.readFileSync(filePath, 'utf8');
  var lines = content.trim().split('\n');
  if (lines.length === 0) return null;

  var lastLine = lines[lines.length - 1];
  try {
    var obj = JSON.parse(lastLine);
    return obj.t;
  } catch(e) {
    return null;
  }
}

// Count lines in file
function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  var content = fs.readFileSync(filePath, 'utf8');
  return content.trim().split('\n').filter(function(l) { return l.length > 0; }).length;
}

// Earliest listing dates (approximate, in ms) - Binance doesn't have data before these
var LISTING_DATES = {
  BTC: 1502942400000,   // 2017-08-17
  ETH: 1502942400000,   // 2017-08-17
  LTC: 1513123200000,   // 2017-12-13
  BNB: 1509926400000,   // 2017-11-06
  XRP: 1525392000000,   // 2018-05-04
  ADA: 1524960000000,   // 2018-04-29
  LINK: 1547596800000,  // 2019-01-16
  ATOM: 1556496000000,  // 2019-04-29
  DOGE: 1562284800000,  // 2019-07-05
  MATIC: 1556236800000, // 2019-04-26
  DOT: 1597708800000,   // 2020-08-18
  SOL: 1597104000000,   // 2020-08-11
  AVAX: 1600732800000,  // 2020-09-22
  UNI: 1600300800000,   // 2020-09-17
  FIL: 1602720000000,   // 2020-10-15
  NEAR: 1602633600000,  // 2020-10-14
  APT: 1665964800000,   // 2022-10-17
  ARB: 1679529600000,   // 2023-03-23
  OP: 1654041600000,    // 2022-06-01
  SUI: 1683072000000,   // 2023-05-03
  GOLD: 1598918400000,  // 2020-09-01
};

// Download candles for one coin
function downloadCoin(sym, pair) {
  var filePath = path.join(DATA_DIR, sym + '.jsonl');
  var lastTs = getLastTimestamp(sym);
  // Resume from last saved, or start from listing date
  var startTime = lastTs ? lastTs + 60000 : (LISTING_DATES[sym] || 1502942400000);

  var totalFetched = 0;
  var requestCount = 0;
  var startedAt = Date.now();

  function fetchBatch(fromTime) {
    var batchUrl = 'https://api.binance.com/api/v3/klines?symbol=' + pair + '&interval=1m&limit=' + CANDLES_PER_REQUEST;
    if (fromTime) batchUrl += '&startTime=' + fromTime;

    return fetchJSON(batchUrl).then(function(data) {
      if (!Array.isArray(data) || data.length === 0) {
        return { done: true, fetched: 0 };
      }

      // Check for API error
      if (data.code) {
        console.log('  API error:', data.msg || data.code);
        return { done: true, fetched: 0, error: data.msg };
      }

      // Convert to JSONL format
      var lines = [];
      var lastT = 0;
      data.forEach(function(k) {
        // k = [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, ...]
        var candle = {
          t: k[0],                      // open timestamp (ms)
          o: parseFloat(k[1]),           // open
          h: parseFloat(k[2]),           // high
          l: parseFloat(k[3]),           // low
          c: parseFloat(k[4]),           // close
          v: parseFloat(k[5]),           // base volume
          qv: parseFloat(k[7]),          // quote volume (USDT)
          n: parseInt(k[8]),             // number of trades
        };
        lines.push(JSON.stringify(candle));
        lastT = k[0];
      });

      // Append to file
      fs.appendFileSync(filePath, lines.join('\n') + '\n');
      totalFetched += data.length;
      requestCount++;

      // Progress
      var elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      var firstDate = new Date(data[0][0]).toISOString().slice(0, 16);
      var lastDate = new Date(lastT).toISOString().slice(0, 16);
      process.stdout.write('\r  ' + sym + ': ' + totalFetched + ' candles | req #' + requestCount + ' | ' + firstDate + ' -> ' + lastDate + ' | ' + elapsed + 's');

      // Check if we've reached current time (less than 1000 candles returned)
      if (data.length < CANDLES_PER_REQUEST) {
        return { done: true, fetched: data.length };
      }

      // Test mode limit
      if (TEST_MODE && requestCount >= TEST_MAX_REQUESTS) {
        return { done: true, fetched: data.length, testLimit: true };
      }

      // Rate limiting
      var delayMs = REQUEST_DELAY_MS;
      if (requestCount % BATCH_SIZE === 0) {
        delayMs = BATCH_PAUSE_MS;
      }

      return sleep(delayMs).then(function() {
        // Next batch starts 1ms after last candle close time
        return fetchBatch(lastT + 60000);
      });
    });
  }

  var existingLines = countLines(filePath);
  if (existingLines > 0 && lastTs) {
    var lastDate = new Date(lastTs).toISOString().slice(0, 16);
    console.log('  ' + sym + ': Resuming from ' + lastDate + ' (' + existingLines + ' existing candles)');
  } else {
    console.log('  ' + sym + ': Starting fresh download');
  }

  return fetchBatch(startTime).then(function(result) {
    console.log(''); // newline after progress
    if (result && result.testLimit) {
      console.log('  ' + sym + ': Test limit reached (' + TEST_MAX_REQUESTS + ' requests, ' + totalFetched + ' candles)');
    } else if (result && result.error) {
      console.log('  ' + sym + ': Error - ' + result.error);
    } else {
      var total = existingLines + totalFetched;
      console.log('  ' + sym + ': Complete! Total: ' + total + ' candles');
    }
    return { sym: sym, newCandles: totalFetched, totalCandles: existingLines + totalFetched, requests: requestCount };
  }).catch(function(err) {
    console.log('');
    console.log('  ' + sym + ': FAILED - ' + err.message);
    return { sym: sym, newCandles: 0, error: err.message };
  });
}

// Show status of all downloaded data
function showStatus() {
  console.log('');
  console.log('=== Historical Data Status ===');
  console.log('Directory: ' + DATA_DIR);
  console.log('');

  var totalCandles = 0;
  var totalSize = 0;

  Object.keys(PAIRS).forEach(function(sym) {
    var filePath = path.join(DATA_DIR, sym + '.jsonl');
    if (!fs.existsSync(filePath)) {
      console.log('  ' + sym.padEnd(6) + ': No data');
      return;
    }
    var stats = fs.statSync(filePath);
    var lines = countLines(filePath);
    var lastTs = getLastTimestamp(sym);
    var lastDate = lastTs ? new Date(lastTs).toISOString().slice(0, 16) : '?';

    // Get first timestamp
    var firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
    var firstTs = null;
    try { firstTs = JSON.parse(firstLine).t; } catch(e) {}
    var firstDate = firstTs ? new Date(firstTs).toISOString().slice(0, 16) : '?';

    var sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log('  ' + sym.padEnd(6) + ': ' + String(lines).padStart(8) + ' candles | ' + sizeMB.padStart(6) + ' MB | ' + firstDate + ' -> ' + lastDate);
    totalCandles += lines;
    totalSize += stats.size;
  });

  console.log('');
  console.log('  Total: ' + totalCandles + ' candles, ' + (totalSize / 1024 / 1024).toFixed(1) + ' MB');
  console.log('');
}

// Main
function main() {
  console.log('');
  console.log('========================================');
  console.log('  Binance Historical Data Collector');
  console.log('  Interval: 1 minute');
  console.log('  Mode: ' + (TEST_MODE ? 'TEST (5 requests/coin, 2 coins)' : COIN_ONLY ? 'Single coin: ' + COIN_ONLY : 'FULL (all 20 coins)'));
  console.log('========================================');
  console.log('');

  if (STATUS_MODE) {
    showStatus();
    return;
  }

  // Select coins to download
  var coins = Object.keys(PAIRS);
  if (TEST_MODE) coins = TEST_COINS;
  if (COIN_ONLY) {
    if (!PAIRS[COIN_ONLY]) {
      console.log('Unknown coin: ' + COIN_ONLY);
      console.log('Available: ' + Object.keys(PAIRS).join(', '));
      return;
    }
    coins = [COIN_ONLY];
  }

  var startTime = Date.now();
  var results = [];
  var idx = 0;

  function next() {
    if (idx >= coins.length) {
      // Summary
      var elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      var totalNew = results.reduce(function(s, r) { return s + (r.newCandles || 0); }, 0);
      var totalReqs = results.reduce(function(s, r) { return s + (r.requests || 0); }, 0);
      console.log('');
      console.log('========================================');
      console.log('  COMPLETE');
      console.log('  Coins: ' + coins.length);
      console.log('  New candles: ' + totalNew);
      console.log('  Total requests: ' + totalReqs);
      console.log('  Time: ' + elapsed + ' minutes');
      console.log('========================================');
      console.log('');
      showStatus();
      return;
    }

    var sym = coins[idx];
    var pair = PAIRS[sym];
    idx++;

    console.log('\n[' + idx + '/' + coins.length + '] Downloading ' + sym + ' (' + pair + ')...');

    downloadCoin(sym, pair).then(function(result) {
      results.push(result);
      // Pause between coins
      return sleep(1000);
    }).then(next);
  }

  next();
}

main();
