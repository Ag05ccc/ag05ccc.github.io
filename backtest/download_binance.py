#!/usr/bin/env python3
"""Download daily candles from Binance API for newer coins"""
import json, urllib.request, sys, os
from datetime import datetime

PAIRS = {
    'APT': 'APTUSDT',
    'ARB': 'ARBUSDT',
    'OP': 'OPUSDT',
    'SUI': 'SUIUSDT',
}

data_dir = os.path.join(os.path.dirname(__file__), 'data')

for sym, pair in PAIRS.items():
    url = f'https://api.binance.com/api/v3/klines?symbol={pair}&interval=1d&limit=1000'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req)
        data = json.loads(resp.read())

        if not isinstance(data, list) or len(data) == 0:
            print(f'{sym}: No data - {str(data)[:100]}')
            continue

        lines = ['https://www.CryptoDataDownload.com']
        lines.append(f'Unix,Date,Symbol,Open,High,Low,Close,Volume {sym},Volume USDT,tradecount')

        for k in data:
            dt = datetime.fromtimestamp(k[0]/1000).strftime('%Y-%m-%d')
            line = f'{k[0]},{dt},{pair},{k[1]},{k[2]},{k[3]},{k[4]},{k[5]},{k[7]},{k[8]}'
            lines.append(line)

        outfile = os.path.join(data_dir, f'{sym}_daily.csv')
        with open(outfile, 'w') as f:
            f.write('\n'.join(lines))

        first = datetime.fromtimestamp(data[0][0]/1000).strftime('%Y-%m-%d')
        last = datetime.fromtimestamp(data[-1][0]/1000).strftime('%Y-%m-%d')
        print(f'{sym}: {len(data)} candles ({first} -> {last})')
    except Exception as e:
        print(f'{sym}: ERROR - {e}')
