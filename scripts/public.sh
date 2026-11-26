#!/bin/bash
# Puts the app on the internet through a Cloudflare quick tunnel.
#
#   npm run public
#
# Public visitors get the test market only (test money, simulated machines), each in a private
# session. The real market and the test seller's own API stay owner-only: they
# answer on http://127.0.0.1:3000 from this computer and nowhere else.
# The site is up while this script runs. The address is new every time (a quick tunnel has no fixed name).
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
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then echo "something is already listening on port 3000: stop it first (npm run dev?)"; exit 1; fi

mkdir -p .burn402
LOG=.burn402/tunnel.log
: > "$LOG"

echo "building…"
# leftovers of a dev run can name routes that no longer exist and fail the build's type check
rm -rf .next/dev
npm run -s build >/dev/null || { echo "the build failed; run npm run build to see why"; exit 1; }

echo "opening the tunnel…"
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 >"$LOG" 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null || true' EXIT INT TERM

HOST=""
for _ in $(seq 1 60); do
  HOST=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 | sed 's#https://##' || true)
  [ -n "$HOST" ] && break
  kill -0 $TUNNEL 2>/dev/null || { echo "the tunnel stopped:"; tail -5 "$LOG"; exit 1; }
  sleep 1
done
[ -n "$HOST" ] || { echo "the tunnel gave no address:"; tail -5 "$LOG"; exit 1; }

echo
echo "  public site:  https://$HOST"
echo "  your own:     http://127.0.0.1:3000   (real market included)"
echo
echo "$HOST" > .burn402/public-host

# caffeinate keeps the Mac awake while the site is up
BURN402_PUBLIC_HOSTS="$HOST" BURN402_TEST_SELLER=1 exec caffeinate -i npx next start -H 127.0.0.1
