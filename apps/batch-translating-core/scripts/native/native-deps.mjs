/**
 * Native dependency registry.
 *
 * Batch Translating's SEA binary ships no third-party native (.node) modules:
 * the translation engine's native surface is limited to MiniDb's text-build
 * worker (a plain Node worker, no native code). The registry below is kept for
 * the build tooling contract (targets + resolution) and is intentionally empty.
 */

export const SUPPORTED_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

export function isSupportedTarget(target) {
  return SUPPORTED_TARGETS.includes(target);
}

/**
 * @typedef {Object} NativeDepDescriptor
 * @property {string} id                 — stable internal id used for parent refs
 * @property {(target: string) => string} name
 *           — npm package name (may depend on target)
 * @property {'js-only'|'native-files'|'js-and-native-file'|'native-file-only'|'virtual'} collect
 * @property {string|null} parent
 *           — id of another registered dep this nests under (for pnpm),
 *           or null for top-level (resolvable from app root)
 * @property {(target: string) => string[]} [nativeFileRelatives]
 *           — explicit list of .node files relative to package root
 *           (used by 'js-and-native-file' and 'native-file-only';
 *           native-files mode auto-scans *.node). 'native-file-only' collects
 *           package.json + these .node files but skips the package entry JS.
 */

/** @type {readonly NativeDepDescriptor[]} */
export const nativeDeps = Object.freeze([]);

/**
 * Resolve which deps need collecting for a given build target, with concrete names.
 */
export function resolveTargetDeps(target) {
  if (!isSupportedTarget(target)) {
    throw new Error(`Unsupported native asset target: ${target}`);
  }
  return nativeDeps
    .filter((d) => d.collect !== 'virtual')
    .map((d) => ({
      ...d,
      resolvedName: d.name(target),
      nativeFileRelatives: d.nativeFileRelatives?.(target) ?? [],
      parentName: d.parent ? nativeDeps.find((p) => p.id === d.parent)?.name(target) ?? null : null,
    }));
}
