#!/bin/bash
# Puts the app on the internet through a Cloudflare quick tunnel.
#
#   npm run public        start (or restart) the site
#   npm run public:stop   take the site and the tunnel down
#
# Public visitors get the test market only (test money, simulated machines), each in a private
# session. The real market and the test seller's own API stay owner-only: they answer on
# http://127.0.0.1:3000 from this computer and nowhere else.
#
# The tunnel is started once and left running, so restarting the app keeps the SAME public address.
# The address only changes when the tunnel itself is stopped (npm run public:stop, or a reboot).
# Needs: cloudflared (brew install cloudflared) and .env.local set up. Starts the ANS services if they are not running.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cloudflared >/dev/null || { echo "cloudflared is not installed: brew install cloudflared"; exit 1; }

# The identity services (ANS) must be running. After a restart of the computer they are not: start them,
# keeping their data so the agents registered earlier are still known.
if ! curl -s -o /dev/null --max-time 3 http://127.0.0.1:18081/; then
  [ -x ans/scripts/demo/start.sh ] || { echo "the ANS services are not running and ans/scripts/demo/start.sh is missing (see the README)"; exit 1; }
  echo "starting the identity services…"
  (cd ans && scripts/demo/start.sh --keep >/dev/null)
  for _ in $(seq 1 60); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:18081/v2/admin/ready && break; sleep 1; done
  curl -s -o /dev/null --max-time 3 http://127.0.0.1:18081/ || { echo "the identity services did not start; run ans/scripts/demo/start.sh --keep and look at its output"; exit 1; }
fi

mkdir -p .burn402
LOG=.burn402/tunnel.log
PIDFILE=.burn402/tunnel.pid
HOSTFILE=.burn402/public-host

# An app already serving on port 3000 is replaced (this is how a restart keeps the address).
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "stopping the app that is running on port 3000…"
  # only the process that holds the port: a pattern match on the name could hit an unrelated command
  lsof -ti tcp:3000 -sTCP:LISTEN | xargs kill 2>/dev/null || true
  for _ in $(seq 1 20); do lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
  if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then echo "something else is listening on port 3000: stop it first"; exit 1; fi
fi

echo "building…"
# leftovers of a dev run can name routes that no longer exist and fail the build's type check
rm -rf .next/dev
npm run -s build >/dev/null || { echo "the build failed; run npm run build to see why"; exit 1; }

tunnel_alive() {
  [ -s "$PIDFILE" ] && [ -s "$HOSTFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && ps -o command= -p "$(cat "$PIDFILE")" | grep -q cloudflared
}

if tunnel_alive; then
  HOST=$(cat "$HOSTFILE")
  echo "the tunnel is already up: keeping the same address"
else
  rm -f "$HOSTFILE" "$PIDFILE"
  HOST=""
  # Cloudflare limits how often a free tunnel can be created (it answers 429). Wait and try again rather than give up.
  for attempt in $(seq 1 20); do
    : > "$LOG"
    echo "opening the tunnel…"
    # nohup: the tunnel outlives this window, so the address survives an app restart
    nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 >"$LOG" 2>&1 &
    TUNNEL=$!
    for _ in $(seq 1 45); do
      HOST=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 | sed 's#https://##' || true)
      [ -n "$HOST" ] && break
      kill -0 $TUNNEL 2>/dev/null || break
      sleep 1
    done
    if [ -n "$HOST" ]; then echo "$TUNNEL" > "$PIDFILE"; echo "$HOST" > "$HOSTFILE"; break; fi
    kill $TUNNEL 2>/dev/null || true
    if grep -q "429" "$LOG"; then
      echo "Cloudflare is limiting new tunnels right now (too many were opened recently). Trying again in 90 seconds (attempt $attempt of 20)…"
      sleep 90
    else
      echo "the tunnel did not start:"; tail -5 "$LOG"; exit 1
    fi
  done
  [ -n "$HOST" ] || { echo "Cloudflare is still refusing new tunnels. Try npm run public again in a while."; exit 1; }
fi

echo
echo "  public site:  https://$HOST"
echo "  your own:     http://127.0.0.1:3000   (real market included)"
echo
echo "  Closing this window stops the app; the address stays reserved while the tunnel runs."
echo "  To take everything down: npm run public:stop"
echo

# caffeinate keeps the Mac awake while the site is up
BURN402_PUBLIC_HOSTS="$HOST" BURN402_TEST_SELLER=1 exec caffeinate -i npx next start -H 127.0.0.1
