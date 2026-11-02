// The Aside software version. Keep in sync with package.json and plugin manifests.
// New instances record this in their manifest.
export const VERSION = '0.1.0';

// When this bundle was built, stamped by build.mjs. Orders builds: a client
// replaces a daemon from an older build. Unbundled source (tests) reads 0 and
// so never counts as newer.
declare const __ASIDE_BUILT_AT__: number | undefined;
export const BUILT_AT: number = typeof __ASIDE_BUILT_AT__ === 'number' ? __ASIDE_BUILT_AT__ : 0;
