#!/bin/bash
# Start the Discord bot and save its PID for clean shutdown

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/bot.pid"

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Bot is already running (PID $OLD_PID)"
        exit 1
    else
        echo "Stale PID file found, cleaning up..."
        rm -f "$PID_FILE"
    fi
fi

cd "$SCRIPT_DIR"
echo "Starting bot..."
node src/index.js &
BOT_PID=$!
echo "$BOT_PID" > "$PID_FILE"
echo "Bot started (PID $BOT_PID)"
echo "Use ./stop.sh to shut it down"
