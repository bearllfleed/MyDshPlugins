/**
 * Effective Host configuration.
 *
 * The plugin deliberately does not export a schemastery `Config`: the bundle is
 * installed through a `link:` dependency, so the Host half only sees a plain
 * object from `cordis.patch.yml`. Defaults are applied here and every numeric
 * field is clamped so a hand-edited patch file cannot make the plugin scan a
 * whole filesystem or poll faster than once a second.
 */
import { isAbsolute } from 'node:path';
import { clampInt } from './util.js';

/** Values used when the patch file omits a field or supplies garbage. */
export const DEFAULT_CONFIG = Object.freeze({
  scanDepth: 5,
  statusPollMs: 3000,
  networkTimeoutMs: 60000,
  pullStrategy: 'merge',
  autoRepositoryDetection: 'true',
  roots: Object.freeze([]),
});

/** Accepted pull strategies (mirrors the Client's settings select). */
export const PULL_STRATEGIES = Object.freeze(['merge', 'rebase', 'ff-only']);
/** Accepted repository detection modes. */
export const DETECTION_MODES = Object.freeze(['true', 'false', 'subFolders']);

/**
 * Normalise the detection mode: the Client stores `true`/`false`/`subFolders`,
 * a YAML patch file may supply real booleans, and anything else means "on".
 * @param {unknown} value - candidate mode.
 * @returns {'true' | 'false' | 'subFolders'}
 */
function normalizeDetection(value) {
  if (value === false || value === 'false') return 'false';
  if (value === true || value === 'true') return 'true';
  if (typeof value === 'string' && value.toLowerCase() === 'subfolders') return 'subFolders';
  return 'true';
}

/**
 * Normalise the scan-root list. Accepts an array of absolute paths or a
 * comma/newline separated string, deduplicates and drops non-absolute entries.
 * @param {unknown} value - candidate roots.
 * @returns {string[]}
 */
function normalizeRoots(value) {
  const candidates = [];
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === 'string') candidates.push(item);
  } else if (typeof value === 'string') {
    for (const item of value.split(/[\n,]/)) candidates.push(item);
  }
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === '' || !isAbsolute(trimmed) || trimmed.includes('\0')) continue;
    const key = trimmed.replace(/\/+$/, '') || '/';
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(key);
  }
  return roots;
}

/**
 * Merge a raw patch-file config over the defaults and clamp every field.
 * @param {unknown} raw - the object `apply(ctx, rawConfig)` received.
 * @returns {{ scanDepth: number, statusPollMs: number, networkTimeoutMs: number, pullStrategy: string, autoRepositoryDetection: string, roots: string[] }}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const strategy = typeof source.pullStrategy === 'string' ? source.pullStrategy : '';
  return {
    scanDepth: clampInt(source.scanDepth, 1, 10, DEFAULT_CONFIG.scanDepth),
    statusPollMs: clampInt(source.statusPollMs, 1000, 60000, DEFAULT_CONFIG.statusPollMs),
    networkTimeoutMs: clampInt(source.networkTimeoutMs, 5000, 600000, DEFAULT_CONFIG.networkTimeoutMs),
    pullStrategy: PULL_STRATEGIES.includes(strategy) ? strategy : DEFAULT_CONFIG.pullStrategy,
    autoRepositoryDetection: normalizeDetection(source.autoRepositoryDetection),
    roots: normalizeRoots(source.roots),
  };
}

/**
 * The configuration handle `apply` keeps for the life of the plugin fiber.
 * @param {unknown} rawConfig - the patch-file config.
 * @returns {{ get: () => object, reload: (next: unknown) => object }}
 */
export function createConfig(rawConfig) {
  let current = normalizeConfig(rawConfig);
  return {
    /** @returns {object} a defensive copy of the effective configuration. */
    get() {
      return { ...current, roots: [...current.roots] };
    },
    /**
     * Replace the effective configuration (used by tests and future reloads).
     * @param {unknown} next - the new raw config.
     * @returns {object} the newly effective configuration.
     */
    reload(next) {
      current = normalizeConfig(next);
      return this.get();
    },
  };
}

/**
 * Read the effective config from either the handle or a bare object.
 * @param {unknown} config - a config handle, a plain config object, or nothing.
 * @returns {object} the effective configuration.
 */
export function effectiveConfig(config) {
  if (config !== null && typeof config === 'object' && typeof config.get === 'function') return config.get();
  if (config !== null && typeof config === 'object') return normalizeConfig(config);
  return normalizeConfig(undefined);
}
