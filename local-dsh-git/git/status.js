/**
 * `git status` and ref-tracking parsing for the dsh-git Host half.
 *
 * The parser is a pure function so the porcelain v2 format can be unit tested
 * without a repository; `readStatus` is the thin async wrapper that adds the
 * facts which live outside the porcelain stream (operation state, stash count).
 */
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitError, shortError } from './util.js';
import { runGit } from './exec.js';

/** Two-letter conflict codes emitted by porcelain v2 `u` records. */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
/** Worktree/staged letters that mean "the index or worktree differs". */
const DIFF_LETTERS = new Set(['M', 'T']);

/**
 * Split a porcelain record into a fixed number of leading space-separated
 * fields plus the remainder (which may itself contain spaces).
 * @param {string} record - one record.
 * @param {number} count - number of leading fields to peel off.
 * @returns {string[]} `count` fields followed by the remainder.
 */
function splitFixed(record, count) {
  const fields = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const next = record.indexOf(' ', offset);
    if (next === -1) return fields;
    fields.push(record.slice(offset, next));
    offset = next + 1;
  }
  fields.push(record.slice(offset));
  return fields;
}

/**
 * Classify one `XY` pair into the staged and worktree `FileEntry` values.
 * @param {string} xy - the two-column status.
 * @param {string} path - the path from the record.
 * @param {string | undefined} origPath - rename/copy source, when present.
 * @param {number | undefined} score - rename/copy similarity score.
 * @param {string[]} staged - accumulator for index changes.
 * @param {string[]} changed - accumulator for worktree changes.
 */
function classifyXY(xy, path, origPath, score, staged, changed) {
  const index = xy[0] ?? '.';
  const worktree = xy[1] ?? '.';
  if (index !== '.' && index !== ' ') {
    const entry = { path, status: index, staged: true };
    if (origPath !== undefined) entry.origPath = origPath;
    if (score !== undefined) entry.score = score;
    staged.push(entry);
  }
  if (worktree !== '.' && worktree !== ' ') {
    const entry = { path, status: worktree, staged: false };
    if (origPath !== undefined) entry.origPath = origPath;
    if (score !== undefined) entry.score = score;
    changed.push(entry);
  }
}

/**
 * Parse one `2` (rename/copy) record, handling both `-z` and line formats.
 * @param {string} record - the record text.
 * @param {string | undefined} origPath - the following NUL field, in `-z` mode.
 * @param {string[]} staged - accumulator.
 * @param {string[]} changed - accumulator.
 * @returns {boolean} whether the record was consumed.
 */
function parseRenameRecord(record, origPath, staged, changed) {
  const fields = splitFixed(record, 9);
  if (fields.length < 10) return false;
  const xy = fields[1];
  let path = fields[9];
  let source = origPath;
  if (source === undefined) {
    const tab = path.indexOf('\t');
    if (tab === -1) return false;
    source = path.slice(tab + 1);
    path = path.slice(0, tab);
  }
  const scoreText = fields[8];
  const score = Number.parseInt(scoreText.slice(1), 10);
  classifyXY(xy, path, source, Number.isFinite(score) ? score : undefined, staged, changed);
  return true;
}

/**
 * Parse a `# branch.*` header line.
 * @param {string} line - the header without its `# ` prefix.
 * @param {object} state - the accumulator mutated in place.
 */
function parseBranchHeader(line, state) {
  const space = line.indexOf(' ');
  const key = space === -1 ? line : line.slice(0, space);
  const value = space === -1 ? '' : line.slice(space + 1);
  switch (key) {
    case 'branch.oid':
      if (value === '(initial)') {
        state.unborn = true;
        state.head = null;
      } else {
        state.head = value === '' ? null : value;
      }
      return;
    case 'branch.head':
      if (value === '(detached)') {
        state.detached = true;
        state.branch = null;
      } else {
        state.branch = value;
      }
      return;
    case 'branch.upstream':
      state.upstream = value === '' ? null : value;
      return;
    case 'branch.ab': {
      const match = /^\+(-?\d+)\s+-(-?\d+)$/.exec(value);
      if (match !== null) {
        state.ahead = Math.max(0, Number.parseInt(match[1], 10));
        state.behind = Math.max(0, Number.parseInt(match[2], 10));
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Parse `git status --porcelain=v2` output into the contract's `Status` fields.
 *
 * Handles `1`, `2`, `u`, `?` and `!` records plus every `# branch.*` header,
 * in both NUL-separated (`-z`, paths verbatim) and newline-separated forms.
 * Paths keep their original bytes: no unquoting is attempted because the
 * Host always runs with `core.quotepath=false`.
 * @param {string} zBufferString - raw stdout of the status command.
 * @returns {{ branch: string | null, upstream: string | null, ahead: number, behind: number, head: string | null, detached: boolean, unborn: boolean, staged: object[], changed: object[], untracked: object[], conflicted: object[] }}
 */
export function parseStatusPorcelainV2(zBufferString) {
  const state = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    head: null,
    detached: false,
    unborn: false,
    staged: [],
    changed: [],
    untracked: [],
    conflicted: [],
  };
  if (typeof zBufferString !== 'string' || zBufferString === '') return state;
  const nulSeparated = zBufferString.includes('\0');
  const records = nulSeparated ? zBufferString.split('\0') : zBufferString.split(/\r?\n/);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === '') continue;
    const kind = record[0];
    if (kind === '#') {
      parseBranchHeader(record.startsWith('# ') ? record.slice(2) : record.slice(1).trimStart(), state);
      continue;
    }
    if (kind === '1') {
      const fields = splitFixed(record, 8);
      if (fields.length < 9) continue;
      classifyXY(fields[1], fields[8], undefined, undefined, state.staged, state.changed);
      continue;
    }
    if (kind === '2') {
      const following = nulSeparated ? records[index + 1] : undefined;
      if (nulSeparated) index += 1;
      parseRenameRecord(record, following, state.staged, state.changed);
      continue;
    }
    if (kind === 'u') {
      const fields = splitFixed(record, 10);
      if (fields.length < 11) continue;
      const xy = fields[1];
      if (!CONFLICT_CODES.has(xy)) continue;
      state.conflicted.push({ path: fields[10], status: 'U', staged: false, conflict: xy });
      continue;
    }
    if (kind === '?') {
      state.untracked.push({ path: record.slice(2), status: '?', staged: false });
      continue;
    }
    // `!` (ignored) records carry no information the contract exposes.
  }
  return state;
}

/**
 * Parse the `%(upstream:track)` field or the tail of `git branch -vv`.
 *
 * Accepts `[ahead 2, behind 1]`, `ahead 2`, `[behind 3]`, `[gone]` and the
 * empty string, returning the divergence counts the Client displays.
 * @param {string} trackText - the tracking text.
 * @returns {{ ahead: number, behind: number, gone: boolean }}
 */
export function parseRefTrack(trackText) {
  const result = { ahead: 0, behind: 0, gone: false };
  if (typeof trackText !== 'string') return result;
  const text = trackText.trim();
  if (text === '') return result;
  if (text.includes('gone')) {
    result.gone = true;
    return result;
  }
  const ahead = /ahead\s+(\d+)/.exec(text);
  if (ahead !== null) result.ahead = Number.parseInt(ahead[1], 10);
  const behind = /behind\s+(\d+)/.exec(text);
  if (behind !== null) result.behind = Number.parseInt(behind[1], 10);
  return result;
}

/**
 * Determine which multi-step operation, if any, is in progress.
 *
 * Reads the marker files git leaves behind; every probe is best-effort because
 * the directory may vanish between the status and this call.
 * @param {string} gitDir - absolute git directory.
 * @returns {Promise<{ kind: string, detail?: string } | null>}
 */
export async function detectOperation(gitDir) {
  const exists = async (name) => {
    try {
      await access(join(gitDir, name));
      return true;
    } catch {
      return false;
    }
  };
  const readFirstLine = async (name) => {
    try {
      const text = await readFile(join(gitDir, name), 'utf8');
      const line = text.split('\n')[0].trim();
      return line === '' ? undefined : line;
    } catch {
      return undefined;
    }
  };
  if (await exists('rebase-merge')) {
    const headName = await readFirstLine('rebase-merge/head-name');
    return { kind: 'rebase', ...(headName === undefined ? {} : { detail: headName.replace(/^refs\/heads\//, '') }) };
  }
  if (await exists('rebase-apply')) {
    const applying = await readFirstLine('rebase-apply/applying');
    if (applying !== undefined) return { kind: 'rebase', detail: applying };
    const next = await readFirstLine('rebase-apply/next');
    const last = await readFirstLine('rebase-apply/last');
    return { kind: 'rebase', ...(next === undefined ? {} : { detail: last === undefined ? next : `${next}/${last}` }) };
  }
  if (await exists('MERGE_HEAD')) {
    const message = await readFirstLine('MERGE_MSG');
    return { kind: 'merge', ...(message === undefined ? {} : { detail: message }) };
  }
  if (await exists('CHERRY_PICK_HEAD')) {
    const message = await readFirstLine('MERGE_MSG');
    return { kind: 'cherry-pick', ...(message === undefined ? {} : { detail: message }) };
  }
  if (await exists('REVERT_HEAD')) {
    const message = await readFirstLine('MERGE_MSG');
    return { kind: 'revert', ...(message === undefined ? {} : { detail: message }) };
  }
  if (await exists('BISECT_LOG')) return { kind: 'bisect' };
  return null;
}

/**
 * Count stash entries without parsing their metadata.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<number>} number of stash entries, 0 when unavailable.
 */
export async function countStashEntries(repoPath, options = {}) {
  try {
    const result = await runGit(repoPath, ['stash', 'list', '--format=%gd'], options);
    return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/**
 * Read the complete `Status` payload for one repository.
 * @param {string} repoPath - absolute repository path (already validated).
 * @param {{ ctx?: unknown, timeoutMs?: number, includeStash?: boolean }} [options] - transport options.
 * @returns {Promise<object>} the contract's `Status` shape.
 */
export async function readStatus(repoPath, options = {}) {
  const runOptions = { ctx: options.ctx, timeoutMs: options.timeoutMs };
  const statusResult = await runGit(
    repoPath,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=no'],
    runOptions,
  );
  const parsed = parseStatusPorcelainV2(statusResult.stdout);
  let gitDir = null;
  try {
    const gitDirResult = await runGit(repoPath, ['rev-parse', '--absolute-git-dir'], runOptions);
    gitDir = gitDirResult.stdout.trim() === '' ? null : gitDirResult.stdout.trim();
  } catch {
    gitDir = null;
  }
  const operation = gitDir === null ? null : await detectOperation(gitDir);
  const stashCount = options.includeStash === false ? 0 : await countStashEntries(repoPath, runOptions);
  const status = {
    repo: repoPath,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    head: parsed.head,
    detached: parsed.detached,
    unborn: parsed.unborn,
    operation,
    staged: parsed.staged,
    changed: parsed.changed,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    stashCount,
  };
  return status;
}

/**
 * Derive the `RepoInfo.changed` counter from a status payload.
 * @param {{ staged: object[], changed: object[], untracked: object[], conflicted: object[] }} status - parsed status.
 * @returns {number} number of entries the Client will list.
 */
export function countChanged(status) {
  return status.staged.length + status.changed.length + status.untracked.length + status.conflicted.length;
}

/**
 * Read status but never throw: a broken repository must not abort discovery.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ status: object | null, error: string | null }>}
 */
export async function tryReadStatus(repoPath, options = {}) {
  try {
    return { status: await readStatus(repoPath, { ...options, includeStash: false }), error: null };
  } catch (error) {
    return { status: null, error: shortError(error) };
  }
}

/**
 * Guard used by actions that need an in-progress operation to exist.
 * @param {object | null} operation - detected operation.
 * @param {string} kind - expected kind.
 * @returns {void}
 */
export function requireOperation(operation, kind) {
  if (operation === null || operation === undefined || operation.kind !== kind) {
    throw gitError('E_INVALID_ARG', `no ${kind} operation is in progress`);
  }
}
