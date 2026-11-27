#!/bin/bash
# Puts the app on the internet through a Cloudflare quick tunnel.
#
#   npm run public        start (or restart) the site
#   npm run public -- --real   the same, and visitors may rent real machines from their own wallets
#   npm run public:stop   take the site and the tunnel down
#
# Public visitors get the test market only (test money, simulated machines), each in a private
# session. The real market and the test seller's own API stay owner-only: they answer on
# http://127.0.0.1:3000 from this computer and nowhere else.
#
# The tunnel is started once and reused, so restarting the app keeps the SAME public address. A watchdog
# closes the tunnel three minutes after the app is gone, so the address never points at anything else
# that starts on the port. The address changes after that, after npm run public:stop, or after a reboot.
# Needs: cloudflared (brew install cloudflared) and .env.local set up. Starts the ANS services if they are not running.
set -euo pipefail
cd "$(dirname "$0")/.."

# --real: visitors may also rent REAL machines, paying from their own wallets (never yours). Off unless asked for:
# the machines are rented under this app's agent identity, and a visitor gets full control of theirs.
PUBLIC_REAL=0
for arg in "$@"; do
  case "$arg" in
    --real) PUBLIC_REAL=1 ;;
    *) echo "unknown option: $arg (the only option is --real)"; exit 1 ;;
  esac
done
# Visitors' real rentals are signed by an agent key of their own, never by yours: without one, --real is refused.
if [ "$PUBLIC_REAL" = "1" ] && ! grep -Eq '^PUBLIC_MAINNET_SOLANA_SECRET_KEY=.{32,}' .env.local 2>/dev/null; then
  echo "--real needs PUBLIC_MAINNET_SOLANA_SECRET_KEY in .env.local: a separate agent wallet for visitors (see env.example)."
  echo "Without it, strangers' machines would be rented under your own wallet. Nothing was started."
  exit 1
fi

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
APPFILE=.burn402/app.pid
WATCHFILE=.burn402/watchdog.pid
GRACE=180

# This app already serving on port 3000 is replaced (this is how a restart keeps the address). Anything
# else on the port is left alone: it is not ours to stop, and the tunnel must never point at it.
LISTENER=$(lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | head -1 || true)
if [ -n "$LISTENER" ]; then
  LISTENER_DIR=$(lsof -a -p "$LISTENER" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  if [ "$LISTENER_DIR" != "$PWD" ] || ! ps -o command= -p "$LISTENER" | grep -q "next"; then
    echo "another program is using port 3000 (pid $LISTENER). Stop it first: the public address must only ever reach this app."
    exit 1
  fi
  echo "stopping the app that is running on port 3000…"
  kill "$LISTENER" 2>/dev/null || true
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

# A free tunnel that lost its connection for long enough is forgotten by Cloudflare: the program keeps
# running and retrying, but the address is gone for good ("Tunnel not found" in its log, on every retry).
tunnel_forgotten() {
  tail -n 6 "$LOG" 2>/dev/null | grep -q "Tunnel not found"
}

if tunnel_alive && tunnel_forgotten; then
  echo "Cloudflare dropped the old tunnel (its address no longer works): opening a new one, with a new address"
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  [ -s "$WATCHFILE" ] && kill "$(cat "$WATCHFILE")" 2>/dev/null || true
  rm -f "$WATCHFILE"
  sleep 1
fi

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
    if [ -n "$HOST" ]; then echo "$TUNNEL" > "$PIDFILE"; echo "$HOST" > "$HOSTFILE"; rm -f "$WATCHFILE"; break; fi
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
if [ "$PUBLIC_REAL" = "1" ]; then
  echo "  REAL MARKET OPEN TO VISITORS: they rent real machines, paid from their own wallets."
else
  echo "  visitors:     test market only (start with: npm run public -- --real to let them rent real machines from their own wallets)"
fi
echo
echo "  Closing this window stops the app. The tunnel closes by itself $((GRACE / 60)) minutes later;"
echo "  start again within that time (npm run public) to keep the same address."
echo "  To take everything down now: npm run public:stop"
echo

# The app runs as this very process (exec below), so its pid is known now. The watchdog closes the tunnel
# when that pid has been gone for $GRACE seconds; one watchdog per tunnel.
echo $$ > "$APPFILE"
if ! { [ -s "$WATCHFILE" ] && kill -0 "$(cat "$WATCHFILE")" 2>/dev/null; }; then
  nohup bash scripts/tunnel-watchdog.sh "$(cat "$PIDFILE")" "$APPFILE" "$GRACE" "$PIDFILE" "$HOSTFILE" "$WATCHFILE" >/dev/null 2>&1 &
  echo $! > "$WATCHFILE"
fi

# caffeinate keeps the Mac awake while the site is up
# The owner key: while the site is public, a request counts as yours only if it carries this key. Looking
# local is not enough (a proxy can make anyone look local). It is made fresh for every start and kept in a
# file only you can read (scripts use it). Your browser gets it from the link below, which carries a
# one-time code, not the key: the link works once and is worth nothing afterwards.
OWNER_TOKEN="$(openssl rand -hex 32)"
OWNER_ENTRY="$(openssl rand -hex 32)"
OWNER_FILE=.burn402/owner-token
( umask 077; printf '%s\n' "$OWNER_TOKEN" > "$OWNER_FILE" )
OWNER_LINK="http://127.0.0.1:3000/api/owner?token=$OWNER_ENTRY"
echo "  Your own page opens by itself in a moment. If it does not, open this link once (it gives this browser your owner key):"
echo "  $OWNER_LINK"
echo "  For another browser, or after clearing cookies: run npm run public again (the public address stays the same)."
echo
# Opens once this app answers, and only then: if the app failed to start, the link is not sent to whatever else
# may be listening. The app itself replaces this shell just below.
( for _ in $(seq 1 90); do
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/api/demo/state; then open "$OWNER_LINK" >/dev/null 2>&1; break; fi
    sleep 1
  done ) &

# session cookies are signed with a key made fresh for this launch (sessions live in memory, so nothing is lost)
BURN402_OWNER_TOKEN="$OWNER_TOKEN" BURN402_OWNER_ENTRY="$OWNER_ENTRY" BURN402_PUBLIC_REAL="$PUBLIC_REAL" BURN402_SESSION_SECRET="$(openssl rand -hex 32)" BURN402_PUBLIC_HOSTS="$HOST" BURN402_TEST_SELLER=1 exec caffeinate -i npx next start -H 127.0.0.1
