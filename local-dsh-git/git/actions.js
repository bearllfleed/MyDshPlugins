/**
 * The action dispatcher for the dsh-git Host half.
 *
 * Every entry of contract §4.1 maps to one fixed argv template here; no action
 * ever interpolates user text into a shell string. Writes are serialised per
 * repository, reads are capped at two in flight, destructive actions demand an
 * explicit `confirm: true`, refs are validated by git itself, and paths are
 * always passed after `--`.
 */
import {
  GitError,
  gitError,
  shortError,
  toGitError,
  withLock,
  createKeyedSemaphore,
  normalizeRepoRelativePath,
  normalizeRevision,
} from './util.js';
import { isDestructiveRaw, parseRawCommand, runGit } from './exec.js';
import {
  assertRepo,
  discoverRepositories,
  invalidateDiscoveryCache,
  readSingleRepoInfo,
  normalizeRoots,
  siblingRoots,
  suggestScanRoots,
} from './repos.js';
import { homedir } from 'node:os';
import { readStatus, detectOperation } from './status.js';
import { currentBranchName, readWorktrees, worktreeHolding } from './worktree.js';
import { COMMIT_HOOKS, PUSH_HOOKS, findInstalledHook } from './hooks.js';
import { readDiff, requireWorkTree } from './diff.js';
import {
  describeUnmergedBranch,
  readBranches,
  readHeadCommit,
  readLog,
  readRemotes,
  readShow,
  readStashList,
  readSubmoduleList,
  readTagList,
} from './history.js';
import { effectiveConfig } from './config.js';

/** Local (non-network) git command budget. */
const LOCAL_TIMEOUT_MS = 30000;
/** Repository locks: one promise chain per repository path. */
const repoLocks = new Map();
/** Read concurrency cap per repository (contract §4.4). */
const readSlots = createKeyedSemaphore(2);

/**
 * Run a write action while holding the repository's mutex.
 * @template T
 * @param {string} repoPath - repository path used as the lock key.
 * @param {() => Promise<T>} task - the critical section.
 * @returns {Promise<T>}
 */
function writeLocked(repoPath, task) {
  return withLock(repoLocks, repoPath, task);
}

/**
 * Run a read action under the per-repository read semaphore.
 * @template T
 * @param {string} repoPath - repository path used as the key.
 * @param {() => Promise<T>} task - the read.
 * @returns {Promise<T>}
 */
function readLimited(repoPath, task) {
  return readSlots(repoPath, task);
}

/**
 * Combine stdout and stderr into the single `output` string the Client shows.
 * @param {{ stdout: string, stderr: string }} result - a git run result.
 * @returns {string}
 */
function outputOf(result) {
  const parts = [];
  if (result.stdout.trim() !== '') parts.push(result.stdout.replace(/\s+$/, ''));
  if (result.stderr.trim() !== '') parts.push(result.stderr.replace(/\s+$/, ''));
  return parts.join('\n').trim();
}

/**
 * Require a non-empty string parameter.
 * @param {unknown} value - candidate value.
 * @param {string} label - parameter name for the error message.
 * @returns {string} the trimmed value.
 */
function requireString(value, label) {
  if (typeof value !== 'string') throw gitError('E_INVALID_ARG', `${label} must be a string`);
  if (value.includes('\0')) throw gitError('E_INVALID_ARG', `${label} must not contain NUL bytes`);
  const trimmed = value.trim();
  if (trimmed === '') throw gitError('E_INVALID_ARG', `${label} must not be empty`);
  return trimmed;
}

/**
 * Require a non-empty array of repository-relative paths.
 * @param {unknown} value - candidate value.
 * @param {string} [label] - parameter name.
 * @returns {string[]} normalised paths.
 */
function requirePaths(value, label = 'paths') {
  if (!Array.isArray(value) || value.length === 0) throw gitError('E_INVALID_ARG', `${label} must be a non-empty array`);
  if (value.length > 10000) throw gitError('E_INVALID_ARG', `${label} has too many entries`);
  return value.map((entry) => normalizeRepoRelativePath(entry));
}

/**
 * Require a boolean flag, defaulting when absent.
 * @param {unknown} value - candidate value.
 * @param {boolean} fallback - value used when the flag is absent.
 * @returns {boolean}
 */
function flag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true;
}

/**
 * Require a stash index.
 * @param {unknown} value - candidate value.
 * @returns {number} the index.
 */
function requireStashIndex(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 0 || numeric > 100000) {
    throw gitError('E_INVALID_ARG', 'index must be a non-negative integer');
  }
  return numeric;
}

/**
 * Validate a ref name by asking git itself.
 *
 * The name is rejected before spawning when it starts with `-`, so a parameter
 * can never be read as a git option; `git check-ref-format --branch` then
 * applies git's full ref grammar (no `..`, no control characters, no
 * `--upload-pack=` style payloads).
 * @param {string} name - the candidate ref name.
 * @param {{ ctx?: unknown }} options - transport options.
 * @returns {Promise<string>} the validated name.
 */
export async function validateRefName(name, options = {}) {
  const value = requireString(name, 'name');
  if (value.startsWith('-')) throw gitError('E_INVALID_ARG', 'invalid ref name');
  const result = await runGit(null, ['check-ref-format', '--branch', value], { ...options, allowExitCodes: [1, 128] });
  if (result.exitCode !== 0) throw gitError('E_INVALID_ARG', `invalid ref name: ${value}`);
  return value;
}

/**
 * Validate a tag name (which must also satisfy the `refs/tags/` namespace).
 * @param {string} name - the candidate tag name.
 * @param {{ ctx?: unknown }} options - transport options.
 * @returns {Promise<string>} the validated name.
 */
export async function validateTagName(name, options = {}) {
  const value = requireString(name, 'name');
  if (value.startsWith('-')) throw gitError('E_INVALID_ARG', 'invalid tag name');
  const result = await runGit(null, ['check-ref-format', `refs/tags/${value}`], { ...options, allowExitCodes: [1, 128] });
  if (result.exitCode !== 0) throw gitError('E_INVALID_ARG', `invalid tag name: ${value}`);
  return value;
}

/**
 * Validate a remote name: git allows most characters but never whitespace,
 * a leading dash or an empty value.
 * @param {unknown} value - candidate remote name.
 * @returns {string} the validated name.
 */
function validateRemoteName(value) {
  const name = requireString(value, 'name');
  if (name.startsWith('-') || /[\s~^:?*[\\]/.test(name)) throw gitError('E_INVALID_ARG', 'invalid remote name');
  return name;
}

/**
 * Validate a remote URL: it is passed as an argv item, but a leading dash would
 * be read as an option.
 * @param {unknown} value - candidate URL.
 * @returns {string} the validated URL.
 */
function validateRemoteUrl(value) {
  const url = requireString(value, 'url');
  if (url.startsWith('-')) throw gitError('E_INVALID_ARG', 'invalid remote url');
  return url;
}

/**
 * Locate the git directory of a repository.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown }} options - transport options.
 * @returns {Promise<string | null>}
 */
async function gitDirectory(repoPath, options) {
  try {
    const result = await runGit(repoPath, ['rev-parse', '--absolute-git-dir'], options);
    const path = result.stdout.trim();
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

/**
 * Detect the in-progress operation, or null when the repository is idle.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown }} options - transport options.
 * @returns {Promise<object | null>}
 */
async function currentOperation(repoPath, options) {
  const dir = await gitDirectory(repoPath, options);
  if (dir === null) return null;
  return detectOperation(dir);
}

/** Actions that need an existing operation, mapped to the git subcommand. */
const OPERATION_COMMANDS = Object.freeze({
  continue: { merge: ['merge', '--continue'], rebase: ['rebase', '--continue'], 'cherry-pick': ['cherry-pick', '--continue'], revert: ['revert', '--continue'] },
  skip: { rebase: ['rebase', '--skip'], 'cherry-pick': ['cherry-pick', '--skip'], revert: ['revert', '--skip'] },
  abort: { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'], bisect: ['bisect', 'reset'] },
});

/**
 * Resolve the effective configuration for one request.
 *
 * The Client keeps its settings in `localStorage` and sends them along, so a
 * `settings` object on the request overrides the Host defaults for discovery
 * and network behaviour without mutating the plugin config.
 * @param {object} baseConfig - the effective Host configuration.
 * @param {object} request - the request body.
 * @returns {object} the configuration to use for this request.
 */
function requestConfig(baseConfig, request) {
  const settings = request !== null && typeof request === 'object' ? request.settings : undefined;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return baseConfig;
  return effectiveConfig({ ...baseConfig, ...settings });
}

/**
 * Read the scan root implied by the request's session.
 * @param {unknown} ctx - the Host context.
 * @param {object} request - the request body.
 * @returns {Promise<string | null>}
 */
async function sessionCwd(ctx, request) {
  const sessionId = request.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  try {
    const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return null;
    const session = sessions.get(sessionId);
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * Read the directories of the durable workspace registry.
 *
 * These are the folders the user already opened in the harness, so they are the
 * most relevant scan roots: without them a session that runs in an empty
 * workspace sees no repository at all.
 * @param {unknown} ctx - the Host context.
 * @returns {Promise<string[]>} registered workspace paths, in registry order.
 */
async function registeredWorkspacePaths(ctx) {
  try {
    const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return [];
    const workspaces = registry.list();
    if (!Array.isArray(workspaces)) return [];
    const paths = [];
    for (const workspace of workspaces) {
      const path = workspace?.path;
      if (typeof path === 'string' && path !== '' && isAbsolutePath(path)) paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * @param {string} value - candidate path.
 * @returns {boolean} whether it is spelled as an absolute POSIX or Windows path.
 */
function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Dispatch one request body to its action.
 * @param {unknown} ctx - the Host context.
 * @param {object} request - the parsed request body.
 * @param {unknown} [rawConfig] - the plugin configuration.
 * @returns {Promise<object>} the `value` for a successful response.
 */
export async function handleAction(ctx, request, rawConfig) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw gitError('E_INVALID_ARG', 'request body must be an object');
  }
  const action = typeof request.action === 'string' ? request.action : '';
  const config = requestConfig(effectiveConfig(rawConfig), request);
  const local = { ctx, timeoutMs: LOCAL_TIMEOUT_MS };
  const network = { ctx, timeoutMs: config.networkTimeoutMs };

  switch (action) {
    case 'config.get':
      return { config };

    case 'repos.list': {
      const cwd = await sessionCwd(ctx, request);
      const extraRoots = Array.isArray(request.extraRoots) ? await normalizeRoots(request.extraRoots) : [];
      const autoDetect = config.autoRepositoryDetection !== 'false';
      const workspacePaths = await registeredWorkspacePaths(ctx);

      // 1) The folder the user opened is the authority: Source Control is scoped
      //    to it, and the checkouts nested inside it (a workspace that contains a
      //    dozen repositories) are found because this scan descends through the
      //    repositories it meets.
      let primary = { repositories: [], roots: [], truncated: false };
      if (autoDetect && cwd !== null) {
        primary = await discoverRepositories({
          ctx,
          roots: [cwd],
          scanDepth: config.scanDepth,
          descendIntoRepositories: true,
          autoRepositoryDetection: config.autoRepositoryDetection,
        });
      }

      // 2) Explicit roots always count. Only when the opened folder holds no
      //    checkout at all do the registered workspaces (and the checkouts beside
      //    them) join in, so a session running in an empty folder still shows
      //    something instead of an empty panel.
      const fallback = primary.repositories.length === 0;
      const secondaryRoots = fallback ? [...workspacePaths, ...config.roots] : [...config.roots];
      const shallowRoots = fallback && autoDetect ? siblingRoots(workspacePaths, homedir()) : [];
      const secondary = await discoverRepositories({
        ctx,
        roots: secondaryRoots,
        shallowRoots,
        extraRoots,
        scanDepth: config.scanDepth,
        autoRepositoryDetection: config.autoRepositoryDetection,
      });

      const seen = new Set();
      const repos = [];
      for (const repo of [...primary.repositories, ...secondary.repositories]) {
        if (seen.has(repo.path)) continue;
        seen.add(repo.path);
        repos.push(repo);
      }
      const roots = [...new Set([...primary.roots, ...secondary.roots])];
      const payload = {
        repos,
        roots,
        truncated: primary.truncated || secondary.truncated,
        workspaceRoots: workspacePaths,
        scopedToWorkspace: primary.repositories.length > 0,
      };
      // Nothing found: offer the folders under $HOME that do hold checkouts so
      // the empty panel is one click away from showing repositories.
      if (repos.length === 0) {
        payload.suggestedRoots = await suggestScanRoots(homedir());
      }
      return payload;
    }

    case 'repo.init': {
      const target = requireString(request.path, 'path');
      if (!target.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(target)) {
        throw gitError('E_INVALID_ARG', 'path must be an absolute path');
      }
      if (target.split(/[\\/]+/).includes('..')) throw gitError('E_INVALID_ARG', 'path must not contain ..');
      await runGit(null, ['init', target], local);
      invalidateDiscoveryCache();
      const info = await assertRepo(target);
      return { repo: await readSingleRepoInfo(info.path, local) };
    }

    case 'repo.info': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readSingleRepoInfo(info.path, local));
    }

    case 'status': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readStatus(info.path, local));
    }

    case 'diff': {
      const info = await assertRepo(request.repo);
      requireWorkTree(info);
      return readLimited(info.path, () =>
        readDiff(
          info.path,
          {
            path: request.path,
            staged: flag(request.staged),
            rev: typeof request.rev === 'string' && request.rev !== '' ? normalizeRevision(request.rev, 'rev') : undefined,
            context: request.context,
            ignoreWhitespace: flag(request.ignoreWhitespace),
          },
          local,
        ),
      );
    }

    case 'log': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () =>
        readLog(
          info.path,
          { limit: request.limit, skip: request.skip, path: request.path, ref: request.ref },
          local,
        ),
      );
    }

    case 'show': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readShow(info.path, requireString(request.rev, 'rev'), local));
    }

    case 'stage': {
      const info = await assertRepo(request.repo);
      const paths = requirePaths(request.paths);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['add', '--', ...paths], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'unstage': {
      const info = await assertRepo(request.repo);
      const paths = requirePaths(request.paths);
      return writeLocked(info.path, async () => {
        try {
          await runGit(info.path, ['restore', '--staged', '--', ...paths], local);
        } catch (error) {
          if (!isUnbornIndexError(error)) throw error;
          await runGit(info.path, ['rm', '--cached', '-r', '--quiet', '--', ...paths], local);
        }
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'discard': {
      const info = await assertRepo(request.repo);
      const paths = requirePaths(request.paths);
      if (request.confirm !== true) throw gitError('E_INVALID_ARG', 'discard requires confirm: true');
      return writeLocked(info.path, async () => {
        const status = await readStatus(info.path, { ...local, includeStash: false });
        const untracked = new Set(status.untracked.map((entry) => entry.path));
        const tracked = paths.filter((path) => !untracked.has(path));
        const removed = paths.filter((path) => untracked.has(path));
        if (tracked.length > 0) {
          // On an unborn branch there is no HEAD to restore from: dropping the
          // index entry is the only meaningful way to discard a staged add.
          const args = status.unborn
            ? ['rm', '-r', '--cached', '--quiet', '--', ...tracked]
            : ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked];
          await runGit(info.path, args, local);
        }
        if (removed.length > 0) await runGit(info.path, ['clean', '-f', '--', ...removed], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'stageAll': {
      const info = await assertRepo(request.repo);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['add', '-A'], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'unstageAll': {
      const info = await assertRepo(request.repo);
      return writeLocked(info.path, async () => {
        const result = await runGit(info.path, ['reset', '--quiet'], { ...local, allowExitCodes: [128] });
        if (result.exitCode !== 0) await runGit(info.path, ['rm', '-r', '--cached', '--quiet', '--', '.'], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'commit': {
      const info = await assertRepo(request.repo);
      const message = requireString(request.message, 'message');
      const args = ['commit', '-m', message];
      if (flag(request.amend)) args.push('--amend');
      if (flag(request.signoff)) args.push('--signoff');
      if (flag(request.allowEmpty)) args.push('--allow-empty');
      return writeLocked(info.path, async () => {
        // `git commit` with an empty index prints "nothing to commit" on stdout
        // and exits 1, which reads as an opaque failure; refuse up front instead
        // and say what the index actually holds.
        if (!flag(request.amend) && !flag(request.allowEmpty)) {
          const status = await readStatus(info.path, { ...local, includeStash: false });
          if (status.staged.length === 0 && status.conflicted.length === 0) {
            throw gitError(
              'E_NOTHING_TO_COMMIT',
              'there is nothing staged to commit',
              `0 staged, ${status.changed.length} modified, ${status.untracked.length} untracked`,
            );
          }
        }
        try {
          await runGit(info.path, args, { ...local, env: { GIT_EDITOR: 'true' } });
        } catch (error) {
          throw await asHookFailure(info.path, error, COMMIT_HOOKS, local);
        }
        invalidateDiscoveryCache();
        return readHeadCommit(info.path, local);
      });
    }

    case 'branches.list': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readBranches(info.path, { includeRemote: flag(request.includeRemote) }, local));
    }

    case 'branch.create': {
      const info = await assertRepo(request.repo);
      const name = await validateRefName(request.name, local);
      const startPoint =
        typeof request.startPoint === 'string' && request.startPoint !== ''
          ? normalizeRevision(request.startPoint, 'startPoint')
          : null;
      return writeLocked(info.path, async () => {
        if (flag(request.checkout)) {
          const args = ['checkout', '-b', name];
          if (startPoint !== null) args.push(startPoint);
          await runGit(info.path, args, local);
        } else {
          const args = ['branch', name];
          if (startPoint !== null) args.push(startPoint);
          await runGit(info.path, args, local);
        }
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'branch.checkout': {
      const info = await assertRepo(request.repo);
      const name = await validateRefName(request.name, local);
      return writeLocked(info.path, async () => {
        const holder = worktreeHolding(await readWorktrees(info.path, local), name, info.path);
        if (holder !== null) {
          throw gitError('E_BRANCH_IN_USE', `branch ${name} is checked out in ${holder.path}`, holder.path);
        }
        await runGit(info.path, ['checkout', name], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'branch.rename': {
      const info = await assertRepo(request.repo);
      const from = await validateRefName(request.from, local);
      const to = await validateRefName(request.to, local);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['branch', '-m', from, to], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'branch.delete': {
      const info = await assertRepo(request.repo);
      const name = await validateRefName(request.name, local);
      const force = flag(request.force);
      if (force && request.confirm !== true) throw gitError('E_INVALID_ARG', 'force delete requires confirm: true');
      return writeLocked(info.path, async () => {
        const current = await currentBranchName(info.path, local);
        if (current !== null && current === name) {
          throw gitError(
            'E_BRANCH_CURRENT',
            `cannot delete ${name}: it is the branch checked out here`,
            `switch to another branch first, then delete ${name}`,
          );
        }
        const holder = worktreeHolding(await readWorktrees(info.path, local), name, info.path);
        if (holder !== null) {
          throw gitError('E_BRANCH_IN_USE', `branch ${name} is checked out in ${holder.path}`, holder.path);
        }
        try {
          await runGit(info.path, ['branch', force ? '-D' : '-d', name], local);
        } catch (failure) {
          const cause = failure instanceof GitError ? failure : toGitError(failure);
          // git only says "not fully merged"; tell the reader what would be lost.
          if (!force && cause.code === 'E_BRANCH_NOT_MERGED') {
            const detail = await describeUnmergedBranch(info.path, name, local);
            if (detail !== '') throw gitError('E_BRANCH_NOT_MERGED', cause.message, detail);
          }
          throw cause;
        }
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'branch.setUpstream': {
      const info = await assertRepo(request.repo);
      const branch = await validateRefName(request.branch, local);
      const upstream = await validateRefName(request.upstream, local);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['branch', `--set-upstream-to=${upstream}`, branch], local);
        invalidateDiscoveryCache();
        return {};
      });
    }

    case 'fetch': {
      const info = await assertRepo(request.repo);
      const args = ['fetch'];
      if (flag(request.prune)) args.push('--prune');
      if (typeof request.remote === 'string' && request.remote !== '') args.push(validateRemoteName(request.remote));
      return writeLocked(info.path, async () => {
        let result;
        try {
          result = await runGit(info.path, args, network);
        } catch (error) {
          throw await asHookFailure(info.path, error, PUSH_HOOKS, local);
        }
        invalidateDiscoveryCache();
        return { output: outputOf(result) };
      });
    }

    case 'pull': {
      const info = await assertRepo(request.repo);
      const args = ['pull', '--no-edit'];
      if (config.pullStrategy === 'rebase') args.push('--rebase');
      else if (config.pullStrategy === 'ff-only') args.push('--ff-only');
      else args.push('--no-rebase');
      if (typeof request.remote === 'string' && request.remote !== '') args.push(validateRemoteName(request.remote));
      if (typeof request.branch === 'string' && request.branch !== '') args.push(await validateRefName(request.branch, local));
      return writeLocked(info.path, async () => {
        const result = await runGit(info.path, args, { ...network, env: { GIT_EDITOR: 'true' } });
        invalidateDiscoveryCache();
        return { output: outputOf(result), status: await readStatus(info.path, local) };
      });
    }

    case 'push': {
      const info = await assertRepo(request.repo);
      const force = request.force === 'with-lease' ? 'with-lease' : 'none';
      if (force === 'with-lease' && request.confirm !== true) {
        throw gitError('E_INVALID_ARG', 'force push requires confirm: true');
      }
      // `to` answers the one question git refuses to answer for the user when the
      // upstream name differs from the branch name: push to the same name, or to
      // the existing upstream branch.
      const to = request.to === undefined || request.to === null ? undefined : request.to;
      if (to !== undefined && to !== 'same' && to !== 'upstream') {
        throw gitError('E_INVALID_ARG', 'to must be "same" or "upstream"');
      }
      const explicitBranch = typeof request.branch === 'string' && request.branch !== '';
      if (to !== undefined && explicitBranch) {
        throw gitError('E_INVALID_ARG', 'to cannot be combined with an explicit branch');
      }
      return writeLocked(info.path, async () => {
        const remotes = await runGit(info.path, ['remote'], local);
        const remoteNames = remotes.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
        if (remoteNames.length === 0) {
          throw gitError('E_NO_REMOTE', 'this repository has no remote', 'add a remote before pushing');
        }
        const explicitRemote = typeof request.remote === 'string' && request.remote !== '';
        const head = await runGit(info.path, ['symbolic-ref', '--short', '-q', 'HEAD'], {
          ...local,
          allowExitCodes: [1],
        });
        const localBranch = head.stdout.trim();
        const upstream = await runGit(info.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
          ...local,
          allowExitCodes: [1, 128],
        });
        const upstreamRef = upstream.exitCode === 0 ? upstream.stdout.trim() : '';
        const slash = upstreamRef.indexOf('/');
        const upstreamRemote = slash === -1 ? '' : upstreamRef.slice(0, slash);
        const upstreamBranch = slash === -1 ? upstreamRef : upstreamRef.slice(slash + 1);

        if (!explicitBranch && to === undefined) {
          if (!explicitRemote && !flag(request.setUpstream) && upstreamRef === '') {
            throw gitError(
              'E_NO_UPSTREAM',
              'the current branch has no upstream',
              'push again with setUpstream: true to publish it',
            );
          }
          // `push.default=simple` refuses here and prints five lines about
          // push.default; name both branches instead and let the client ask.
          if (upstreamRef !== '' && localBranch !== '' && upstreamBranch !== '' && upstreamBranch !== localBranch) {
            throw gitError(
              'E_UPSTREAM_MISMATCH',
              'the upstream branch does not match the current branch',
              `local branch "${localBranch}" tracks "${upstreamRef}"`,
            );
          }
        }

        const args = ['push'];
        if (flag(request.setUpstream)) args.push('--set-upstream');
        if (force === 'with-lease') args.push('--force-with-lease');
        const remote = explicitRemote
          ? validateRemoteName(request.remote)
          : upstreamRemote !== ''
            ? validateRemoteName(upstreamRemote)
            : remoteNames.length === 1
              ? validateRemoteName(remoteNames[0])
              : '';
        if (remote !== '') args.push(remote);
        if (explicitBranch) {
          args.push(await validateRefName(request.branch, local));
        } else if (to === 'same') {
          if (localBranch === '') {
            throw gitError('E_INVALID_ARG', 'HEAD is detached; pass branch explicitly');
          }
          args.push('HEAD');
        } else if (to === 'upstream') {
          if (upstreamBranch === '') {
            throw gitError('E_NO_UPSTREAM', 'the current branch has no upstream');
          }
          args.push(`HEAD:${upstreamBranch}`);
        }
        const result = await runGit(info.path, args, network);
        invalidateDiscoveryCache();
        return { output: outputOf(result) };
      });
    }

    case 'remote.list': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readRemotes(info.path, local));
    }

    case 'remote.add': {
      const info = await assertRepo(request.repo);
      const name = validateRemoteName(request.name);
      const url = validateRemoteUrl(request.url);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['remote', 'add', name, url], local);
        return {};
      });
    }

    case 'remote.remove': {
      const info = await assertRepo(request.repo);
      const name = validateRemoteName(request.name);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['remote', 'remove', name], local);
        return {};
      });
    }

    case 'remote.setUrl': {
      const info = await assertRepo(request.repo);
      const name = validateRemoteName(request.name);
      const url = validateRemoteUrl(request.url);
      const args = ['remote', 'set-url'];
      if (flag(request.push)) args.push('--push');
      args.push(name, url);
      return writeLocked(info.path, async () => {
        await runGit(info.path, args, local);
        return {};
      });
    }

    case 'stash.list': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readStashList(info.path, local));
    }

    case 'stash.push': {
      const info = await assertRepo(request.repo);
      const args = ['stash', 'push'];
      if (flag(request.includeUntracked)) args.push('-u');
      if (typeof request.message === 'string' && request.message.trim() !== '') args.push('-m', request.message.trim());
      return writeLocked(info.path, async () => {
        await runGit(info.path, args, local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'stash.apply':
    case 'stash.pop':
    case 'stash.drop': {
      const info = await assertRepo(request.repo);
      const index = requireStashIndex(request.index);
      const verb = action.slice('stash.'.length);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['stash', verb, `stash@{${index}}`], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'tag.list': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readTagList(info.path, local));
    }

    case 'tag.create': {
      const info = await assertRepo(request.repo);
      const name = await validateTagName(request.name, local);
      const args = ['tag'];
      const message = typeof request.message === 'string' ? request.message.trim() : '';
      if (message !== '') args.push('-a', name, '-m', message);
      else args.push(name);
      if (typeof request.rev === 'string' && request.rev !== '') args.push(normalizeRevision(request.rev, 'rev'));
      return writeLocked(info.path, async () => {
        await runGit(info.path, args, local);
        return {};
      });
    }

    case 'tag.delete': {
      const info = await assertRepo(request.repo);
      const name = await validateTagName(request.name, local);
      return writeLocked(info.path, async () => {
        await runGit(info.path, ['tag', '-d', name], local);
        return {};
      });
    }

    case 'tag.push': {
      const info = await assertRepo(request.repo);
      const name = await validateTagName(request.name, local);
      const remote = typeof request.remote === 'string' && request.remote !== '' ? validateRemoteName(request.remote) : 'origin';
      return writeLocked(info.path, async () => {
        const result = await runGit(info.path, ['push', remote, `refs/tags/${name}`], network);
        return { output: outputOf(result) };
      });
    }

    case 'conflict.resolve': {
      const info = await assertRepo(request.repo);
      const path = normalizeRepoRelativePath(request.path);
      const side = request.side === 'theirs' ? '--theirs' : request.side === 'ours' ? '--ours' : null;
      if (side === null) throw gitError('E_INVALID_ARG', "side must be 'ours' or 'theirs'");
      return writeLocked(info.path, async () => {
        const status = await readStatus(info.path, { ...local, includeStash: false });
        if (!status.conflicted.some((entry) => entry.path === path)) {
          throw gitError('E_INVALID_ARG', `${path} is not in conflict`, 'only a conflicted path can be resolved by side');
        }
        await runGit(info.path, ['checkout', side, '--', path], local);
        await runGit(info.path, ['add', '--', path], local);
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'operation.continue':
    case 'operation.abort':
    case 'operation.skip': {
      const info = await assertRepo(request.repo);
      const verb = action.slice('operation.'.length);
      const operation = await currentOperation(info.path, local);
      if (operation === null) throw gitError('E_INVALID_ARG', 'no operation is in progress');
      const command = OPERATION_COMMANDS[verb][operation.kind];
      if (command === undefined) throw gitError('E_INVALID_ARG', `a ${operation.kind} operation has no ${verb} step`);
      return writeLocked(info.path, async () => {
        await runGit(info.path, command, { ...local, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
        invalidateDiscoveryCache();
        return { status: await readStatus(info.path, local) };
      });
    }

    case 'submodule.list': {
      const info = await assertRepo(request.repo);
      return readLimited(info.path, () => readSubmoduleList(info.path, local));
    }

    case 'submodule.update': {
      const info = await assertRepo(request.repo);
      return writeLocked(info.path, async () => {
        const result = await runGit(info.path, ['submodule', 'update', '--init', '--recursive'], network);
        return { output: outputOf(result) };
      });
    }

    case 'raw': {
      const info = await assertRepo(request.repo);
      const args = parseRawCommand(request.command);
      if (isDestructiveRaw(args) && request.confirm !== true) {
        throw gitError(
          'E_INVALID_ARG',
          'this raw command discards work or rewrites history',
          'confirm it in the interface before it runs',
        );
      }
      return writeLocked(info.path, async () => {
        const result = await runGit(info.path, args, { ...local, allowAnyExit: true });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
      });
    }

    default:
      throw gitError('E_UNSUPPORTED', `unsupported action: ${action === '' ? '(missing)' : action}`);
  }
}

/**
 * Re-label a generic git failure as a hook failure when a hook for this phase
 * is installed: the hook's own output is the only actionable part, and git
 * itself does not say "hook" in that case.
 * @param {string} repoPath - repository path.
 * @param {unknown} error - the original failure.
 * @param {readonly string[]} phases - hook names that could have run.
 * @param {{ ctx?: unknown, timeoutMs?: number }} options - transport options.
 * @returns {Promise<unknown>} the error to throw.
 */
async function asHookFailure(repoPath, error, phases, options) {
  const code = typeof error === 'object' && error !== null ? error.code : undefined;
  if (code !== 'E_GIT_FAILED') return error;
  const hook = await findInstalledHook(repoPath, phases, options);
  if (hook === null) return error;
  const detail = typeof error === 'object' && error !== null ? error.detail : undefined;
  return gitError('E_HOOK_FAILED', `the ${hook} hook rejected the operation`, detail);
}

/**
 * Recognise the failure `git restore --staged` produces on an unborn branch.
 * @param {unknown} error - the thrown value.
 * @returns {boolean}
 */
function isUnbornIndexError(error) {
  const text = error instanceof Error ? `${error.message} ${error.detail ?? ''}` : String(error);
  return /could not resolve HEAD|Failed to resolve 'HEAD'|ambiguous argument 'HEAD'|unknown revision/i.test(text);
}

/**
 * Expose the last error of a failed action as a one-line string (used by tests).
 * @param {unknown} error - the thrown value.
 * @returns {string}
 */
export function describeFailure(error) {
  return shortError(error);
}
