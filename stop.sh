#!/bin/bash
# Gracefully stop the Discord bot using SIGTERM

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/bot.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found — bot may not be running."
    echo "Checking for orphan node processes..."
    # Try to find it anyway
    PIDS=$(pgrep -f "node src/index.js" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "Found running bot process(es): $PIDS"
        kill $PIDS 2>/dev/null
        echo "Sent SIGTERM to orphan process(es)"
    else
        echo "No bot processes found."
    fi
    exit 0
fi

BOT_PID=$(cat "$PID_FILE")

if kill -0 "$BOT_PID" 2>/dev/null; then
    echo "Stopping bot (PID $BOT_PID)..."
    kill "$BOT_PID"

    # Wait up to 10 seconds for graceful shutdown
    for i in $(seq 1 10); do
        if ! kill -0 "$BOT_PID" 2>/dev/null; then
            echo "Bot stopped gracefully."
            rm -f "$PID_FILE"
            exit 0
        fi
        sleep 1
    done

    # Force kill if still running
    echo "Bot didn't stop in time, forcing..."
    kill -9 "$BOT_PID" 2>/dev/null
    echo "Bot force-killed."
else
    echo "Bot is not running (stale PID $BOT_PID)."
fi

rm -f "$PID_FILE"
