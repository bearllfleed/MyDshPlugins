/**
 * Repository discovery and path validation for the dsh-git Host half.
 *
 * Discovery walks a bounded breadth-first tree from the Client's scan roots,
 * stopping at the first `.git` it meets so a monorepo full of nested checkouts
 * is not traversed twice. Results are cached briefly because the Client polls
 * `repos.list` while the user switches between worktrees.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { gitError, shortError, normalizeRepoRelativePath } from './util.js';
import { runGit } from './exec.js';
import { countChanged, tryReadStatus } from './status.js';

/** Directory names never descended into (build output, caches, vendor trees). */
export const SKIPPED_DIRECTORIES = Object.freeze([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  '.venv',
  '__pycache__',
  '.next',
  '.cache',
  '.git',
  'Library',
  '.Trash',
]);

/** Hard ceiling on repositories returned by one discovery pass. */
export const MAX_REPOSITORIES = 200;
/**
 * Hard ceiling on directories inspected by one discovery pass. Descending
 * through a repository (needed to find the checkouts nested inside an opened
 * workspace) can reach far more directories than a plain repository scan, so the
 * walk stops here instead of turning a huge tree into a multi-second freeze.
 */
export const MAX_SCANNED_DIRECTORIES = 5000;
/** How long a discovery result stays fresh, in milliseconds. */
export const DISCOVERY_TTL_MS = 10000;
/**
 * Depth budget for a sibling root (the directory that holds a registered
 * workspace). Discovery only needs to spot the checkouts sitting next to a
 * workspace, so a sibling root never receives the full scan depth — otherwise
 * a workspace registered directly under $HOME would walk the whole home tree.
 */
export const SHALLOW_ROOT_DEPTH = 2;
/** Directory names probed for a one-click scan suggestion when nothing is found. */
export const SUGGESTED_ROOT_NAMES = Object.freeze([
  'workspace',
  'workspaces',
  'projects',
  'code',
  'dev',
  'src',
  'repos',
  'git',
  'Documents',
  'Desktop',
]);
/** How deep a suggestion probe looks, and how many suggestions it returns. */
const SUGGESTION_DEPTH = 2;
const SUGGESTION_LIMIT = 4;
/** How long a suggestion probe result stays fresh, in milliseconds. */
const SUGGESTION_TTL_MS = 60000;
/** @type {Map<string, { at: number, suggestions: { path: string, count: number }[] }>} */
const suggestionCache = new Map();

/** How many repositories are inspected concurrently. */
const INSPECTION_CONCURRENCY = 4;
/** Per-repository budget while inspecting discovery candidates. */
const INSPECTION_TIMEOUT_MS = 8000;

/** @type {Map<string, { at: number, repositories: object[], truncated: boolean }>} */
const discoveryCache = new Map();

/** Drop every cached discovery result (called after any repository mutation). */
export function invalidateDiscoveryCache() {
  discoveryCache.clear();
}

/**
 * @param {string} path - candidate directory.
 * @returns {Promise<boolean>} whether it exists and is a directory.
 */
async function isDirectory(path) {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inspect a directory for git metadata without running git.
 * @param {string} path - directory to inspect.
 * @returns {Promise<{ kind: 'repo' | 'worktree' | 'bare' } | null>}
 */
export async function detectRepositoryKind(path) {
  try {
    const gitEntry = await stat(join(path, '.git'));
    if (gitEntry.isFile()) return { kind: 'worktree' };
    if (gitEntry.isDirectory()) {
      // A linked worktree records the shared git directory in `.git/commondir`.
      try {
        const common = await readFile(join(path, '.git', 'commondir'), 'utf8');
        if (common.trim() !== '') return { kind: 'worktree' };
      } catch {
        // No commondir: an ordinary repository.
      }
      return { kind: 'repo' };
    }
    return null;
  } catch {
    // Fall through to the bare-repository probe.
  }
  try {
    const head = await stat(join(path, 'HEAD'));
    const objects = await stat(join(path, 'objects'));
    const refs = await stat(join(path, 'refs'));
    if (head.isFile() && objects.isDirectory() && refs.isDirectory()) return { kind: 'bare' };
  } catch {
    return null;
  }
  return null;
}

/**
 * Validate a Client-supplied repository path.
 *
 * The path must be absolute, free of `..` segments, exist, and contain git
 * metadata. Traversal is rejected before the filesystem is touched so a crafted
 * request cannot probe outside the user's home directory.
 * @param {unknown} value - candidate path.
 * @returns {Promise<{ path: string, kind: 'repo' | 'worktree' | 'bare' }>}
 * @throws {GitError} E_INVALID_ARG for a malformed path, E_NOT_REPO for a non-repository.
 */
export async function assertRepo(value) {
  if (typeof value !== 'string') throw gitError('E_INVALID_ARG', 'repo must be a string');
  if (value.includes('\0')) throw gitError('E_INVALID_ARG', 'repo must not contain NUL bytes');
  const trimmed = value.trim();
  if (trimmed === '') throw gitError('E_INVALID_ARG', 'repo must not be empty');
  if (!isAbsolute(trimmed)) throw gitError('E_INVALID_ARG', 'repo must be an absolute path');
  const segments = trimmed.split(/[\\/]+/);
  if (segments.includes('..')) throw gitError('E_INVALID_ARG', 'repo must not contain ..');
  const resolved = resolve(trimmed);
  const info = await stat(resolved).catch(() => null);
  if (info === null) throw gitError('E_NOT_REPO', 'repository path does not exist');
  if (!info.isDirectory()) throw gitError('E_INVALID_ARG', 'repo must be a directory');
  const detected = await detectRepositoryKind(resolved);
  if (detected === null) throw gitError('E_NOT_REPO', 'directory is not a git repository');
  return { path: resolved, kind: detected.kind };
}

/**
 * Resolve one repository-relative path against a validated repository root.
 * @param {string} repoPath - the validated repository path.
 * @param {unknown} value - repository-relative path.
 * @returns {string} the repository-relative path, normalised.
 */
export function repoRelative(repoPath, value) {
  const relative = normalizeRepoRelativePath(value);
  const absolute = resolve(repoPath, relative);
  const prefix = repoPath.endsWith(sep) ? repoPath : `${repoPath}${sep}`;
  if (absolute !== repoPath && !absolute.startsWith(prefix)) {
    throw gitError('E_INVALID_ARG', 'path must stay inside the repository');
  }
  return relative;
}

/**
 * Read the `RepoInfo` for a discovered candidate.
 * @param {string} repoPath - absolute path.
 * @param {'repo' | 'worktree' | 'bare'} kind - detected kind.
 * @param {{ ctx?: unknown, timeoutMs?: number }} options - transport options.
 * @returns {Promise<object>} a `RepoInfo`.
 */
async function readRepoInfo(repoPath, kind, options) {
  const baseName = basename(repoPath) || repoPath;
  const info = {
    path: repoPath,
    name: baseName,
    displayName: baseName.endsWith('.git') ? baseName.slice(0, -4) : baseName,
    kind,
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    ahead: 0,
    behind: 0,
    changed: 0,
  };
  if (kind === 'bare') {
    try {
      const headResult = await runGit(repoPath, ['rev-parse', 'HEAD'], { ctx: options.ctx, timeoutMs: options.timeoutMs });
      const head = headResult.stdout.trim();
      if (head !== '') info.head = head;
      const branchResult = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        ctx: options.ctx,
        timeoutMs: options.timeoutMs,
      });
      const branch = branchResult.stdout.trim();
      if (branch !== '' && branch !== 'HEAD') info.branch = branch;
      else if (head === '') info.unborn = true;
    } catch (error) {
      info.error = shortError(error);
    }
    return info;
  }
  const { status, error } = await tryReadStatus(repoPath, options);
  if (status === null) {
    info.error = error ?? 'unable to read repository status';
    return info;
  }
  info.branch = status.branch;
  info.detached = status.detached;
  info.unborn = status.unborn;
  info.head = status.head;
  info.ahead = status.ahead;
  info.behind = status.behind;
  info.changed = countChanged(status);
  return info;
}

/**
 * Run a bounded-concurrency map over the given items.
 * @template T, R
 * @param {T[]} items - input items.
 * @param {number} limit - maximum in-flight tasks.
 * @param {(item: T) => Promise<R>} task - the work.
 * @returns {Promise<R[]>} results in input order.
 */
async function mapConcurrent(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Normalise, resolve and deduplicate scan roots.
 * @param {unknown[]} roots - candidate roots.
 * @returns {Promise<string[]>} existing, real, unique directories.
 */
export async function normalizeRoots(roots) {
  const resolved = [];
  const seen = new Set();
  for (const candidate of roots) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed === '' || !isAbsolute(trimmed) || trimmed.includes('\0')) continue;
    if (trimmed.split(/[\\/]+/).includes('..')) continue;
    const absolute = resolve(trimmed);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (await isDirectory(absolute)) resolved.push(absolute);
  }
  return resolved;
}

/**
 * Discover repositories under the given roots.
 * @param {{
 *   ctx?: unknown,
 *   roots?: unknown[],
 *   shallowRoots?: unknown[],
 *   extraRoots?: unknown[],
 *   descendIntoRepositories?: boolean,
 *   scanDepth?: number,
 *   autoRepositoryDetection?: string,
 *   useCache?: boolean,
 *   timeoutMs?: number,
 * }} [options] - discovery options.
 * @returns {Promise<{ repositories: object[], truncated: boolean, roots: string[] }>}
 */
export async function discoverRepositories(options = {}) {
  const depth = Number.isFinite(options.scanDepth) ? Math.max(0, Math.trunc(options.scanDepth)) : 5;
  const mode = options.autoRepositoryDetection === 'false' ? 'false' : 'true';
  const extraRoots = await normalizeRoots(options.extraRoots ?? []);
  const baseRoots = mode === 'false' ? [] : await normalizeRoots(options.roots ?? []);
  const shallowRoots = mode === 'false' ? [] : await normalizeRoots(options.shallowRoots ?? []);
  const roots = [...new Set([...baseRoots, ...shallowRoots, ...extraRoots])];
  const shallowStart = Math.max(0, depth - SHALLOW_ROOT_DEPTH);
  const useCache = options.useCache !== false;
  const descend = options.descendIntoRepositories === true;
  const cacheKey = JSON.stringify({ roots, depth, mode, extraRoots, shallowRoots, descend });
  const now = Date.now();
  if (useCache) {
    const cached = discoveryCache.get(cacheKey);
    if (cached !== undefined && now - cached.at < DISCOVERY_TTL_MS) {
      return { repositories: cached.repositories.map((repo) => ({ ...repo })), truncated: cached.truncated, roots };
    }
  }

  const found = [];
  const visited = new Set();
  let truncated = false;
  const queue = [
    ...baseRoots.map((root) => ({ path: root, depth: 0, descend })),
    ...extraRoots.map((root) => ({ path: root, depth: 0, descend: false })),
    ...shallowRoots.map((root) => ({ path: root, depth: shallowStart, descend: false })),
  ];
  while (queue.length > 0 && !truncated) {
    const current = queue.shift();
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    if (visited.size > MAX_SCANNED_DIRECTORIES) break;
    if (current.depth > depth) continue;
    const detected = await detectRepositoryKind(current.path);
    if (detected !== null) {
      if (found.length >= MAX_REPOSITORIES) {
        truncated = true;
        break;
      }
      found.push({ path: current.path, kind: detected.kind });
      // A plain scan stops at the first checkout it meets. When the root is the
      // folder the user opened, keep walking so the checkouts nested inside it
      // are discovered too — that is the layout a multi-repository workspace has.
      if (current.descend !== true) continue;
    }
    if (current.depth >= depth) continue;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    const children = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      children.push({ path: join(current.path, entry.name), depth: current.depth + 1, descend: current.descend === true });
    }
    children.sort((left, right) => left.path.localeCompare(right.path));
    queue.push(...children);
  }

  const inspectionOptions = { ctx: options.ctx, timeoutMs: options.timeoutMs ?? INSPECTION_TIMEOUT_MS };
  const repositories = await mapConcurrent(found, INSPECTION_CONCURRENCY, async (candidate) =>
    readRepoInfo(candidate.path, candidate.kind, inspectionOptions),
  );
  if (useCache) discoveryCache.set(cacheKey, { at: now, repositories, truncated });
  return { repositories: repositories.map((repo) => ({ ...repo })), truncated, roots };
}

/**
 * Read the full `RepoInfo` for one repository (used by `repo.info`).
 * @param {string} repoPath - absolute path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<object>}
 */
export async function readSingleRepoInfo(repoPath, options = {}) {
  const detected = await detectRepositoryKind(repoPath);
  if (detected === null) throw gitError('E_NOT_REPO', 'directory is not a git repository');
  return readRepoInfo(repoPath, detected.kind, options);
}

/**
 * List the worktrees registered for a repository.
 * @param {string} repoPath - absolute path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ path: string, head: string | null, branch: string | null, bare: boolean, detached: boolean }[]>}
 */
export async function listWorktrees(repoPath, options = {}) {
  const result = await runGit(repoPath, ['worktree', 'list', '--porcelain'], options);
  const worktrees = [];
  let current = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== null) worktrees.push(current);
      current = { path: line.slice(9), head: null, branch: null, bare: false, detached: false };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') current.bare = true;
    else if (line === 'detached') current.detached = true;
  }
  if (current !== null) worktrees.push(current);
  return worktrees;
}

/**
 * Count the repositories under one directory without reading their status.
 * @param {string} root - absolute directory to walk.
 * @param {number} depth - maximum depth below `root`.
 * @param {number} cap - stop counting once this many repositories are seen.
 * @returns {Promise<number>} how many repositories were found.
 */
async function countRepositoriesUnder(root, depth, cap) {
  let count = 0;
  const visited = new Set();
  const queue = [{ path: root, depth: 0 }];
  while (queue.length > 0 && count < cap) {
    const current = queue.shift();
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    const detected = await detectRepositoryKind(current.path);
    if (detected !== null) {
      count += 1;
      continue;
    }
    if (current.depth >= depth) continue;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return count;
}

/**
 * Suggest scan roots under a home directory.
 *
 * Only the well-known development folders that actually contain a checkout are
 * offered, so the Client can turn an empty panel into a single click instead of
 * asking the user to type an absolute path.
 * @param {string} home - the user's home directory.
 * @param {{ limit?: number, depth?: number }} [options] - probe limits.
 * @returns {Promise<{ path: string, count: number }[]>} suggested roots, most useful first.
 */
export async function suggestScanRoots(home, options = {}) {
  if (typeof home !== 'string' || home === '') return [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(options.limit)) : SUGGESTION_LIMIT;
  const depth = Number.isFinite(options.depth) ? Math.max(0, Math.trunc(options.depth)) : SUGGESTION_DEPTH;
  const useCache = options.useCache !== false;
  const cacheKey = JSON.stringify({ home, limit, depth });
  if (useCache) {
    const cached = suggestionCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < SUGGESTION_TTL_MS) {
      return cached.suggestions.map((item) => ({ ...item }));
    }
  }
  const suggestions = [];
  for (const name of SUGGESTED_ROOT_NAMES) {
    if (suggestions.length >= limit) break;
    const path = join(home, name);
    if (!(await isDirectory(path))) continue;
    const count = await countRepositoriesUnder(path, depth, MAX_REPOSITORIES);
    if (count > 0) suggestions.push({ path, count });
  }
  if (useCache) suggestionCache.set(cacheKey, { at: Date.now(), suggestions });
  return suggestions.map((item) => ({ ...item }));
}

/**
 * The directories that hold the given paths, for sibling-repository discovery.
 * The root directory and the given paths themselves are never returned.
 * @param {string[]} paths - registered workspace directories.
 * @param {string} [home] - the home directory, excluded so a workspace there never walks $HOME.
 * @returns {string[]} unique parent directories.
 */
export function siblingRoots(paths, home) {
  const list = Array.isArray(paths) ? paths : [];
  const excluded = new Set(list);
  if (typeof home === 'string' && home !== '') excluded.add(home);
  excluded.add(sep);
  const parents = [];
  const seen = new Set();
  for (const path of list) {
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) continue;
    const parent = dirname(path);
    if (parent === path || parent === sep || excluded.has(parent)) continue;
    if (seen.has(parent)) continue;
    seen.add(parent);
    parents.push(parent);
  }
  return parents;
}
