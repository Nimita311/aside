#!/usr/bin/env bash
set -euo pipefail

# Compile and ad-hoc sign the aside-cal EventKit helper. The embedded
# Info.plist gives it a stable bundle identifier and the calendar usage
# descriptions TCC requires. Release signing (Developer ID) is a later
# packaging pass — see cli/calendar-impl.md.

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/aside-cal/main.swift"
plist="$here/aside-cal/Info.plist"
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
out="$here/../dist/aside-cal"

mkdir -p "$(dirname "$out")"

# macOS 14 is the floor: full calendar access (read-back) lands in EventKit
# there. Build both arches and lipo them so the binary matches what release
# ships, regardless of the host.
compile() {
	swiftc \
		-O \
		-target "$1-apple-macosx14.0" \
		-framework EventKit -framework Foundation \
		-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist" \
		-o "$2" \
		"$src"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
compile arm64 "$tmp/arm64"
compile x86_64 "$tmp/x86_64"
lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$out"

# Ad-hoc signature with a fixed identifier so the embedded plist is honored and
# TCC can prompt. A Developer-ID signature (stable grant) comes with release.
codesign --force --sign - --identifier "$bundle_id" "$out"

echo "built $out ($(lipo -archs "$out"))"
