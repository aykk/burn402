#!/bin/bash
# Closes the tunnel when the app it serves is gone, so the public address never ends up pointing at
# whatever else starts on the port.
#  - The app has been gone for the grace period: close the tunnel. A restart (npm run public) brings the
#    app back well inside it, which is how the address survives a restart.
#  - Something that is NOT the app is listening on the port (a dev server started in the meantime):
#    close the tunnel at once, without waiting.
#
#   tunnel-watchdog.sh <tunnel pid> <app pid file> [grace seconds] [files to remove when the tunnel is closed...]
TUNNEL=$1
APP_PID_FILE=$2
GRACE=${3:-180}
PORT=3000
shift 3 2>/dev/null || shift $#

# True when process $1 is $2 or one of its descendants (the app runs as a child of the recorded pid).
descends_from() {
  local pid=$1 root=$2 hops=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$hops" -lt 12 ]; do
    [ "$pid" = "$root" ] && return 0
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    hops=$((hops + 1))
  done
  return 1
}

# True when the port is held by a process that does not belong to the recorded app.
foreign_listener() {
  local app listener
  app=$(cat "$APP_PID_FILE" 2>/dev/null)
  for listener in $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null); do
    if [ -z "$app" ] || ! descends_from "$listener" "$app"; then return 0; fi
  done
  return 1
}

close_tunnel() {
  kill "$TUNNEL" 2>/dev/null
  rm -f "$@"
  exit 0
}

gone=0
while kill -0 "$TUNNEL" 2>/dev/null; do
  sleep 5
  if [ -s "$APP_PID_FILE" ] && kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then gone=0; else gone=$((gone + 5)); fi
  # two looks in a row, so the moment between the old app stopping and the new one recording its pid is not mistaken for a stranger
  if foreign_listener; then sleep 5; if foreign_listener; then close_tunnel "$@"; fi; fi
  if [ "$gone" -ge "$GRACE" ]; then close_tunnel "$@"; fi
done
