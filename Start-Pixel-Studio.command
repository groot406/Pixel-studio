#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Pixel Studio needs Node.js 20 or newer. Install it from https://nodejs.org/ and open this file again."
  read -r -p "Press Enter to close. "
  exit 1
fi
node local/start.mjs --open
