#!/usr/bin/env bash
set -euo pipefail

# Build one universal executable for the independent native service modes.
# Preserve the calendar helper's identity and embedded usage descriptions.

here="$(cd "$(dirname "$0")" && pwd)"
sources=("$here/aside-native/"*.swift)
plist="$here/aside-native/Info.plist"
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
out="$here/../dist/aside-native"
sdk_path="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
sdk_version="$(/usr/libexec/PlistBuddy -c 'Print :Version' "$sdk_path/SDKSettings.plist")"
sdk_major="${sdk_version%%.*}"
formatting_define=ASIDE_LEGACY_MAPKIT_FORMATTING
if [[ "$sdk_major" =~ ^[0-9]+$ ]] && [[ "$sdk_major" -ge 26 ]]; then
	formatting_define=ASIDE_MAPKIT_ADDRESS_FORMATTING
fi

mkdir -p "$(dirname "$out")"

# macOS 14 remains the floor. Search always uses MKLocalSearch; SDK 26 adds
# runtime-gated access to the newer MapKit coordinate and address properties.
compile() {
	swiftc \
		-O -parse-as-library \
		-sdk "$sdk_path" \
		-module-cache-path "$tmp/modules-$1" \
		-D "$formatting_define" \
		-target "$1-apple-macosx14.0" \
		-framework AppKit -framework EventKit -framework MapKit \
		-framework CoreLocation -framework Contacts -framework Foundation \
		-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist" \
		-o "$2" \
		"${sources[@]}"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
compile arm64 "$tmp/arm64"
compile x86_64 "$tmp/x86_64"
lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$out"

# Keep the existing calendar identifier. Ad-hoc code changes can still require
# a renewed calendar grant; Developer ID signing belongs to release packaging.
codesign --force --sign - --identifier "$bundle_id" "$out"

# Remove obsolete build outputs only after the replacement built successfully.
rm -f "$here/../dist/aside-cal" "$here/../dist/aside-geo" "$here/../dist/aside-wake"

echo "built $out ($(lipo -archs "$out"))"
