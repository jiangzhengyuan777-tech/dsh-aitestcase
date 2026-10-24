// Single in-package version constant for runtime self-checks.
//
// package.json is the source of truth; test/version.test.js fails if this
// drifts. It exists because the browser half cannot read package.json and the
// host status tool should be able to print the exact loaded version without a
// filesystem read on every call.

export const PLUGIN_VERSION = '1.1.0'
