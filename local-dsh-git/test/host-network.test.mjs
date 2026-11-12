/**
 * Network actions against a local bare repository.
 *
 * `fetch`, `pull`, `push` and `tag.push` are the only actions that talk to a
 * remote. They are exercised here through a `file://`-style bare remote created
 * in a temp directory, so no network access is required and the user's real
 * repositories are never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleAction } from '../git/actions.js';
import { runGit } from '../git/exec.js';

/** Host services are absent in these tests: everything falls back to child_process. */
const NO_SERVICES = { get: () => undefined };

/**
 * Create a repository with one commit on `main`.
 * @param {string} path - absolute directory to initialise.
 * @returns {Promise<string>} the path.
 */
async function initRepo(path) {
  await runGit(null, ['init', '-b', 'main', path]);
  await runGit(path, ['config', 'user.name', 'Test User']);
  await runGit(path, ['config', 'user.email', 'test@example.com']);
  await runGit(path, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(path, 'file.txt'), 'first\n');
  await runGit(path, ['add', '--', 'file.txt']);
  await runGit(path, ['commit', '-m', 'first']);
  return path;
}

/**
 * Create the bare remote and the two clones used by the tests.
 * @returns {Promise<{root: string, remote: string, a: string, b: string}>}
 */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-net-'));
  const remote = join(root, 'remote.git');
  await runGit(null, ['init', '--bare', remote]);
  const a = await initRepo(join(root, 'a'));
  await runGit(a, ['remote', 'add', 'origin', remote]);
  const b = join(root, 'b');
  await runGit(null, ['clone', remote, b]);
  await runGit(b, ['config', 'user.name', 'Test User']);
  await runGit(b, ['config', 'user.email', 'test@example.com']);
  return { root, remote, a, b };
}

/** Call one action and return its value. */
async function act(request) {
  return handleAction(NO_SERVICES, request);
}

test('push publishes the branch and reports git output', async () => {
  const { remote, a } = await setup();
  const pushed = await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  assert.equal(typeof pushed.output, 'string');
  const head = await runGit(remote, ['rev-parse', 'refs/heads/main']);
  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
});

test('a mismatched upstream is named instead of letting git lecture', async () => {
  const { a } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  // Renaming the branch keeps the upstream it tracked, so the names now differ
  // and `push.default=simple` refuses with a five-line message about push.default.
  await runGit(a, ['branch', '-m', 'main', 'dev_1.5.10-voice-dingyuanguang']);

  await assert.rejects(
    act({ action: 'push', repo: a }),
    (error) => {
      assert.equal(error.code, 'E_UPSTREAM_MISMATCH');
      assert.match(error.detail, /"dev_1\.5\.10-voice-dingyuanguang"/);
      assert.match(error.detail, /"origin\/main"/);
      assert.doesNotMatch(error.detail, /push\.default/);
      return true;
    },
  );
});

test('push to the same name creates that remote branch and keeps the upstream', async () => {
  const { remote, a } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  await runGit(a, ['branch', '-m', 'main', 'dev_1.5.10-voice-dingyuanguang']);

  await act({ action: 'push', repo: a, to: 'same' });

  const created = await runGit(remote, ['rev-parse', 'refs/heads/dev_1.5.10-voice-dingyuanguang']);
  assert.equal(created.exitCode, 0);
  // The upstream configuration is not rewritten by a one-off choice.
  const status = await act({ action: 'status', repo: a });
  assert.equal(status.branch, 'dev_1.5.10-voice-dingyuanguang');
  assert.equal(status.upstream, 'origin/main');
});

test('push to the upstream updates the tracked branch instead', async () => {
  const { remote, a } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  await runGit(a, ['branch', '-m', 'main', 'dev_1.5.10-voice-dingyuanguang']);
  await writeFile(join(a, 'second.txt'), 'second\n');
  await runGit(a, ['add', '--', 'second.txt']);
  await runGit(a, ['commit', '-m', 'second']);

  await act({ action: 'push', repo: a, to: 'upstream' });

  const head = await runGit(a, ['rev-parse', 'HEAD']);
  const remoteMain = await runGit(remote, ['rev-parse', 'refs/heads/main']);
  assert.equal(remoteMain.stdout.trim(), head.stdout.trim());
  // The same-name branch was never created on the remote.
  const other = await runGit(remote, ['rev-parse', '--verify', 'refs/heads/dev_1.5.10-voice-dingyuanguang'], {
    allowExitCodes: [1, 128],
  });
  assert.notEqual(other.exitCode, 0);
});

test('fetch updates the remote-tracking refs', async () => {
  const { a, b } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  await runGit(a, ['checkout', '-b', 'feat']);
  await writeFile(join(a, 'feat.txt'), 'feat\n');
  await runGit(a, ['add', '--', 'feat.txt']);
  await runGit(a, ['commit', '-m', 'feat']);
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'feat', setUpstream: true });

  const fetched = await act({ action: 'fetch', repo: b, remote: 'origin', prune: true });
  assert.equal(typeof fetched.output, 'string');
  const { branches } = await act({ action: 'branches.list', repo: b, includeRemote: true });
  assert.ok(branches.some((branch) => branch.fullName === 'refs/remotes/origin/feat' && branch.remote === true));
});

test('pull fast-forwards the local branch and returns a status', async () => {
  const { a, b } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  await runGit(b, ['fetch', 'origin']);
  await runGit(b, ['checkout', '-B', 'main', '--track', 'origin/main']);

  await writeFile(join(a, 'file.txt'), 'second\n');
  await runGit(a, ['add', '--', 'file.txt']);
  await runGit(a, ['commit', '-m', 'second']);
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main' });

  const pulled = await act({ action: 'pull', repo: b, remote: 'origin', branch: 'main' });
  assert.equal(typeof pulled.output, 'string');
  assert.equal(pulled.status.branch, 'main');
  const head = await runGit(b, ['rev-parse', 'HEAD']);
  const remoteHead = await runGit(a, ['rev-parse', 'HEAD']);
  assert.equal(head.stdout.trim(), remoteHead.stdout.trim());
});

test('branch.setUpstream links a local branch to a remote branch', async () => {
  const { a, b } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  await runGit(b, ['fetch', 'origin']);
  await runGit(b, ['branch', '--track', 'tracked', 'origin/main']);

  const linked = await act({ action: 'branch.setUpstream', repo: b, branch: 'tracked', upstream: 'origin/main' });
  assert.deepEqual(linked, {});
  const { branches } = await act({ action: 'branches.list', repo: b });
  const tracked = branches.find((branch) => branch.name === 'tracked');
  assert.equal(tracked.upstream, 'origin/main');
});

test('tag.push publishes a tag to the remote', async () => {
  const { remote, a } = await setup();
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  await act({ action: 'tag.create', repo: a, name: 'v1.0.0', message: 'release' });

  const pushed = await act({ action: 'tag.push', repo: a, name: 'v1.0.0', remote: 'origin' });
  assert.equal(typeof pushed.output, 'string');
  const tag = await runGit(remote, ['rev-parse', 'refs/tags/v1.0.0']);
  assert.match(tag.stdout.trim(), /^[0-9a-f]{40}$/);
});

test('a forced push needs explicit confirmation', async () => {
  const { a } = await setup();
  await assert.rejects(
    act({ action: 'push', repo: a, remote: 'origin', branch: 'main', force: 'with-lease' }),
    (error) => error.code === 'E_INVALID_ARG' && /confirm/.test(error.message),
  );
  await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', setUpstream: true });
  const forced = await act({ action: 'push', repo: a, remote: 'origin', branch: 'main', force: 'with-lease', confirm: true });
  assert.equal(typeof forced.output, 'string');
});
