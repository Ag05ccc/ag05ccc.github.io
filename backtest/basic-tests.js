#!/usr/bin/env node
/**
 * TradeSimBot Basic Tests
 * Fundamental sanity checks that MUST pass after every update.
 * Run: node backtest/basic-tests.js
 *
 * Each test calls POST /api/backtest and checks expected outcomes.
 * Results saved to backtest/test-results/
 */

var http = require('http');
var fs = require('fs');
var path = require('path');

var RESULTS_DIR = path.join(__dirname, 'test-results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);

var SERVER_URL = 'http://localhost:3000';
var passed = 0, failed = 0;
var allResults = [];

function postBacktest(params) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(params);
    var req = http.request(SERVER_URL + '/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function assert(testName, condition, actual, expected, details) {
  var result = {
    test: testName,
    passed: condition,
    actual: actual,
    expected: expected,
    details: details || '',
  };
  allResults.push(result);
  if (condition) {
    passed++;
    console.log('  ✅ ' + testName);
  } else {
    failed++;
    console.log('  ❌ ' + testName);
    console.log('     Expected: ' + expected);
    console.log('     Actual:   ' + actual);
    if (details) console.log('     Details:  ' + details);
  }
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// ═══════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════

function runTests() {
  var startTime = Date.now();
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  TradeSimBot Basic Tests');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════');

  // TEST 1: GOLD buy-and-hold should be profitable
  // Gold went from ~$1900 to ~$4500 (2022-2026), any strategy should not lose badly
  console.log('\n📊 Test Group 1: Asset Basics');

  return postBacktest({
    profile: 'conservative', symbols: ['GOLD'], startDate: '2023-01-01'
  }).then(function(d) {
    var m = d.metrics;
    // Save full result
    fs.writeFileSync(path.join(RESULTS_DIR, 'test1-gold-conservative.json'), JSON.stringify(d, null, 2));

    assert('GOLD Conservative: should not lose > 5%',
      m.totalReturn > -5,
      m.totalReturn + '%',
      '> -5%',
      'B&H: ' + m.buyHoldReturn + '%, Trades: ' + m.totalTrades
    );
    assert('GOLD Conservative: Sharpe should be > -1',
      m.sharpe > -1,
      m.sharpe,
      '> -1'
    );
    assert('GOLD Conservative: Max DD < 10%',
      m.maxDrawdown < 10,
      m.maxDrawdown + '%',
      '< 10%'
    );
    return sleep(100);

  }).then(function() {
    return postBacktest({
      profile: 'moderate', symbols: ['GOLD'], startDate: '2023-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test1-gold-moderate.json'), JSON.stringify(d, null, 2));

    assert('GOLD Moderate: should not lose > 5%',
      m.totalReturn > -5,
      m.totalReturn + '%',
      '> -5%'
    );
    return sleep(100);

  // TEST 2: BTC bull market should be profitable
  }).then(function() {
    console.log('\n📊 Test Group 2: Bull Market');
    return postBacktest({
      profile: 'moderate', symbols: ['BTC'], startDate: '2023-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test2-btc-bull-moderate.json'), JSON.stringify(d, null, 2));

    assert('BTC Bull Moderate: should be profitable (> 0%)',
      m.totalReturn > 0,
      m.totalReturn + '%',
      '> 0%',
      'B&H: ' + m.buyHoldReturn + '%'
    );
    assert('BTC Bull Moderate: Max DD < 30%',
      m.maxDrawdown < 30,
      m.maxDrawdown + '%',
      '< 30%'
    );
    return sleep(100);

  }).then(function() {
    return postBacktest({
      profile: 'conservative', symbols: ['BTC', 'ETH'], startDate: '2023-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test2-btceth-bull-conservative.json'), JSON.stringify(d, null, 2));

    assert('BTC+ETH Bull Conservative: should not lose > 10%',
      m.totalReturn > -10,
      m.totalReturn + '%',
      '> -10%'
    );
    return sleep(100);

  // TEST 3: Sharpe sanity
  }).then(function() {
    console.log('\n📊 Test Group 3: Metric Sanity');
    return postBacktest({
      profile: 'yolo', symbols: ['BTC', 'ETH', 'SOL', 'DOGE'], startDate: '2022-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test3-yolo-sanity.json'), JSON.stringify(d, null, 2));

    // If return is negative, Sharpe must be negative
    if (m.totalReturn < -10) {
      assert('Sharpe sanity: negative return -> negative Sharpe',
        m.sharpe < 0,
        'Sharpe: ' + m.sharpe + ' (return: ' + m.totalReturn + '%)',
        'Sharpe < 0 when return < -10%'
      );
    }

    // totalTrades should equal wins + losses
    assert('totalTrades = wins + losses',
      m.totalTrades === m.wins + m.losses,
      m.totalTrades + ' vs ' + (m.wins + m.losses),
      'Equal'
    );

    // buys >= sells (can have unclosed positions at end)
    assert('buys >= sells',
      m.buys >= m.sells,
      'buys: ' + m.buys + ', sells: ' + m.sells,
      'buys >= sells'
    );

    // Commission should be positive
    assert('Commission > 0',
      m.totalCommission > 0,
      '$' + m.totalCommission,
      '> 0'
    );

    // Final equity should match return
    var expectedFinal = m.startCash * (1 + m.totalReturn / 100);
    assert('Final equity matches return (within 5%)',
      Math.abs(m.finalEquity - expectedFinal) / m.startCash < 0.05,
      '$' + m.finalEquity + ' vs expected $' + expectedFinal.toFixed(0),
      'Within 5% of startCash * (1 + return)'
    );
    return sleep(100);

  // TEST 4: Circuit breaker should limit drawdown
  }).then(function() {
    console.log('\n📊 Test Group 4: Risk Controls');
    return postBacktest({
      profile: 'conservative', symbols: ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE'], startDate: '2022-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test4-conservative-risk.json'), JSON.stringify(d, null, 2));

    // Conservative should never exceed 20% DD (threshold is 10%, with 3 max triggers = ~30% max)
    assert('Conservative Max DD < 35%',
      m.maxDrawdown < 35,
      m.maxDrawdown + '%',
      '< 35%'
    );
    return sleep(100);

  }).then(function() {
    return postBacktest({
      profile: 'aggressive', symbols: ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE'], startDate: '2022-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test4-aggressive-risk.json'), JSON.stringify(d, null, 2));

    // Aggressive DD threshold is 20%, max 3 triggers = ~60% theoretical max
    assert('Aggressive Max DD < 70%',
      m.maxDrawdown < 70,
      m.maxDrawdown + '%',
      '< 70%'
    );
    return sleep(100);

  // TEST 5: Exposure should never exceed 100%
  }).then(function() {
    console.log('\n📊 Test Group 5: Exposure Control');
    return postBacktest({
      profile: 'yolo', symbols: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'LINK', 'AVAX', 'DOT'], startDate: '2023-01-01'
    });
  }).then(function(d) {
    var m = d.metrics;
    var trades = d.trades || [];
    fs.writeFileSync(path.join(RESULTS_DIR, 'test5-yolo-exposure.json'), JSON.stringify(d, null, 2));

    // Check no single BUY order exceeds per-position max (YOLO = 8%)
    var maxBuySize = 0;
    trades.forEach(function(t) {
      if (t.side === 'buy' && t.total > maxBuySize) maxBuySize = t.total;
    });
    var perPosMax = { conservative: 0.15, moderate: 0.12, aggressive: 0.10, yolo: 0.08 }['yolo'];
    assert('No single BUY order > $' + (m.startCash * perPosMax * 1.05).toFixed(0) + ' (8% YOLO cap + tolerance)',
      maxBuySize <= m.startCash * perPosMax * 1.05,
      '$' + maxBuySize.toFixed(0),
      '<= $' + (m.startCash * perPosMax * 1.05).toFixed(0)
    );

    // Max open positions for YOLO is 12
    // Count max simultaneous open positions from trades
    var openPos = {};
    var maxOpen = 0;
    trades.forEach(function(t) {
      if (t.side === 'buy') openPos[t.symbol] = (openPos[t.symbol] || 0) + 1;
      else if (t.side === 'sell') { openPos[t.symbol] = (openPos[t.symbol] || 1) - 1; if (openPos[t.symbol] <= 0) delete openPos[t.symbol]; }
      var cur = Object.keys(openPos).length;
      if (cur > maxOpen) maxOpen = cur;
    });
    assert('YOLO max simultaneous positions <= 12',
      maxOpen <= 12,
      maxOpen,
      '<= 12'
    );
    return sleep(100);

  // TEST 6: Conservative should beat YOLO in risk-adjusted terms
  }).then(function() {
    console.log('\n📊 Test Group 6: Profile Differentiation');
    return Promise.all([
      postBacktest({ profile: 'conservative', symbols: ['BTC', 'ETH'], startDate: '2022-01-01' }),
      postBacktest({ profile: 'yolo', symbols: ['BTC', 'ETH'], startDate: '2022-01-01' }),
    ]);
  }).then(function(results) {
    var consM = results[0].metrics;
    var yoloM = results[1].metrics;
    fs.writeFileSync(path.join(RESULTS_DIR, 'test6-cons-vs-yolo.json'), JSON.stringify({ conservative: results[0].metrics, yolo: results[1].metrics }, null, 2));

    assert('Conservative DD < YOLO DD',
      consM.maxDrawdown < yoloM.maxDrawdown,
      'Cons DD: ' + consM.maxDrawdown + '% vs YOLO DD: ' + yoloM.maxDrawdown + '%',
      'Conservative should have lower drawdown'
    );

    assert('Conservative fewer trades than YOLO',
      consM.totalOrders < yoloM.totalOrders,
      'Cons: ' + consM.totalOrders + ' vs YOLO: ' + yoloM.totalOrders,
      'Conservative should trade less'
    );
    return sleep(100);

  // DONE
  }).then(function() {
    var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed');
    console.log('  Time: ' + elapsed + 's');
    console.log('═══════════════════════════════════════════════════');

    // Save summary
    var summary = {
      date: new Date().toISOString(),
      passed: passed,
      failed: failed,
      total: passed + failed,
      duration: elapsed + 's',
      tests: allResults,
    };
    fs.writeFileSync(path.join(RESULTS_DIR, 'summary-' + new Date().toISOString().slice(0, 10) + '.json'), JSON.stringify(summary, null, 2));

    if (failed > 0) {
      console.log('\n⚠️  FAILED TESTS:');
      allResults.filter(function(r) { return !r.passed; }).forEach(function(r) {
        console.log('  ❌ ' + r.test);
        console.log('     Expected: ' + r.expected + ' | Actual: ' + r.actual);
      });
      process.exit(1);
    } else {
      console.log('\n✅ All tests passed!');
      process.exit(0);
    }
  }).catch(function(err) {
    console.log('\n💥 Test runner error: ' + err.message);
    console.log('   Make sure server is running: node server.js');
    process.exit(1);
  });
}

runTests();
