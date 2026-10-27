#!/bin/bash
# Double-click to install Nelson OS on a Mac.
cd "$(dirname "$0")" || exit 1
echo ""
echo "  Nelson OS setup"
echo ""
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "  Node.js is needed. The download page will open: install the LTS version, then double-click this file again."
    open "https://nodejs.org"
    read -r -p "  Press Enter to close" _
    exit 1
  fi
fi
node scripts/setup.mjs
read -r -p "  Press Enter to close" _
