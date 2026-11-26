#!/bin/bash
# Takes the public site down: stops the app and the tunnel. The next npm run public gets a new address.
cd "$(dirname "$0")/.."
# only the process that holds the port, and the tunnel this launcher started
lsof -ti tcp:3000 -sTCP:LISTEN | xargs kill 2>/dev/null
if [ -s .burn402/tunnel.pid ]; then kill "$(cat .burn402/tunnel.pid)" 2>/dev/null; fi
rm -f .burn402/tunnel.pid .burn402/public-host
echo "the public site is down"
