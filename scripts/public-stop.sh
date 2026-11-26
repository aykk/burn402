#!/bin/bash
# Takes the public site down: stops the app and the tunnel. The next npm run public gets a new address.
cd "$(dirname "$0")/.."
# the tunnel first, so the address stops reaching anything; then this app, by the pid the launcher recorded
if [ -s .burn402/tunnel.pid ]; then kill "$(cat .burn402/tunnel.pid)" 2>/dev/null; fi
if [ -s .burn402/watchdog.pid ]; then kill "$(cat .burn402/watchdog.pid)" 2>/dev/null; fi
if [ -s .burn402/app.pid ]; then kill "$(cat .burn402/app.pid)" 2>/dev/null; fi
rm -f .burn402/tunnel.pid .burn402/public-host .burn402/watchdog.pid .burn402/app.pid
echo "the public site is down"
