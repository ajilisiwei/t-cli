#!/usr/bin/env bash
# Render avatar.svg to the PNGs the WeChat registration form takes.
# Needs Google Chrome (renders the SVG with the system Songti SC font) and
# ImageMagick (`magick`). Usage: docs/miniprogram-registration/render-avatar.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A bare page so the screenshot is exactly the 1024x1024 SVG, nothing else.
cat > "$TMP/page.html" <<EOF
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden}img{display:block;width:1024px;height:1024px}</style>
<img src="file://$DIR/avatar.svg">
EOF

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1024,1024 --screenshot="$TMP/raw.png" "file://$TMP/page.html" >/dev/null 2>&1

magick "$TMP/raw.png" -crop 1024x1024+0+0 +repage -strip "$DIR/avatar-1024.png"
magick "$DIR/avatar-1024.png" -filter Lanczos -resize 144x144 -strip "$DIR/avatar-144.png"

magick identify -format '%f %wx%h %b\n' "$DIR/avatar-1024.png" "$DIR/avatar-144.png"
