/**
 * Shared primitives for the dsh-git Host half.
 *
 * Everything here is dependency-free (node builtins only) and side-effect free
 * except for the two coordination helpers (`withLock`, `createKeyedSemaphore`),
 * which exist so `git/actions.js` can serialise writes per repository.
 */
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

/**
 * The one error type that crosses the Host boundary.
 *
 * `code` is the stable machine-readable value the Client localises; `message`
 * is a short English sentence; `detail` carries verbatim git stderr for display.
 */
export class GitError extends Error {
  /**
   * @param {string} code - one of the contract's E_* codes.
   * @param {string} message - short English description.
   * @param {string} [detail] - verbatim detail (git stderr tail).
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    if (detail !== undefined && detail !== null && detail !== '') {
      this.detail = String(detail);
    }
  }
}

/**
 * Every error code that can cross the Host boundary, in the order the Client
 * lists them. `client.js` keeps the matching `error.<code>` dictionary entries
 * and `test/host-failures.test.mjs` asserts the two lists agree, so a new code
 * cannot ship without a localized title.
 */
export const ERROR_CODES = Object.freeze([
  'E_NOT_REPO',
  'E_NO_GIT',
  'E_TIMEOUT',
  'E_AUTH_REQUIRED',
  'E_LOCKED',
  'E_CONFLICT',
  'E_INVALID_ARG',
  'E_UNSUPPORTED',
  'E_INTERNAL',
  'E_GIT_FAILED',
  'E_BARE_REPO',
  'E_HOOK_FAILED',
  'E_NOTHING_TO_COMMIT',
  'E_BRANCH_CURRENT',
  'E_BRANCH_IN_USE',
  'E_BRANCH_NOT_MERGED',
  'E_DIRTY_TREE',
  'E_ALREADY_EXISTS',
  'E_NOT_FOUND',
  'E_NO_UPSTREAM',
  'E_UPSTREAM_MISMATCH',
  'E_NO_REMOTE',
  'E_REJECTED',
  'E_DIVERGED',
]);

/**
 * Build a GitError.
 * @param {string} code - stable error code.
 * @param {string} message - short English description.
 * @param {string} [detail] - verbatim detail.
 * @returns {GitError}
 */
export function gitError(code, message, detail) {
  return new GitError(code, message, detail);
}

/**
 * Coerce any thrown value into a GitError without losing the original message.
 * @param {unknown} error - the thrown value.
 * @param {string} [code] - code used when the value is not already a GitError.
 * @returns {GitError}
 */
export function toGitError(error, code = 'E_INTERNAL') {
  if (error instanceof GitError) return error;
  if (error instanceof Error) return new GitError(code, error.message);
  return new GitError(code, String(error));
}

/**
 * Quote one argv item for a POSIX shell, exactly as `sh` would need it.
 * Used only by the `ctx.shell` fallback; the primary path passes argv directly.
 * @param {unknown} value - the argv item.
 * @returns {string} a single-quoted shell word.
 */
export function shellQuote(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text === '') return "''";
  return `'${text.split("'").join("'\\''")}'`;
}

/**
 * Split a user-typed command line into argv the way a POSIX shell would,
 * but without ever handing the text to a shell.
 *
 * Supports single quotes (literal), double quotes (backslash escapes for
 * `"` `\` `$` and backtick, plus `\n`/`\t`), unquoted backslash escapes, and
 * collapses runs of whitespace. Throws E_INVALID_ARG on unbalanced quotes.
 * @param {string} input - the raw command line.
 * @returns {string[]} argv tokens.
 */
export function tokenizeCommand(input) {
  if (typeof input !== 'string') throw gitError('E_INVALID_ARG', 'command must be a string');
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '\0') throw gitError('E_INVALID_ARG', 'command must not contain NUL bytes');
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === '\\') {
        const next = input[index + 1];
        if (next === undefined) {
          current += '\\';
          continue;
        }
        index += 1;
        if (next === '"' || next === '\\' || next === '$' || next === '`') current += next;
        else if (next === 'n') current += '\n';
        else if (next === 't') current += '\t';
        else current += `\\${next}`;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '\\') {
      const next = input[index + 1];
      if (next === undefined) {
        current += '\\';
        continue;
      }
      index += 1;
      current += next;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== null) throw gitError('E_INVALID_ARG', 'command has an unterminated quote');
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Clamp an integral option into a range, falling back when it is not a number.
 * @param {unknown} value - candidate value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - value used when the candidate is not finite.
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * surrogate pair into a replacement character.
 * @param {unknown} value - text to truncate.
 * @param {number} maxBytes - byte budget.
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: '', truncated: text !== '' };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * Serialise async work per key: the returned promise resolves after every
 * earlier task for the same key settled, so writes never interleave.
 * @template T
 * @param {Map<string, Promise<unknown>>} locks - the lock table to use.
 * @param {string} key - lock identity (a repository path).
 * @param {() => Promise<T>} task - the critical section.
 * @returns {Promise<T>}
 */
export function withLock(locks, key, task) {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => task(),
    () => task(),
  );
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
}

/**
 * Build a per-key counting semaphore, used to cap concurrent reads per repo.
 * @param {number} limit - maximum concurrent tasks per key.
 * @returns {<T>(key: string, task: () => Promise<T>) => Promise<T>}
 */
export function createKeyedSemaphore(limit) {
  const states = new Map();
  const bounded = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1;
  return async function runWithSlot(key, task) {
    let state = states.get(key);
    if (state === undefined) {
      state = { active: 0, waiting: [] };
      states.set(key, state);
    }
    if (state.active >= bounded) {
      await new Promise((resolve) => state.waiting.push(resolve));
    }
    state.active += 1;
    try {
      return await task();
    } finally {
      state.active -= 1;
      const next = state.waiting.shift();
      if (next !== undefined) next();
      else if (state.active === 0) states.delete(key);
    }
  };
}

/**
 * Validate a Client-supplied repository-relative path.
 *
 * Rejects absolute paths, `..` traversal, empty values and NUL bytes. The
 * returned form is POSIX-style and is always passed to git after `--`.
 * @param {unknown} value - candidate path.
 * @returns {string} the normalised relative path.
 */
export function normalizeRepoRelativePath(value) {
  if (typeof value !== 'string') throw gitError('E_INVALID_ARG', 'path must be a string');
  if (value.includes('\0')) throw gitError('E_INVALID_ARG', 'path must not contain NUL bytes');
  const candidate = value.trim();
  if (candidate === '') throw gitError('E_INVALID_ARG', 'path must not be empty');
  const normalised = posix.normalize(candidate.split('\\').join('/'));
  if (normalised === '.' || normalised === '') throw gitError('E_INVALID_ARG', 'path must not be empty');
  if (normalised === '..' || normalised.startsWith('../')) {
    throw gitError('E_INVALID_ARG', 'path must stay inside the repository');
  }
  if (posix.isAbsolute(normalised)) throw gitError('E_INVALID_ARG', 'path must be relative to the repository');
  return normalised;
}

/**
 * Accept a revision-ish parameter (branch, tag, `HEAD~2`, sha) that is passed
 * to git as a positional argument. Option-looking values are refused so a
 * parameter can never turn into a git flag.
 * @param {unknown} value - candidate revision.
 * @param {string} [label] - parameter name used in the error message.
 * @returns {string} the trimmed revision.
 */
export function normalizeRevision(value, label = 'revision') {
  if (typeof value !== 'string') throw gitError('E_INVALID_ARG', `${label} must be a string`);
  if (value.includes('\0')) throw gitError('E_INVALID_ARG', `${label} must not contain NUL bytes`);
  const trimmed = value.trim();
  if (trimmed === '') throw gitError('E_INVALID_ARG', `${label} must not be empty`);
  if (trimmed.startsWith('-')) throw gitError('E_INVALID_ARG', `${label} must not start with -`);
  if (/[\s]/.test(trimmed)) throw gitError('E_INVALID_ARG', `${label} must not contain whitespace`);
  return trimmed;
}

/**
 * Resolve an absolute path and refuse anything that leaves the intended root.
 * @param {string} root - the repository root (already resolved).
 * @param {string} relativePath - a repository-relative path.
 * @returns {string} the absolute path inside the repository.
 */
export function resolveInsideRoot(root, relativePath) {
  const relative = normalizeRepoRelativePath(relativePath);
  const normalisedRoot = root.split('\\').join('/');
  const absolute = posix.join(normalisedRoot, relative);
  const prefix = normalisedRoot.endsWith('/') ? normalisedRoot : `${normalisedRoot}/`;
  if (!absolute.startsWith(prefix)) throw gitError('E_INVALID_ARG', 'path must stay inside the repository');
  return absolute;
}

/**
 * Collapse a thrown value into a one-line message suitable for `RepoInfo.error`.
 * @param {unknown} error - the thrown value.
 * @returns {string}
 */
export function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 300);
}
