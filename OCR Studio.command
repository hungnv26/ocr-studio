#!/bin/zsh
# Double-click in Finder to start OCR Studio and open it in your browser.
cd "$(dirname "$0")"
[ -d node_modules/@alibaba-group ] || npm install --no-fund --no-audit
exec node server/index.js
