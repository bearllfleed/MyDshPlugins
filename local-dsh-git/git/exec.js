/**
 * The single git execution seam for the dsh-git Host half.
 *
 * Preferred path: `ctx.subprocess.spawn` with a fully specified argv — no shell
 * is involved, so paths, refs and messages never need quoting. When that service
 * is absent the executor falls back to `ctx.shell` (argv quoted for POSIX), and
 * when neither exists (unit tests, the smoke script) it uses `node:child_process`
 * directly. All three paths return the same shape and share one error mapping.
 */
import { spawn } from 'node:child_process';
import {
  GitError,
  gitError,
  shellQuote,
  tokenizeCommand,
  truncateText,
} from './util.js';

export { GitError, shellQuote, tokenizeCommand };

/** Environment every git invocation gets, regardless of transport. */
const GIT_ENVIRONMENT = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'en_US.UTF-8',
});

/** Default stdout/stderr collection budgets. */
const DEFAULT_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 512 * 1024;
/** Default wall-clock budget for a local git command. */
const DEFAULT_TIMEOUT_MS = 30000;
/** How long a killed git process may take to actually go away. */
const TERMINATION_GRACE_MS = 2000;

/**
 * @typedef {{ stdout: string, stderr: string, exitCode: number | null, lossy: boolean }} GitRunResult
 */

/**
 * Build the argv prefix shared by every invocation.
 * @param {string | null} repoPath - repository to run in, or null for commands
 *   that must not be anchored to a repository (`init`, `check-ref-format`).
 * @param {string[]} args - the git subcommand and its arguments.
 * @returns {string[]}
 */
export function buildArgv(repoPath, args) {
  const argv = ['git'];
  if (typeof repoPath === 'string' && repoPath !== '') argv.push('-C', repoPath);
  argv.push('--no-pager', '-c', 'core.quotepath=false');
  for (const argument of args) argv.push(String(argument));
  return argv;
}

/**
 * Read a service off the context without letting a provider throw through.
 * @param {unknown} ctx - the Host context (may be undefined in tests).
 * @param {string} key - service key.
 * @returns {any} the service or undefined.
 */
function safeGet(ctx, key) {
  try {
    const get = ctx?.get;
    if (typeof get !== 'function') return undefined;
    return get.call(ctx, key);
  } catch {
    return undefined;
  }
}

/**
 * Non-consuming read of one collected stream.
 * @param {any} handle - the subprocess handle.
 * @param {'stdout' | 'stderr'} name - stream to read.
 * @returns {{ text: string, lossy: boolean }}
 */
function readCollected(handle, name) {
  try {
    const reader = handle?.collected?.[name];
    if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') {
      return { text: '', lossy: false };
    }
    const read = reader.readFrom(0);
    return {
      text: typeof read?.text === 'string' ? read.text : '',
      lossy: read?.lossy === true,
    };
  } catch {
    return { text: '', lossy: false };
  }
}

/**
 * Run through `ctx.subprocess.spawn`.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, spawnError: unknown, lossy: boolean }>}
 */
async function runThroughSubprocess(subprocess, argv, cwd, env, timeoutMs, stdoutMaxBytes, stderrMaxBytes) {
  const controller = new AbortController();
  let timedOut = false;
  let handle;
  let signalAborted;
  const aborted = new Promise((resolve) => {
    signalAborted = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    signalAborted();
    try {
      handle?.terminate();
    } catch {
      // The abort signal already asked the provider to stop; nothing else to do.
    }
  }, timeoutMs);
  try {
    handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: stdoutMaxBytes },
        stderr: { maxBytes: stderrMaxBytes },
      },
      graceMs: TERMINATION_GRACE_MS,
      signal: controller.signal,
      env,
    });
  } catch (error) {
    clearTimeout(timer);
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: error, lossy: false };
  }
  let outcome;
  let failure;
  // The provider normally rejects `done` once the signal aborts; racing the
  // abort keeps a stuck child from holding the request forever either way.
  const done = handle.done;
  if (done !== null && typeof done === 'object' && typeof done.catch === 'function') {
    done.catch(() => {});
  }
  try {
    outcome = await Promise.race([done, aborted]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    try {
      handle.terminate();
    } catch {
      // Already gone.
    }
  }
  if (timedOut) {
    return {
      stdout: readCollected(handle, 'stdout').text,
      stderr: readCollected(handle, 'stderr').text,
      exitCode: null,
      timedOut: true,
      spawnError: null,
      lossy: false,
    };
  }
  const stdout = readCollected(handle, 'stdout');
  const stderr = readCollected(handle, 'stderr');
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
    timedOut,
    spawnError: failure,
    lossy: stdout.lossy || stderr.lossy,
  };
}

/**
 * Run through `ctx.shell`, quoting each argv item for POSIX.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, spawnError: unknown, lossy: boolean }>}
 */
async function runThroughShell(shell, argv, cwd, env, timeoutMs, stdoutMaxBytes) {
  const command = argv.map((item) => shellQuote(item)).join(' ');
  try {
    const spec = shell.resolve({
      command,
      workdir: cwd,
      timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes,
      env,
    });
    const execution = await shell.execute(spec);
    const result = await execution.result();
    return {
      stdout: typeof result?.stdout?.text === 'string' ? result.stdout.text : '',
      stderr: typeof result?.stderr?.text === 'string' ? result.stderr.text : '',
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
      timedOut: result?.timedOut === true,
      spawnError: null,
      lossy: result?.stdout?.truncated === true || result?.stderr?.truncated === true,
    };
  } catch (error) {
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: error, lossy: false };
  }
}

/**
 * Run through `node:child_process` — the last-resort transport used by unit
 * tests and `test/smoke.mjs`, which have no Host context at all.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, spawnError: unknown, lossy: boolean }>}
 */
function runThroughChildProcess(argv, cwd, env, timeoutMs, stdoutMaxBytes, stderrMaxBytes) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: error, lossy: false });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lossy = false;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdoutBytes + chunk.length > stdoutMaxBytes) {
        lossy = true;
        const room = Math.max(0, stdoutMaxBytes - stdoutBytes);
        if (room > 0) stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes = stdoutMaxBytes;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderrBytes + chunk.length > stderrMaxBytes) {
        lossy = true;
        const room = Math.max(0, stderrMaxBytes - stderrBytes);
        if (room > 0) stderrChunks.push(chunk.subarray(0, room));
        stderrBytes = stderrMaxBytes;
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: typeof code === 'number' ? code : null,
        timedOut,
        spawnError,
        lossy,
      });
    });
  });
}

/**
 * stderr (and, when stderr is silent, stdout) fragments that identify a failure
 * class. Order matters: the first matching entry wins, so the specific cases
 * (`used by worktree`) are listed before the generic ones (`already exists`).
 *
 * The mapping exists because `git` explains refusals in prose that names a
 * command the user cannot type here — the Client localizes `code` instead and
 * shows the raw text as detail.
 */
const FAILURE_PATTERNS = Object.freeze([
  { code: 'E_NOT_REPO', needles: ['not a git repository'] },
  { code: 'E_BARE_REPO', needles: ['must be run in a work tree', 'bare repository has no work tree'] },
  {
    code: 'E_AUTH_REQUIRED',
    needles: [
      'could not read username',
      'could not read password',
      'authentication failed',
      'permission denied (publickey)',
      'terminal prompts disabled',
    ],
  },
  { code: 'E_LOCKED', needles: ['index.lock', 'unable to create', 'another git process'] },
  {
    code: 'E_HOOK_FAILED',
    needles: ['pre-commit hook', 'commit-msg hook', 'prepare-commit-msg hook', 'pre-push hook', 'hook exited with code', 'husky', 'lint-staged'],
  },
  {
    code: 'E_BRANCH_IN_USE',
    needles: ['used by worktree', 'is already used by worktree', 'already checked out at', 'checked out at'],
  },
  { code: 'E_BRANCH_NOT_MERGED', needles: ['is not fully merged', 'not fully merged'] },
  {
    code: 'E_NOTHING_TO_COMMIT',
    needles: ['nothing to commit', 'no changes added to commit', 'nothing added to commit', 'nothing to amend'],
  },
  {
    code: 'E_DIRTY_TREE',
    needles: [
      'would be overwritten by checkout',
      'would be overwritten by merge',
      'would be overwritten by rebase',
      'your local changes to the following files would be',
      'please commit your changes or stash them',
      'please, commit your changes or stash them',
    ],
  },
  {
    code: 'E_REJECTED',
    needles: ['[rejected]', 'non-fast-forward', 'fetch first', 'updates were rejected', 'protected branch'],
  },
  {
    code: 'E_DIVERGED',
    needles: ['not possible to fast-forward', 'have diverged', 'cannot fast-forward', 'divergent branches'],
  },
  {
    code: 'E_UPSTREAM_MISMATCH',
    needles: [
      'the upstream branch of your current branch does not match',
      'upstream branch of your current branch does not match',
    ],
  },
  {
    code: 'E_NO_UPSTREAM',
    needles: ['has no upstream branch', 'no upstream configured', 'no tracking information', 'no upstream branch'],
  },
  {
    code: 'E_NO_REMOTE',
    needles: ['no configured push destination', 'does not appear to be a git repository', 'no remote'],
  },
  {
    code: 'E_ALREADY_EXISTS',
    needles: ['already exists', 'already a branch', 'tag already exists'],
  },
  {
    code: 'E_NOT_FOUND',
    needles: [
      'no branch named',
      'did not match any file(s) known to git',
      'did not match any files',
      'is not a valid reference',
      'not a valid object name',
      'unknown revision',
      'bad revision',
      'ambiguous argument',
      'not found',
      'does not exist',
      'no such remote',
      'couldn\'t find remote ref',
      'invalid reference',
    ],
  },
  {
    code: 'E_CONFLICT',
    needles: ['automatic merge failed', 'fix conflicts', 'you have unmerged files', 'needs merge', 'conflict ('],
  },
]);

/**
 * Map a failed invocation onto the contract's error code table.
 * @param {{ stdout?: string, stderr?: string, exitCode?: number | null, timedOut?: boolean, spawnError?: unknown }} failure - observed facts.
 * @returns {GitError}
 */
export function classifyGitFailure(failure) {
  const { stdout = '', stderr = '', exitCode = null, timedOut = false, spawnError = null } = failure ?? {};
  if (timedOut === true) return gitError('E_TIMEOUT', 'git command timed out');
  if (spawnError !== null && spawnError !== undefined) {
    const code = typeof spawnError === 'object' && spawnError !== null ? spawnError.code : undefined;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return gitError('E_NO_GIT', 'git executable is not available', describe(spawnError));
    }
    return gitError('E_GIT_FAILED', 'git command failed to start', describe(spawnError));
  }
  const errorText = typeof stderr === 'string' ? stderr : '';
  const outputText = typeof stdout === 'string' ? stdout : '';
  // `git commit` reports "nothing to commit" on stdout, so classification has to
  // look at both streams; the detail prefers stderr and falls back to stdout.
  // `hint:` lines are advisory prose that names outcomes that did NOT happen
  // ("a branch that already exists"), so they are stripped before matching.
  const haystack = stripHints(`${errorText}\n${outputText}`).toLowerCase();
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.needles.some((needle) => haystack.includes(needle))) {
      return gitError(pattern.code, shortMessageFor(pattern.code), cleanDetail(errorText) || cleanDetail(outputText));
    }
  }
  return gitError(
    'E_GIT_FAILED',
    `git exited with code ${exitCode === null ? 'unknown' : exitCode}`,
    cleanDetail(errorText) || cleanDetail(outputText),
  );
}

/**
 * Drop git's `hint:` advisory lines.
 * @param {string} text - raw output.
 * @returns {string}
 */
function stripHints(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('hint:'))
    .join('\n');
}

/**
 * @param {string} code - a contract error code.
 * @returns {string} a short English message.
 */

function shortMessageFor(code) {
  switch (code) {
    case 'E_NOT_REPO':
      return 'directory is not a git repository';
    case 'E_BARE_REPO':
      return 'a bare repository has no working tree';
    case 'E_AUTH_REQUIRED':
      return 'git requires authentication';
    case 'E_LOCKED':
      return 'the repository index is locked';
    case 'E_HOOK_FAILED':
      return 'a git hook rejected the operation';
    case 'E_NOTHING_TO_COMMIT':
      return 'there is nothing to commit';
    case 'E_BRANCH_CURRENT':
      return 'the branch is the one checked out here';
    case 'E_BRANCH_IN_USE':
      return 'the branch is checked out in another worktree';
    case 'E_BRANCH_NOT_MERGED':
      return 'the branch is not fully merged';
    case 'E_DIRTY_TREE':
      return 'local changes would be overwritten';
    case 'E_ALREADY_EXISTS':
      return 'the target already exists';
    case 'E_NOT_FOUND':
      return 'the target does not exist';
    case 'E_NO_UPSTREAM':
      return 'the branch has no upstream';
    case 'E_NO_REMOTE':
      return 'no remote is configured for this operation';
    case 'E_REJECTED':
      return 'the remote rejected the push';
    case 'E_DIVERGED':
      return 'the local and remote branches have diverged';
    case 'E_CONFLICT':
      return 'the operation stopped on a conflict';
    default:
      return 'git command failed';
  }
}

/** @param {string} text - stderr. @returns {string} the last 4KB, trimmed. */
/**
 * Turn git's stderr into the few lines worth surfacing.
 *
 * `hint:` lines are advice about what was NOT done, and `error:`/`fatal:`
 * prefixes repeat the sentence the caller already reports; a reader should not
 * see the same English sentence three times under a localized title.
 * @param {unknown} text - raw stream text.
 * @returns {string}
 */
function cleanDetail(text) {
  if (typeof text !== 'string' || text === '') return '';
  const seen = new Set();
  const lines = [];
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.toLowerCase().startsWith('hint:')) continue;
    const line = trimmed.replace(/^(?:error|fatal):\s*/i, '');
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return truncateText(lines.join('\n'), 2048).text.trim();
}

function tail(text) {
  if (typeof text !== 'string' || text === '') return '';
  const clipped = truncateText(text, 4096);
  return clipped.text.trim();
}

/** @param {unknown} error - a thrown value. @returns {string} a display string. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * @typedef {{
 *   ctx?: unknown,
 *   timeoutMs?: number,
 *   stdoutMaxBytes?: number,
 *   stderrMaxBytes?: number,
 *   allowExitCodes?: number[],
 *   allowAnyExit?: boolean,
 *   env?: Record<string, string>,
 *   cwd?: string,
 * }} RunGitOptions
 */

/**
 * Run one git command and return its collected output.
 *
 * Resolves for exit code 0, for any code listed in `allowExitCodes`, and for
 * every code when `allowAnyExit` is set. Rejects with a GitError for every
 * failure class in the contract, including timeouts and a missing git binary.
 * @param {string | null} repoPath - repository path, or null for repo-less commands.
 * @param {string[]} args - the git subcommand and its arguments.
 * @param {RunGitOptions} [options] - transport and budget overrides.
 * @returns {Promise<GitRunResult>}
 */
export async function runGit(repoPath, args, options = {}) {
  if (!Array.isArray(args) || args.length === 0) throw gitError('E_INVALID_ARG', 'git arguments are required');
  const ctx = options.ctx;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const stdoutMaxBytes = Number.isFinite(options.stdoutMaxBytes) && options.stdoutMaxBytes > 0 ? Math.trunc(options.stdoutMaxBytes) : DEFAULT_STDOUT_BYTES;
  const stderrMaxBytes = Number.isFinite(options.stderrMaxBytes) && options.stderrMaxBytes > 0 ? Math.trunc(options.stderrMaxBytes) : DEFAULT_STDERR_BYTES;
  const env = { ...process.env, ...GIT_ENVIRONMENT, ...(options.env ?? {}) };
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd();
  const argv = buildArgv(repoPath, args);

  const subprocess = safeGet(ctx, 'subprocess');
  let observed;
  if (subprocess !== undefined && subprocess !== null && typeof subprocess.spawn === 'function') {
    observed = await runThroughSubprocess(subprocess, argv, cwd, env, timeoutMs, stdoutMaxBytes, stderrMaxBytes);
  } else {
    const shell = safeGet(ctx, 'shell');
    if (shell !== undefined && shell !== null && typeof shell.resolve === 'function' && typeof shell.execute === 'function') {
      observed = await runThroughShell(shell, argv, cwd, env, timeoutMs, stdoutMaxBytes);
    } else {
      observed = await runThroughChildProcess(argv, cwd, env, timeoutMs, stdoutMaxBytes, stderrMaxBytes);
    }
  }

  const allowExitCodes = Array.isArray(options.allowExitCodes) ? options.allowExitCodes : [];
  const tolerated =
    observed.timedOut === true
      ? false
      : observed.exitCode === 0 ||
        options.allowAnyExit === true ||
        (observed.exitCode !== null && allowExitCodes.includes(observed.exitCode));
  if (!tolerated) throw classifyGitFailure(observed);
  return {
    stdout: observed.stdout,
    stderr: observed.stderr,
    exitCode: observed.exitCode,
    lossy: observed.lossy === true,
  };
}

/**
 * Raw commands that discard work or rewrite published history. `raw` is an
 * escape hatch, so it cannot rely on the per-action confirm flags; these
 * patterns are matched against the joined argv and force an explicit confirm.
 *
 * The sources are plain regex strings so `client.js` can embed the identical
 * list (and `test/host-failures.test.mjs` asserts the two stay in sync).
 */
export const DESTRUCTIVE_RAW_PATTERNS = Object.freeze([
  'push\\b.*(--force|-f\\b|--force-with-lease|--mirror)',
  'push\\b.*\\+\\S+',
  'reset\\b.*--hard',
  'clean\\b.*-[a-z]*f',
  'branch\\b.*(-D\\b|--delete\\b.*--force)',
  'update-ref\\b.*(-d\\b|--delete)',
  'filter-branch|filter-repo',
  'reflog\\b.*expire',
  'gc\\b.*--prune',
  'worktree\\b.*remove\\b.*--force',
  'stash\\b.*(drop|clear)',
]);

/**
 * True when a raw command discards work or rewrites history.
 * @param {readonly string[]} args - argv after `git`.
 * @returns {boolean}
 */
export function isDestructiveRaw(args) {
  const joined = args.join(' ');
  return DESTRUCTIVE_RAW_PATTERNS.some((source) => new RegExp(source).test(joined));
}

/** Arguments that would let a raw command escape the repository it was pinned to. */
const FORBIDDEN_RAW_ARGUMENTS = Object.freeze(['--git-dir', '--work-tree', '--namespace', '--exec-path', '-C']);

/**
 * Lex a user-typed `git ...` line into the argv that follows the fixed prefix.
 *
 * The line is tokenised, never executed by a shell. The first token must be
 * `git`, and arguments that would re-point git at another repository are
 * refused so a raw command cannot leave the repository the Client selected.
 * @param {unknown} command - the user's input line.
 * @returns {string[]} git arguments (without the leading `git`).
 */
export function parseRawCommand(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) throw gitError('E_INVALID_ARG', 'command must not be empty');
  if (tokens[0] !== 'git') throw gitError('E_INVALID_ARG', 'command must start with git');
  const args = tokens.slice(1);
  if (args.length === 0) throw gitError('E_INVALID_ARG', 'command must include git arguments');
  for (const argument of args) {
    const flag = argument.split('=')[0];
    if (FORBIDDEN_RAW_ARGUMENTS.includes(flag)) {
      throw gitError('E_INVALID_ARG', `raw command must not use ${flag}`);
    }
  }
  return args;
}
