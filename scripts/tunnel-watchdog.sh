#!/bin/bash
# Closes the tunnel when the app it serves has been gone for a while, so the public address never ends
# up pointing at whatever else starts on the port. A restart (npm run public) brings the app back well
# inside the grace period, which is how the address survives it.
#
#   tunnel-watchdog.sh <tunnel pid> <app pid file> [grace seconds] [files to remove when the tunnel is closed...]
TUNNEL=$1
APP_PID_FILE=$2
GRACE=${3:-180}
shift 3 2>/dev/null || shift $#
gone=0
while kill -0 "$TUNNEL" 2>/dev/null; do
  sleep 5
  if [ -s "$APP_PID_FILE" ] && kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then gone=0; else gone=$((gone + 5)); fi
  if [ "$gone" -ge "$GRACE" ]; then
    kill "$TUNNEL" 2>/dev/null
    rm -f "$@"
    exit 0
  fi
done
