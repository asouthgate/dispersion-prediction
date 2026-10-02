// No-op shim for Node built-ins (fs, path, crypto) referenced by
// @ngageoint/geopackage only in Node-only code paths. Never invoked in browser.
const shim: Record<string, unknown> = {};
export default shim;
