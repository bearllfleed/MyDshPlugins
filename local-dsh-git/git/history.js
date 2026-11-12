/**
 * Read-side git queries for the dsh-git Host half: log, show, branches, stash,
 * tags, remotes and submodules.
 *
 * Every parser is exported so the unit tests can feed it fixture text; the
 * `read*` wrappers only build the fixed `--format` command lines.
 */
import { gitError, normalizeRepoRelativePath, normalizeRevision, truncateText } from './util.js';
import { runGit } from './exec.js';
import { parseRefTrack } from './status.js';
import { parseUnifiedDiff, MAX_DIFF_BYTES } from './diff.js';

/** NUL-separated log format; matches contract §4.2 exactly. */
export const LOG_FORMAT = '%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00';
/** NUL-separated branch format; matches contract §4.2 exactly. */
export const BRANCH_FORMAT =
  '%(refname:short)%00%(refname)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00%(contents:subject)%00%(committerdate:iso-strict)%00%(authorname)';
/** NUL-separated tag format. */
export const TAG_FORMAT = '%(refname:short)%00%(objectname)%00%(creatordate:iso-strict)%00%(contents:subject)%00%(objecttype)';
/** NUL-separated stash format. */
export const STASH_FORMAT = '%gd%x00%ct%x00%gs';
/** Default history page size. */
export const DEFAULT_LOG_LIMIT = 30;
/** Hard ceiling on one history page. */
export const MAX_LOG_LIMIT = 1000;

/**
 * Split `%D` decoration text into plain ref names.
 * @param {string} decoration - e.g. `HEAD -> main, origin/main, tag: v1`.
 * @returns {string[]}
 */
export function parseDecoration(decoration) {
  if (typeof decoration !== 'string' || decoration.trim() === '') return [];
  const refs = [];
  for (const part of decoration.split(',')) {
    let name = part.trim();
    if (name === '') continue;
    if (name.startsWith('HEAD -> ')) name = name.slice(8).trim();
    else if (name.startsWith('tag: ')) name = name.slice(5).trim();
    if (name !== '') refs.push(name);
  }
  return refs;
}

/**
 * Parse one `--format=LOG_FORMAT` record.
 * @param {string} line - one output line (with or without its trailing NUL).
 * @returns {object | null} a `CommitInfo`, or null when the line is malformed.
 */
export function parseCommitLine(line) {
  if (typeof line !== 'string' || line === '') return null;
  const clean = line.endsWith('\0') ? line.slice(0, -1) : line;
  const fields = clean.split('\0');
  if (fields.length < 8) return null;
  return {
    hash: fields[0],
    shortHash: fields[1],
    parents: fields[2] === '' ? [] : fields[2].split(' ').filter((value) => value !== ''),
    author: fields[3],
    authorEmail: fields[4],
    date: fields[5],
    refs: parseDecoration(fields[6]),
    subject: fields[7],
  };
}

/**
 * Parse a whole `git log` output produced with `LOG_FORMAT`.
 * @param {string} text - raw stdout.
 * @returns {object[]} the commits in git's order.
 */
export function parseLog(text) {
  if (typeof text !== 'string' || text === '') return [];
  const commits = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const commit = parseCommitLine(line);
    if (commit !== null) commits.push(commit);
  }
  return commits;
}

/**
 * Recognise the "repository has no commits yet" failure, which is not an error
 * for the history panel.
 * @param {unknown} error - the thrown value.
 * @returns {boolean}
 */
function isEmptyHistoryError(error) {
  const detail = typeof error === 'object' && error !== null ? `${error.detail ?? ''} ${error.message ?? ''}` : String(error);
  return /does not have any commits|bad default revision|bad revision|unknown revision|no such ref/i.test(detail);
}

/**
 * Build the `git log` argument list.
 * @param {{ limit?: number, skip?: number, path?: string, ref?: string }} params - history parameters.
 * @returns {{ args: string[], limit: number, skip: number }}
 */
export function buildLogArgs(params = {}) {
  const rawLimit = Number.isFinite(params.limit) ? Math.trunc(params.limit) : DEFAULT_LOG_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LOG_LIMIT, rawLimit));
  const rawSkip = Number.isFinite(params.skip) ? Math.trunc(params.skip) : 0;
  const skip = Math.max(0, rawSkip);
  const args = ['log', `--format=${LOG_FORMAT}`, '-n', String(limit + 1)];
  if (skip > 0) args.push('--skip', String(skip));
  if (typeof params.ref === 'string' && params.ref !== '') args.push(normalizeRevision(params.ref, 'ref'));
  args.push('--');
  if (typeof params.path === 'string' && params.path !== '') args.push(normalizeRepoRelativePath(params.path));
  return { args, limit, skip };
}

/**
 * Read one page of history.
 * @param {string} repoPath - repository path.
 * @param {{ limit?: number, skip?: number, path?: string, ref?: string }} params - history parameters.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ commits: object[], hasMore: boolean }>}
 */
export async function readLog(repoPath, params = {}, options = {}) {
  const { args, limit } = buildLogArgs(params);
  let result;
  try {
    result = await runGit(repoPath, args, options);
  } catch (error) {
    // An unborn branch has no commits, which is a normal empty history. An
    // explicit `ref` that does not resolve is a real error the user must see.
    const requestedRef = typeof params.ref === 'string' && params.ref.trim() !== '';
    if (!requestedRef && isEmptyHistoryError(error)) return { commits: [], hasMore: false };
    throw error;
  }
  const commits = parseLog(result.stdout);
  const hasMore = commits.length > limit;
  return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
}

/**
 * Read the newest commit, used to report what `commit` just produced.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ hash: string, subject: string }>}
 */
export async function readHeadCommit(repoPath, options = {}) {
  const result = await runGit(repoPath, ['log', '-1', '--format=%H%x00%s'], options);
  const line = result.stdout.split('\n').find((value) => value.trim() !== '') ?? '';
  const fields = line.replace(/\0$/, '').split('\0');
  if (fields.length < 2) throw gitError('E_GIT_FAILED', 'unable to read the new commit');
  return { hash: fields[0], subject: fields[1] };
}

/**
 * Parse one `for-each-ref` branch record.
 * @param {string} line - one record.
 * @param {string | null} currentBranch - the checked-out branch, when any.
 * @returns {object | null} a `BranchInfo`.
 */
export function parseBranchLine(line, currentBranch) {
  if (typeof line !== 'string' || line === '') return null;
  const fields = line.split('\0');
  if (fields.length < 8) return null;
  const [shortName, fullName, upstream, track, objectName, subject, date, author] = fields;
  if (shortName === '') return null;
  // `origin/HEAD` is a symbolic alias for another remote branch; hide it.
  if (shortName.endsWith('/HEAD')) return null;
  const remote = fullName.startsWith('refs/remotes/');
  const divergence = parseRefTrack(track);
  return {
    name: shortName,
    fullName,
    remote,
    current: remote ? false : shortName === currentBranch,
    upstream: upstream === '' ? null : upstream,
    ahead: divergence.ahead,
    behind: divergence.behind,
    lastCommit:
      objectName === ''
        ? null
        : { hash: objectName, subject, date, author },
  };
}

/**
 * Read the checked-out branch name.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<string | null>} the branch name, or null when detached/unborn.
 */
export async function readCurrentBranch(repoPath, options = {}) {
  try {
    const result = await runGit(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'], {
      ...options,
      allowExitCodes: [1, 128],
    });
    const name = result.stdout.trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/**
 * Read local (and optionally remote-tracking) branches.
 * @param {string} repoPath - repository path.
 * @param {{ includeRemote?: boolean }} params - whether to include remote branches.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ current: string | null, branches: object[] }>}
 */
export async function readBranches(repoPath, params = {}, options = {}) {
  const current = await readCurrentBranch(repoPath, options);
  const args = ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'];
  if (params.includeRemote === true) args.push('refs/remotes');
  const result = await runGit(repoPath, args, options);
  const branches = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const branch = parseBranchLine(line, current);
    if (branch !== null) branches.push(branch);
  }
  branches.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.remote !== right.remote) return left.remote ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
  return { current, branches };
}

/**
 * Parse a `git remote -v` listing.
 * @param {string} text - raw stdout.
 * @returns {{ name: string, fetchUrl: string, pushUrl: string }[]}
 */
export function parseRemotes(text) {
  if (typeof text !== 'string' || text === '') return [];
  const order = [];
  const byName = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line);
    if (match === null) continue;
    const [, name, url, kind] = match;
    let entry = byName.get(name);
    if (entry === undefined) {
      entry = { name, fetchUrl: '', pushUrl: '' };
      byName.set(name, entry);
      order.push(name);
    }
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return order.map((name) => {
    const entry = byName.get(name);
    if (entry.pushUrl === '') entry.pushUrl = entry.fetchUrl;
    return entry;
  });
}

/**
 * Read configured remotes.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ remotes: object[] }>}
 */
export async function readRemotes(repoPath, options = {}) {
  const result = await runGit(repoPath, ['remote', '-v'], options);
  return { remotes: parseRemotes(result.stdout) };
}

/**
 * Parse `git stash list --format='%gd%x00%ct%x00%gs'`.
 * @param {string} text - raw stdout.
 * @returns {object[]} `StashEntry[]`.
 */
export function parseStashList(text) {
  if (typeof text !== 'string' || text === '') return [];
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split('\0');
    if (fields.length < 3) continue;
    const ref = fields[0];
    const indexMatch = /stash@\{(\d+)\}/.exec(ref);
    const seconds = Number.parseInt(fields[1], 10);
    entries.push({
      index: indexMatch === null ? entries.length : Number.parseInt(indexMatch[1], 10),
      ref,
      message: fields[2],
      date: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '',
    });
  }
  return entries;
}

/**
 * Read stash entries.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ entries: object[] }>}
 */
export async function readStashList(repoPath, options = {}) {
  const result = await runGit(repoPath, ['stash', 'list', `--format=${STASH_FORMAT}`], options);
  return { entries: parseStashList(result.stdout) };
}

/**
 * Parse `for-each-ref refs/tags` output.
 * @param {string} text - raw stdout.
 * @returns {object[]} `TagInfo[]`.
 */
export function parseTagList(text) {
  if (typeof text !== 'string' || text === '') return [];
  const tags = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split('\0');
    if (fields.length < 5) continue;
    const [name, hash, date, message, objectType] = fields;
    if (name === '') continue;
    tags.push({ name, hash, date, message, annotated: objectType === 'tag' });
  }
  return tags;
}

/**
 * Read tags, newest first.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ tags: object[] }>}
 */
export async function readTagList(repoPath, options = {}) {
  const result = await runGit(repoPath, ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags'], options);
  return { tags: parseTagList(result.stdout) };
}

/**
 * Parse `git submodule status`.
 * @param {string} text - raw stdout.
 * @returns {{ path: string, sha: string, state: string }[]}
 */
export function parseSubmoduleStatus(text) {
  if (typeof text !== 'string' || text === '') return [];
  const submodules = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([ +\-U])([0-9a-f]+) (\S+)(?: \(.*\))?$/.exec(line);
    if (match === null) continue;
    const [, marker, sha, path] = match;
    let state = 'initialized';
    if (marker === '-') state = 'uninitialized';
    else if (marker === '+') state = 'modified';
    else if (marker === 'U') state = 'conflicted';
    submodules.push({ path, sha, state });
  }
  return submodules;
}

/**
 * Read submodules.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ submodules: object[] }>}
 */
export async function readSubmoduleList(repoPath, options = {}) {
  const result = await runGit(repoPath, ['submodule', 'status'], { ...options, allowExitCodes: [1] });
  return { submodules: parseSubmoduleStatus(result.stdout) };
}

/**
 * Read a single commit plus its patch.
 * @param {string} repoPath - repository path.
 * @param {string} rev - the revision to show.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ commit: object, body: string, files: object[], text: string, truncated: boolean }>}
 */
export async function readShow(repoPath, rev, options = {}) {
  const revision = normalizeRevision(rev);
  const meta = await runGit(repoPath, ['show', '-s', `--format=${LOG_FORMAT}`, revision], options);
  const commit = parseCommitLine(meta.stdout.split('\n').find((line) => line.trim() !== '') ?? '');
  if (commit === null) throw gitError('E_GIT_FAILED', 'unable to read the requested revision');
  const bodyResult = await runGit(repoPath, ['show', '-s', '--format=%B', revision], options);
  const patchResult = await runGit(repoPath, ['show', '--no-color', '--no-ext-diff', '--format=', '--patch', revision], {
    ...options,
    allowExitCodes: [1],
  });
  const clipped = truncateText(patchResult.stdout, MAX_DIFF_BYTES);
  return {
    commit,
    body: bodyResult.stdout.replace(/\s+$/, ''),
    files: parseUnifiedDiff(clipped.text),
    text: clipped.text,
    truncated: clipped.truncated,
  };
}

/**
 * Describe why `git branch -d` refused a branch: how many commits it holds that
 * HEAD does not, and up to three of them.
 *
 * git only says "not fully merged"; the reader needs to know what would be
 * lost. Best effort — an unreadable branch yields an empty string and the
 * caller keeps git's own detail.
 * @param {string} repoPath - repository path.
 * @param {string} branch - branch name.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<string>}
 */
export async function describeUnmergedBranch(repoPath, branch, options = {}) {
  try {
    const countResult = await runGit(repoPath, ['rev-list', '--count', `HEAD..${branch}`], options);
    const count = Number.parseInt(countResult.stdout.trim(), 10);
    const logResult = await runGit(
      repoPath,
      ['log', '--format=%h %s', '--max-count=3', `HEAD..${branch}`],
      options,
    );
    const samples = logResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const head = Number.isFinite(count)
      ? `${count} commit(s) are not merged into HEAD`
      : 'commits are not merged into HEAD';
    return samples.length === 0 ? head : `${head}: ${samples.join(', ')}`;
  } catch {
    return '';
  }
}
