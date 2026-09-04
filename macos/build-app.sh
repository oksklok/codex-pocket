#!/bin/zsh

set -eu

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_path="$root_dir/macos/CodexPocketHost.swift"
icon_source_path="$root_dir/macos/PocketIconRenderer.swift"
executable_path="$root_dir/Codex Pocket.app/Contents/MacOS/Codex Pocket"
resources_dir="$root_dir/Codex Pocket.app/Contents/Resources"

sdk_args=()
compatible_sdk="/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk"
if [[ -d "$compatible_sdk" ]]; then
  sdk_args=(-sdk "$compatible_sdk")
fi

xcrun swiftc -swift-version 5 "${sdk_args[@]}" -O -framework AppKit -framework Foundation -framework ServiceManagement "$source_path" -o "$executable_path"
mkdir -p "$resources_dir"
icon_work_dir="$(mktemp -d)"
trap 'rm -rf "$icon_work_dir"' EXIT
icon_renderer="$icon_work_dir/render-pocket-icon"
icon_base="$icon_work_dir/icon-1024.png"
iconset="$icon_work_dir/CodexPocket.iconset"
xcrun swiftc -swift-version 5 "${sdk_args[@]}" -O -framework AppKit -framework Foundation "$icon_source_path" -o "$icon_renderer"
"$icon_renderer" "$icon_base"
mkdir -p "$iconset"
for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" "32 icon_32x32.png" "64 icon_32x32@2x.png" "128 icon_128x128.png" "256 icon_128x128@2x.png" "256 icon_256x256.png" "512 icon_256x256@2x.png" "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do
  pixels="${spec%% *}"
  name="${spec#* }"
  sips -z "$pixels" "$pixels" "$icon_base" --out "$iconset/$name" >/dev/null
done
iconutil -c icns "$iconset" -o "$resources_dir/CodexPocket.icns"
chmod +x "$executable_path"
echo "Built $executable_path"
