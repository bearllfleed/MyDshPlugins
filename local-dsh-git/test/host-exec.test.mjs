/**
 * Executor tests: argv assembly, POSIX quoting, command tokenising, the raw
 * command guard, error mapping, and all three transports.
 *
 * The transport tests use small fake Host services, so no git process is
 * needed for the shaping assertions; one real `git --version` run exercises the
 * `node:child_process` fallback that the smoke script relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runGit,
  buildArgv,
  classifyGitFailure,
  parseRawCommand,
  shellQuote,
  tokenizeCommand,
  GitError,
} from '../git/exec.js';

test('buildArgv pins the repository and the pager configuration', () => {
  assert.deepEqual(buildArgv('/tmp/repo', ['status', '--porcelain=v2']), [
    'git',
    '-C',
    '/tmp/repo',
    '--no-pager',
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain=v2',
  ]);
  assert.deepEqual(buildArgv(null, ['init', '/tmp/new']), [
    'git',
    '--no-pager',
    '-c',
    'core.quotepath=false',
    'init',
    '/tmp/new',
  ]);
  assert.deepEqual(buildArgv('', ['--version']), ['git', '--no-pager', '-c', 'core.quotepath=false', '--version']);
  // A path with spaces stays one argv item; no shell means no quoting.
  assert.equal(buildArgv('/tmp/with space', ['status'])[2], '/tmp/with space');
});

test('shellQuote wraps words for a POSIX shell', () => {
  assert.equal(shellQuote('status'), "'status'");
  assert.equal(shellQuote('with space'), "'with space'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('文档 目录'), "'文档 目录'");
  assert.equal(shellQuote('$HOME'), "'$HOME'");
});

test('tokenizeCommand splits quoted and escaped input', () => {
  assert.deepEqual(tokenizeCommand('git status'), ['git', 'status']);
  assert.deepEqual(tokenizeCommand('  git   status  '), ['git', 'status']);
  assert.deepEqual(tokenizeCommand('git commit -m "hello world"'), ['git', 'commit', '-m', 'hello world']);
  assert.deepEqual(tokenizeCommand("git commit -m 'single quoted'"), ['git', 'commit', '-m', 'single quoted']);
  assert.deepEqual(tokenizeCommand('git log --grep="a b"'), ['git', 'log', '--grep=a b']);
  assert.deepEqual(tokenizeCommand('git show HEAD\\~1'), ['git', 'show', 'HEAD~1']);
  assert.deepEqual(tokenizeCommand('git diff "say \\"hi\\""'), ['git', 'diff', 'say "hi"']);
  assert.deepEqual(tokenizeCommand(''), []);
  assert.throws(() => tokenizeCommand('git commit -m "unterminated'), (error) => error instanceof GitError && error.code === 'E_INVALID_ARG');
  assert.throws(() => tokenizeCommand('git status\0'), (error) => error instanceof GitError && error.code === 'E_INVALID_ARG');
});

test('parseRawCommand requires a git line and refuses repository escape flags', () => {
  assert.deepEqual(parseRawCommand('git status --short'), ['status', '--short']);
  assert.deepEqual(parseRawCommand('  git   log  -1 '), ['log', '-1']);
  assert.deepEqual(parseRawCommand('git commit -m "a message"'), ['commit', '-m', 'a message']);
  for (const input of ['', '   ', 'status', 'git', 'git ', 'git --version --git-dir=/tmp/x', 'git -C /tmp/other status', 'git --work-tree=/tmp status']) {
    assert.throws(() => parseRawCommand(input), (error) => error instanceof GitError && error.code === 'E_INVALID_ARG', input);
  }
});

test('classifyGitFailure maps every contract error class', () => {
  const cases = [
    ['fatal: not a git repository (or any of the parent directories): .git', 'E_NOT_REPO'],
    ['fatal: could not read Username for https://example.com: terminal prompts disabled', 'E_AUTH_REQUIRED'],
    ['git@example.com: Permission denied (publickey).', 'E_AUTH_REQUIRED'],
    ['fatal: Unable to create /tmp/repo/.git/index.lock: File exists.', 'E_LOCKED'],
    ['error: Merging is not possible because you have unmerged files.', 'E_CONFLICT'],
    [
      'The upstream branch of your current branch does not match\nthe name of your current branch.',
      'E_UPSTREAM_MISMATCH',
    ],
    ['fatal: something else entirely', 'E_GIT_FAILED'],
  ];
  for (const [stderr, code] of cases) {
    const error = classifyGitFailure({ stderr, exitCode: 128 });
    assert.ok(error instanceof GitError, stderr);
    assert.equal(error.code, code, stderr);
    assert.equal(typeof error.message, 'string');
    // The detail drops git's `error:`/`fatal:` prefix and its `hint:` advice.
    assert.equal(error.detail, stderr.trim().replace(/^(?:error|fatal):\s*/i, ''));
  }
  // A reader should never see the same sentence twice under a localized title.
  const duplicated = classifyGitFailure({
    stderr: "error: the branch 'dev' is not fully merged\nhint: run 'git branch -D dev'\nthe branch 'dev' is not fully merged",
    exitCode: 1,
  });
  assert.equal(duplicated.code, 'E_BRANCH_NOT_MERGED');
  assert.equal(duplicated.detail, "the branch 'dev' is not fully merged");
  assert.equal(classifyGitFailure({ stderr: '', exitCode: 2 }).message, 'git exited with code 2');
  assert.equal(classifyGitFailure({ stderr: 'x', exitCode: null, timedOut: true }).code, 'E_TIMEOUT');
  const missing = classifyGitFailure({ spawnError: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
  assert.equal(missing.code, 'E_NO_GIT');
  const otherSpawn = classifyGitFailure({ spawnError: new Error('boom') });
  assert.equal(otherSpawn.code, 'E_GIT_FAILED');
  assert.equal(classifyGitFailure({ stderr: 'x'.repeat(10000), exitCode: 1 }).detail.length, 2048);
});

/** Build a fake `ctx.subprocess` that records the spec it was handed. */
function fakeSubprocess(behaviour = {}) {
  const calls = [];
  const service = {
    calls,
    spawn(spec) {
      calls.push(spec);
      const { stdout = '', stderr = '', exitCode = 0, hang = false } = behaviour;
      const handle = {
        terminate() {},
        done: hang ? new Promise(() => {}) : Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
      };
      return handle;
    },
  };
  return service;
}

/** Build a fake `ctx.shell` that records the resolved command. */
function fakeShell(behaviour = {}) {
  const commands = [];
  const service = {
    commands,
    resolve(request) {
      commands.push(request);
      return { command: request.command };
    },
    async execute() {
      const { stdout = '', stderr = '', exitCode = 0, timedOut = false } = behaviour;
      return { result: async () => ({ exitCode, timedOut, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } }) };
    },
  };
  return service;
}

test('runGit prefers ctx.subprocess and injects the git environment', async () => {
  const subprocess = fakeSubprocess({ stdout: ' M file.txt\n', exitCode: 0 });
  const ctx = { get: (key) => (key === 'subprocess' ? subprocess : undefined) };
  const result = await runGit('/tmp/repo', ['status', '--porcelain=v2'], { ctx });
  assert.equal(result.stdout, ' M file.txt\n');
  assert.equal(result.exitCode, 0);
  assert.equal(subprocess.calls.length, 1);
  const spec = subprocess.calls[0];
  assert.deepEqual(spec.argv, buildArgv('/tmp/repo', ['status', '--porcelain=v2']));
  assert.equal(spec.cwd, process.cwd());
  assert.equal(spec.stdio.stdin, 'ignore');
  assert.equal(spec.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(spec.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(spec.env.GIT_PAGER, 'cat');
  assert.equal(spec.env.LC_ALL, 'en_US.UTF-8');
  assert.equal(typeof spec.graceMs, 'number');
});

test('runGit maps a non-zero exit and honours allowExitCodes', async () => {
  const failing = fakeSubprocess({ stderr: 'fatal: not a git repository', exitCode: 128 });
  const ctx = { get: (key) => (key === 'subprocess' ? failing : undefined) };
  await assert.rejects(runGit('/tmp/repo', ['status'], { ctx }), (error) => error.code === 'E_NOT_REPO');

  const tolerated = fakeSubprocess({ stdout: '', exitCode: 1 });
  const tolerantCtx = { get: (key) => (key === 'subprocess' ? tolerated : undefined) };
  const result = await runGit('/tmp/repo', ['diff', '--quiet'], { ctx: tolerantCtx, allowExitCodes: [1] });
  assert.equal(result.exitCode, 1);

  const anyExit = await runGit('/tmp/repo', ['rev-parse', '--verify', 'nope'], { ctx: tolerantCtx, allowAnyExit: true });
  assert.equal(anyExit.exitCode, 1);
});

test('runGit falls back to ctx.shell with quoted argv', async () => {
  const shell = fakeShell({ stdout: 'ok\n', exitCode: 0 });
  const ctx = { get: (key) => (key === 'shell' ? shell : undefined) };
  const result = await runGit('/tmp/with space', ['log', '--format=%s'], { ctx });
  assert.equal(result.stdout, 'ok\n');
  assert.equal(shell.commands.length, 1);
  assert.equal(
    shell.commands[0].command,
    ["'git'", "'-C'", "'/tmp/with space'", "'--no-pager'", "'-c'", "'core.quotepath=false'", "'log'", "'--format=%s'"].join(' '),
  );
  assert.equal(shell.commands[0].workdir, process.cwd());
  assert.equal(shell.commands[0].env.GIT_TERMINAL_PROMPT, '0');
});

test('runGit reports a timeout when the transport hangs', async () => {
  const subprocess = fakeSubprocess({ hang: true });
  const ctx = { get: (key) => (key === 'subprocess' ? subprocess : undefined) };
  await assert.rejects(runGit('/tmp/repo', ['status'], { ctx, timeoutMs: 20 }), (error) => error.code === 'E_TIMEOUT');
});

test('runGit rejects empty argument lists and runs git without any context', async () => {
  await assert.rejects(runGit('/tmp/repo', []), (error) => error.code === 'E_INVALID_ARG');
  const result = await runGit(null, ['--version'], { timeoutMs: 20000 });
  assert.match(result.stdout, /git version \d+\./);
  assert.equal(result.exitCode, 0);
  await assert.rejects(
    runGit(null, ['rev-parse', '--verify', 'definitely-not-a-revision'], { timeoutMs: 20000 }),
    // Depending on the invocation directory this is either "not a repository"
    // or "unknown revision"; both must surface as a coded failure with detail.
    (error) => ['E_NOT_REPO', 'E_GIT_FAILED'].includes(error.code) && error.detail.length > 0,
  );
});
