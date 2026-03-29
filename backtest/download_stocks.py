#!/usr/bin/env python3
"""
Download stock historical daily data for backtest.
Uses Yahoo Finance chart API, falls back to Twelve Data.
"""
import urllib.request, json, time, os, sys
from datetime import datetime

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
TWELVEDATA_KEY = 'ef43ade644944f92b7a4effcc0c9208e'

STOCKS = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM', 'V', 'WMT',
    'NFLX', 'AMD', 'CRM', 'ORCL', 'INTC', 'DIS', 'BA', 'PYPL', 'UBER', 'COIN',
]

def fetch_yahoo(ticker):
    """Fetch 5y daily data from Yahoo Finance."""
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=5y&interval=1d'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    })
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
        result = data['chart']['result'][0]
        timestamps = result['timestamp']
        q = result['indicators']['quote'][0]
        rows = []
        for i in range(len(timestamps)):
            o = q['open'][i]
            h = q['high'][i]
            l = q['low'][i]
            c = q['close'][i]
            v = q['volume'][i]
            if o is None or c is None:
                continue
            ts_ms = timestamps[i] * 1000
            dt = datetime.utcfromtimestamp(timestamps[i]).strftime('%Y-%m-%d')
            rows.append({
                'ts': ts_ms, 'date': dt, 'symbol': ticker,
                'open': f'{o:.2f}', 'high': f'{h:.2f}', 'low': f'{l:.2f}', 'close': f'{c:.2f}',
                'volume': f'{v:.0f}', 'volume_usd': f'{c * v:.2f}', 'trades': '0'
            })
        return rows
    except Exception as e:
        print(f'  Yahoo failed for {ticker}: {e}')
        return None

def fetch_twelvedata(ticker):
    """Fetch daily data from Twelve Data API."""
    url = f'https://api.twelvedata.com/time_series?symbol={ticker}&interval=1day&outputsize=5000&apikey={TWELVEDATA_KEY}'
    try:
        resp = urllib.request.urlopen(url, timeout=30)
        data = json.loads(resp.read())
        if 'values' not in data:
            print(f'  TwelveData error for {ticker}: {data.get("message", "unknown")}')
            return None
        rows = []
        for v in data['values']:
            dt = v['datetime']
            ts_ms = int(datetime.strptime(dt, '%Y-%m-%d').timestamp() * 1000)
            o, h, l, c = float(v['open']), float(v['high']), float(v['low']), float(v['close'])
            vol = float(v.get('volume', 0))
            rows.append({
                'ts': ts_ms, 'date': dt, 'symbol': ticker,
                'open': f'{o:.2f}', 'high': f'{h:.2f}', 'low': f'{l:.2f}', 'close': f'{c:.2f}',
                'volume': f'{vol:.0f}', 'volume_usd': f'{c * vol:.2f}', 'trades': '0'
            })
        return rows
    except Exception as e:
        print(f'  TwelveData failed for {ticker}: {e}')
        return None

def save_csv(ticker, rows):
    """Save rows as CSV in the standard backtest format (newest first)."""
    # Sort descending by date
    rows.sort(key=lambda r: r['date'], reverse=True)
    filepath = os.path.join(DATA_DIR, f'{ticker}_daily.csv')
    with open(filepath, 'w') as f:
        f.write('https://www.CryptoDataDownload.com\n')
        f.write(f'Unix,Date,Symbol,Open,High,Low,Close,Volume {ticker},Volume USDT,tradecount\n')
        for r in rows:
            f.write(f"{r['ts']},{r['date']},{r['symbol']},{r['open']},{r['high']},{r['low']},{r['close']},{r['volume']},{r['volume_usd']},{r['trades']}\n")
    return len(rows)

def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    for i, ticker in enumerate(STOCKS):
        print(f'[{i+1}/{len(STOCKS)}] Downloading {ticker}...')

        # Try Yahoo first
        rows = fetch_yahoo(ticker)
        source = 'Yahoo'

        if not rows:
            # Fall back to Twelve Data
            print(f'  Falling back to Twelve Data...')
            rows = fetch_twelvedata(ticker)
            source = 'TwelveData'
            # Rate limit for Twelve Data
            if rows:
                time.sleep(8)  # 8 credits/min limit

        if rows:
            count = save_csv(ticker, rows)
            print(f'  {ticker}: {count} rows saved ({source}) | {rows[-1]["date"]} -> {rows[0]["date"]}')
        else:
            print(f'  {ticker}: FAILED - no data from any source')

        # Small delay between requests
        time.sleep(1)

    print(f'\nDone! Downloaded {len(STOCKS)} stocks to {DATA_DIR}')

if __name__ == '__main__':
    main()
