#!/bin/zsh

set -eu

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_path="$root_dir/macos/CodexPocketHost.swift"
executable_path="$root_dir/Codex Pocket.app/Contents/MacOS/Codex Pocket"

sdk_args=()
compatible_sdk="/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk"
if [[ -d "$compatible_sdk" ]]; then
  sdk_args=(-sdk "$compatible_sdk")
fi

xcrun swiftc -swift-version 5 "${sdk_args[@]}" -O -framework AppKit -framework Foundation "$source_path" -o "$executable_path"
chmod +x "$executable_path"
echo "Built $executable_path"
