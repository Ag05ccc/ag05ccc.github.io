#!/bin/bash
echo "================================"
echo "  TradeSimBot Trading Simulator"
echo "================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Install with:"
    echo "  sudo apt-get update && sudo apt-get install -y nodejs npm"
    exit 1
fi

# Install dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Starting server..."
echo ""
node server.js
