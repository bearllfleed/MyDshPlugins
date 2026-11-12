/**
 * Worktree awareness for the dsh-git Host half.
 *
 * A branch can only be checked out in one worktree at a time, and git refuses
 * to delete or switch to a branch that another worktree holds. Those refusals
 * arrive as prose (`used by worktree at '<path>'`), so the actions read the
 * worktree list first and report the offending path themselves.
 */
import { runGit } from './exec.js';

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Each worktree is a block of `key value` lines separated by a blank line:
 * `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` (or `detached`),
 * and the flags `bare`, `locked`, `prunable`.
 * @param {unknown} text - porcelain output.
 * @returns {{ path: string, head: string | null, branch: string | null, bare: boolean, detached: boolean, locked: boolean, prunable: boolean }[]}
 */
export function parseWorktreeList(text) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current !== null) entries.push(current);
    current = null;
  };
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (current === null) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  flush();
  return entries;
}

/**
 * Read the worktrees attached to a repository.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ path: string, head: string | null, branch: string | null, bare: boolean, detached: boolean, locked: boolean, prunable: boolean }[]>}
 */
export async function readWorktrees(repoPath, options = {}) {
  const result = await runGit(repoPath, ['worktree', 'list', '--porcelain'], options);
  return parseWorktreeList(result.stdout);
}

/**
 * Read the branch checked out at a repository path, or null when detached.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<string | null>}
 */
export async function currentBranchName(repoPath, options = {}) {
  const result = await runGit(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'], {
    ...options,
    allowExitCodes: [1, 128],
  });
  if (result.exitCode !== 0) return null;
  const name = result.stdout.trim();
  return name === '' ? null : name;
}

/**
 * Find the worktree that holds a branch, excluding the one being queried.
 * @param {{ path: string, branch: string | null }[]} worktrees - worktree entries.
 * @param {string} branch - branch name.
 * @param {string} ownPath - the repository the caller is acting on.
 * @returns {{ path: string, branch: string | null } | null}
 */
export function worktreeHolding(worktrees, branch, ownPath) {
  for (const entry of worktrees) {
    if (entry.branch === branch && entry.path !== ownPath) return entry;
  }
  return null;
}
