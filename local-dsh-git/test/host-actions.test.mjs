/**
 * Action-dispatch integration tests.
 *
 * Each test builds a throwaway repository under `os.tmpdir()` and drives the
 * real `handleAction` entry point with no Host context, which makes the
 * executor use its `node:child_process` transport. Every contract §4.1 action
 * that works without a network is covered, together with the argument guards
 * (confirm flags, ref grammar, path containment) and the write mutex.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAction } from '../git/actions.js';
import { runGit } from '../git/exec.js';
import { GitError } from '../git/util.js';

/** A Host context without services: every transport falls back to child_process. */
const NO_SERVICES = { get: () => undefined };

/** Create a temporary directory removed when the test ends. */
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Initialise a repository with local identity and a deterministic branch. */
async function initRepo(path) {
  await runGit(null, ['init', '-b', 'main', path]);
  await runGit(path, ['config', 'user.name', 'DSH Git Test']);
  await runGit(path, ['config', 'user.email', 'dsh-git@example.com']);
  return path;
}

/** Create a repository with one commit holding `file` and `content`. */
async function seededRepo(t, file = 'tracked.txt', content = 'one\n') {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'repo'));
  await writeFile(join(repo, file), content);
  await runGit(repo, ['add', '--', file]);
  await runGit(repo, ['commit', '-m', 'first']);
  return repo;
}

/** Dispatch one action through the real handler. */
function act(request, ctx = NO_SERVICES) {
  return handleAction(ctx, request);
}

/** Assert that a promise rejects with a specific contract error code. */
async function rejectsWith(promise, code, label) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GitError, `${label}: expected GitError, got ${error}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return true;
  });
}

test('config.get returns clamped defaults and honours request settings', async () => {
  const defaults = await act({ action: 'config.get' });
  assert.deepEqual(defaults.config, {
    scanDepth: 5,
    statusPollMs: 3000,
    networkTimeoutMs: 60000,
    pullStrategy: 'merge',
    autoRepositoryDetection: 'true',
    roots: [],
  });

  const custom = await act({
    action: 'config.get',
    settings: { scanDepth: 99, statusPollMs: 10, networkTimeoutMs: 1, pullStrategy: 'rebase', roots: ['/tmp', 'relative'] },
  });
  assert.equal(custom.config.scanDepth, 10);
  assert.equal(custom.config.statusPollMs, 1000);
  assert.equal(custom.config.networkTimeoutMs, 5000);
  assert.equal(custom.config.pullStrategy, 'rebase');
  assert.deepEqual(custom.config.roots, ['/tmp']);

  const fromPatch = await handleAction(NO_SERVICES, { action: 'config.get' }, { scanDepth: 2, autoRepositoryDetection: false });
  assert.equal(fromPatch.config.scanDepth, 2);
  assert.equal(fromPatch.config.autoRepositoryDetection, 'false');
});

test('repos.list uses extra roots, session cwd and the detection switch', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'alpha'));

  const explicit = await act({
    action: 'repos.list',
    extraRoots: [repo],
    settings: { autoRepositoryDetection: 'false' },
  });
  assert.deepEqual(explicit.repos.map((entry) => entry.path), [repo]);
  // The returned roots are the effective scan roots: the explicit extra root here.
  assert.deepEqual(explicit.roots, [repo]);
  assert.equal(explicit.truncated, false);
  assert.equal(explicit.repos[0].branch, 'main');

  const sessions = {
    get: (id) => (id === 'session-1' ? { header: { cwd: root } } : undefined),
  };
  const sessionCtx = { get: (key) => (key === 'sessions' ? sessions : undefined) };
  const scanned = await act({ action: 'repos.list', sessionId: 'session-1', settings: { scanDepth: 2 } }, sessionCtx);
  assert.deepEqual(scanned.roots, [root]);
  assert.deepEqual(scanned.repos.map((entry) => entry.path), [repo]);
  assert.equal(scanned.repos[0].unborn, true);
  assert.equal(scanned.repos[0].name, 'alpha');
});

test('repo.init, repo.info and status describe a fresh repository', async (t) => {
  const root = await workspace(t);
  const target = join(root, 'created');
  const created = await act({ action: 'repo.init', path: target });
  assert.equal(created.repo.path, target);
  assert.equal(created.repo.unborn, true);
  assert.equal(created.repo.branch, 'main');

  const info = await act({ action: 'repo.info', repo: target });
  assert.equal(info.path, target);
  assert.equal(info.kind, 'repo');
  assert.equal(info.changed, 0);

  await writeFile(join(target, 'a.txt'), 'hello\n');
  const status = await act({ action: 'status', repo: target });
  assert.equal(status.repo, target);
  assert.equal(status.branch, 'main');
  assert.equal(status.unborn, true);
  assert.equal(status.head, null);
  assert.equal(status.detached, false);
  assert.equal(status.operation, null);
  assert.deepEqual(status.staged, []);
  assert.deepEqual(status.changed, []);
  assert.deepEqual(status.untracked, [{ path: 'a.txt', status: '?', staged: false }]);
  assert.deepEqual(status.conflicted, []);
  assert.equal(status.stashCount, 0);

  await rejectsWith(act({ action: 'repo.init', path: 'relative/dir' }), 'E_INVALID_ARG', 'relative init path');
  await rejectsWith(act({ action: 'repo.info', repo: join(root, 'missing') }), 'E_NOT_REPO', 'missing repo');
  await rejectsWith(act({ action: 'status', repo: `${target}/../elsewhere` }), 'E_INVALID_ARG', 'traversal repo');
});

test('stage, unstage, stageAll, unstageAll and discard move entries between buckets', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'two\n');
  await writeFile(join(repo, 'new.txt'), 'fresh\n');

  const staged = await act({ action: 'stage', repo, paths: ['tracked.txt'] });
  assert.deepEqual(staged.status.staged, [{ path: 'tracked.txt', status: 'M', staged: true }]);
  assert.deepEqual(staged.status.changed, []);
  assert.equal(staged.status.untracked.length, 1);

  const unstaged = await act({ action: 'unstage', repo, paths: ['tracked.txt'] });
  assert.deepEqual(unstaged.status.staged, []);
  assert.deepEqual(unstaged.status.changed, [{ path: 'tracked.txt', status: 'M', staged: false }]);

  const allStaged = await act({ action: 'stageAll', repo });
  assert.equal(allStaged.status.staged.length, 2);
  assert.deepEqual(allStaged.status.untracked, []);

  const allUnstaged = await act({ action: 'unstageAll', repo });
  assert.deepEqual(allUnstaged.status.staged, []);
  assert.equal(allUnstaged.status.changed.length, 1);
  assert.equal(allUnstaged.status.untracked.length, 1);

  await rejectsWith(act({ action: 'discard', repo, paths: ['tracked.txt'] }), 'E_INVALID_ARG', 'discard without confirm');
  const discarded = await act({ action: 'discard', repo, paths: ['tracked.txt', 'new.txt'], confirm: true });
  assert.deepEqual(discarded.status.changed, []);
  assert.deepEqual(discarded.status.untracked, []);
  assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'one\n');

  await rejectsWith(act({ action: 'stage', repo, paths: ['../outside.txt'] }), 'E_INVALID_ARG', 'stage traversal');
  await rejectsWith(act({ action: 'stage', repo, paths: ['/etc/passwd'] }), 'E_INVALID_ARG', 'stage absolute');
  await rejectsWith(act({ action: 'stage', repo, paths: [] }), 'E_INVALID_ARG', 'stage empty');
});

test('commit, log, show and diff round-trip through real git output', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'added.txt'), 'brand new\n');

  // A pathless diff covers tracked changes; an untracked file is rendered
  // through `--no-index` when the Client asks for that one path.
  const diff = await act({ action: 'diff', repo });
  assert.equal(diff.files.length, 1);
  const tracked = diff.files[0];
  assert.equal(tracked.path, 'tracked.txt');
  assert.equal(tracked.added, 1);
  assert.equal(tracked.removed, 0);
  assert.equal(tracked.binary, false);
  assert.match(tracked.header, /^diff --git a\/tracked\.txt b\/tracked\.txt/);
  assert.equal(diff.truncated, false);

  const untrackedDiff = await act({ action: 'diff', repo, path: 'added.txt' });
  assert.equal(untrackedDiff.files.length, 1);
  assert.equal(untrackedDiff.files[0].path, 'added.txt');
  assert.equal(untrackedDiff.files[0].added, 1);
  assert.match(untrackedDiff.text, /\+brand new/);

  const stagedDiff = await act({ action: 'diff', repo, staged: true });
  assert.deepEqual(stagedDiff.files, []);

  await act({ action: 'stageAll', repo });
  const cachedDiff = await act({ action: 'diff', repo, staged: true });
  assert.equal(cachedDiff.files.length, 2);

  const commit = await act({ action: 'commit', repo, message: 'second commit' });
  assert.match(commit.hash, /^[0-9a-f]{40}$/);
  assert.equal(commit.subject, 'second commit');

  const log = await act({ action: 'log', repo, limit: 1 });
  assert.equal(log.commits.length, 1);
  assert.equal(log.commits[0].hash, commit.hash);
  assert.equal(log.commits[0].subject, 'second commit');
  assert.equal(log.commits[0].parents.length, 1);
  assert.equal(log.hasMore, true);

  const all = await act({ action: 'log', repo });
  assert.equal(all.commits.length, 2);
  assert.equal(all.hasMore, false);
  assert.equal(all.commits[1].subject, 'first');

  const show = await act({ action: 'show', repo, rev: 'HEAD' });
  assert.equal(show.commit.hash, commit.hash);
  assert.match(show.body, /second commit/);
  assert.ok(show.files.some((file) => file.path === 'added.txt'));

  await rejectsWith(act({ action: 'show', repo, rev: 'no-such-rev' }), 'E_NOT_FOUND', 'bad rev');
  await rejectsWith(act({ action: 'commit', repo, message: '   ' }), 'E_INVALID_ARG', 'empty message');
});

test('a commit diff shows what the commit changed, not the untouched work tree', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'repo'));
  const nested = join(repo, 'lib', 'common', 'voice', 'voice_field.dart');
  await mkdir(join(repo, 'lib', 'common', 'voice'), { recursive: true });
  await writeFile(nested, 'line one\n');
  await runGit(repo, ['add', '--', 'lib/common/voice/voice_field.dart']);
  await runGit(repo, ['commit', '-m', 'add voice field']);
  const added = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  // The file still matches its commit, so a work-tree comparison would be
  // empty; the commit view must show the commit's own patch instead.
  const oneFile = await act({ action: 'diff', repo, rev: added, path: 'lib/common/voice/voice_field.dart' });
  assert.equal(oneFile.files.length, 1);
  assert.equal(oneFile.files[0].path, 'lib/common/voice/voice_field.dart');
  assert.equal(oneFile.files[0].added, 1);
  assert.match(oneFile.text, /\+line one/);

  const whole = await act({ action: 'diff', repo, rev: added });
  assert.equal(whole.files.length, 1);
  assert.equal(whole.files[0].path, 'lib/common/voice/voice_field.dart');

  // A path the commit never touched has no commit diff.
  await writeFile(join(repo, 'other.txt'), 'unrelated\n');
  const untouched = await act({ action: 'diff', repo, rev: added, path: 'other.txt' });
  assert.deepEqual(untouched.files, []);
  assert.equal(untouched.text, '');

  // Later work-tree edits stay out of the older commit's diff.
  await writeFile(nested, 'line one\nline two\n');
  const stillOne = await act({ action: 'diff', repo, rev: added, path: 'lib/common/voice/voice_field.dart' });
  assert.match(stillOne.text, /\+line one/);
  assert.doesNotMatch(stillOne.text, /line two/);

  // A follow-up commit diffs against its parent, keeping the `-` side.
  await runGit(repo, ['add', '--', 'lib/common/voice/voice_field.dart']);
  await runGit(repo, ['commit', '-m', 'append line two']);
  const second = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const increment = await act({ action: 'diff', repo, rev: second, path: 'lib/common/voice/voice_field.dart' });
  assert.match(increment.text, /\+line two/);
  assert.doesNotMatch(increment.text, /\+line one/);
});

test('branches can be listed, created, checked out, renamed and deleted', async (t) => {
  const repo = await seededRepo(t);
  const initial = await act({ action: 'branches.list', repo });
  assert.equal(initial.current, 'main');
  assert.deepEqual(initial.branches.map((branch) => branch.name), ['main']);
  assert.equal(initial.branches[0].current, true);
  assert.equal(initial.branches[0].remote, false);

  const created = await act({ action: 'branch.create', repo, name: 'feat/nested', checkout: true });
  assert.equal(created.status.branch, 'feat/nested');
  await writeFile(join(repo, 'branch-only.txt'), 'branch work\n');
  await act({ action: 'stageAll', repo });
  await act({ action: 'commit', repo, message: 'branch work' });

  const checkedOut = await act({ action: 'branch.checkout', repo, name: 'main' });
  assert.equal(checkedOut.status.branch, 'main');

  const renamed = await act({ action: 'branch.rename', repo, from: 'feat/nested', to: 'feat/renamed' });
  assert.equal(renamed.status.branch, 'main');
  const afterRename = await act({ action: 'branches.list', repo });
  assert.deepEqual(afterRename.branches.map((branch) => branch.name).sort(), ['feat/renamed', 'main']);

  await rejectsWith(act({ action: 'branch.delete', repo, name: 'feat/renamed' }), 'E_BRANCH_NOT_MERGED', 'unmerged delete');
  await rejectsWith(
    act({ action: 'branch.delete', repo, name: 'feat/renamed', force: true }),
    'E_INVALID_ARG',
    'force delete without confirm',
  );
  const deleted = await act({ action: 'branch.delete', repo, name: 'feat/renamed', force: true, confirm: true });
  assert.deepEqual(deleted.status.branch, 'main');
  const afterDelete = await act({ action: 'branches.list', repo });
  assert.deepEqual(afterDelete.branches.map((branch) => branch.name), ['main']);

  await rejectsWith(act({ action: 'branch.create', repo, name: '--upload-pack=touch /tmp/pwned' }), 'E_INVALID_ARG', 'ref injection');
  await rejectsWith(act({ action: 'branch.create', repo, name: 'bad..name' }), 'E_INVALID_ARG', 'bad ref grammar');
  await rejectsWith(act({ action: 'branch.create', repo, name: 'HEAD' }), 'E_INVALID_ARG', 'HEAD is not a branch name');
  await rejectsWith(act({ action: 'branch.create', repo, name: '-x' }), 'E_INVALID_ARG', 'leading dash');

  const upstreamRepo = await seededRepo(t);
  await rejectsWith(
    act({ action: 'branch.setUpstream', repo: upstreamRepo, branch: 'main', upstream: 'origin/main' }),
    'E_NOT_FOUND',
    'upstream without remote',
  );
});

test('deleting an unmerged branch says what would be lost', async (t) => {
  const repo = await seededRepo(t);
  await runGit(repo, ['checkout', '-b', 'feature/wip']);
  await writeFile(join(repo, 'wip.txt'), 'work in progress\n');
  await runGit(repo, ['add', '--', 'wip.txt']);
  await runGit(repo, ['commit', '-m', 'wip: unfinished work']);
  const wipHash = (await runGit(repo, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  await runGit(repo, ['checkout', 'main']);

  // git only says "not fully merged"; the panel must say which commits would go.
  await assert.rejects(
    act({ action: 'branch.delete', repo, name: 'feature/wip', confirm: true }),
    (error) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.code, 'E_BRANCH_NOT_MERGED');
      assert.match(error.detail, /^1 commit\(s\) are not merged into HEAD: /);
      assert.match(error.detail, new RegExp(wipHash));
      assert.match(error.detail, /wip: unfinished work/);
      assert.doesNotMatch(error.detail, /hint:/);
      assert.doesNotMatch(error.detail, /^error:/);
      return true;
    },
  );

  // The force path still deletes it, so the advice is actionable.
  const forced = await act({ action: 'branch.delete', repo, name: 'feature/wip', force: true, confirm: true });
  assert.equal(forced.status.branch, 'main');
  const branches = await act({ action: 'branches.list', repo });
  assert.equal(branches.branches.some((branch) => branch.name === 'feature/wip'), false);
});

test('stash push, list, apply, pop and drop work on a dirty tree', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'stashed change\n');

  const pushed = await act({ action: 'stash.push', repo, message: 'work in progress' });
  assert.deepEqual(pushed.status.changed, []);
  assert.equal(pushed.status.stashCount, 1);

  const list = await act({ action: 'stash.list', repo });
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].index, 0);
  assert.match(list.entries[0].message, /work in progress/);

  const applied = await act({ action: 'stash.apply', repo, index: 0 });
  assert.equal(applied.status.changed.length, 1);
  assert.equal(applied.status.stashCount, 1);

  // Popping onto the already-applied change would conflict, so clear the tree
  // first and then pop the still-present entry.
  await act({ action: 'discard', repo, paths: ['tracked.txt'], confirm: true });
  const popped = await act({ action: 'stash.pop', repo, index: 0 });
  assert.equal(popped.status.stashCount, 0);
  assert.equal(popped.status.changed.length, 1);

  await act({ action: 'discard', repo, paths: ['tracked.txt'], confirm: true });
  await writeFile(join(repo, 'tracked.txt'), 'third change\n');
  await act({ action: 'stash.push', repo, message: 'again' });
  const dropped = await act({ action: 'stash.drop', repo, index: 0 });
  assert.equal(dropped.status.stashCount, 0);
  assert.deepEqual((await act({ action: 'stash.list', repo })).entries, []);

  await rejectsWith(act({ action: 'stash.drop', repo, index: -1 }), 'E_INVALID_ARG', 'negative stash index');
  await rejectsWith(act({ action: 'stash.drop', repo, index: 1.5 }), 'E_INVALID_ARG', 'fractional stash index');
});

test('tags and remotes are created, listed, changed and removed', async (t) => {
  const repo = await seededRepo(t);

  await act({ action: 'tag.create', repo, name: 'v1.0.0', message: 'Release one' });
  await act({ action: 'tag.create', repo, name: 'lightweight' });
  const tags = await act({ action: 'tag.list', repo });
  assert.equal(tags.tags.length, 2);
  const annotated = tags.tags.find((tag) => tag.name === 'v1.0.0');
  assert.equal(annotated.annotated, true);
  assert.equal(annotated.message, 'Release one');
  const lightweight = tags.tags.find((tag) => tag.name === 'lightweight');
  assert.equal(lightweight.annotated, false);

  await rejectsWith(act({ action: 'tag.create', repo, name: 'bad tag' }), 'E_INVALID_ARG', 'tag with space');
  await act({ action: 'tag.delete', repo, name: 'lightweight' });
  const afterDelete = await act({ action: 'tag.list', repo });
  assert.deepEqual(afterDelete.tags.map((tag) => tag.name), ['v1.0.0']);

  const added = await act({ action: 'remote.add', repo, name: 'origin', url: 'https://example.com/repo.git' });
  assert.deepEqual(added, {});
  const remotes = await act({ action: 'remote.list', repo });
  assert.deepEqual(remotes.remotes, [
    { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
  ]);
  await act({ action: 'remote.setUrl', repo, name: 'origin', url: 'https://example.com/push.git', push: true });
  const updated = await act({ action: 'remote.list', repo });
  assert.equal(updated.remotes[0].fetchUrl, 'https://example.com/repo.git');
  assert.equal(updated.remotes[0].pushUrl, 'https://example.com/push.git');
  await act({ action: 'remote.remove', repo, name: 'origin' });
  assert.deepEqual((await act({ action: 'remote.list', repo })).remotes, []);

  await rejectsWith(act({ action: 'remote.add', repo, name: 'bad name', url: 'x' }), 'E_INVALID_ARG', 'remote name with space');
  await rejectsWith(act({ action: 'remote.add', repo, name: 'origin', url: '--upload-pack=x' }), 'E_INVALID_ARG', 'remote url option');
});

test('raw commands are tokenised, pinned to the repository and exit-code transparent', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'changed\n');

  const status = await act({ action: 'raw', repo, command: 'git status --short' });
  assert.equal(status.exitCode, 0);
  assert.match(status.stdout, /M tracked\.txt/);
  assert.equal(status.stderr, '');

  const quoted = await act({ action: 'raw', repo, command: 'git log -1 --format="%s"' });
  assert.equal(quoted.stdout.trim(), 'first');

  const failing = await act({ action: 'raw', repo, command: 'git rev-parse --verify no-such-ref' });
  assert.notEqual(failing.exitCode, 0);
  assert.notEqual(failing.stderr, '');

  for (const command of ['', 'status', 'git', 'git -C /tmp status', 'git --git-dir=/tmp/x status', 'git status "unterminated']) {
    await rejectsWith(act({ action: 'raw', repo, command }), 'E_INVALID_ARG', `raw ${JSON.stringify(command)}`);
  }
});

test('a merge conflict is reported, resolved and continued', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'conflict'));
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await runGit(repo, ['add', '--', 'shared.txt']);
  await runGit(repo, ['commit', '-m', 'base']);

  await runGit(repo, ['checkout', '-b', 'side']);
  await writeFile(join(repo, 'shared.txt'), 'side\n');
  await runGit(repo, ['commit', '-am', 'side change']);

  await runGit(repo, ['checkout', 'main']);
  await writeFile(join(repo, 'shared.txt'), 'main\n');
  await runGit(repo, ['commit', '-am', 'main change']);

  // `raw` is exit-code transparent, so the conflicting merge reports code 1
  // instead of turning into a transport error.
  const merge = await act({ action: 'raw', repo, command: 'git merge side' });
  assert.equal(merge.exitCode, 1);
  assert.match(`${merge.stdout}${merge.stderr}`, /CONFLICT/);

  const conflicted = await act({ action: 'status', repo });
  assert.equal(conflicted.conflicted.length, 1);
  assert.equal(conflicted.conflicted[0].path, 'shared.txt');
  assert.equal(conflicted.conflicted[0].conflict, 'UU');
  assert.equal(conflicted.operation.kind, 'merge');

  const resolved = await act({ action: 'conflict.resolve', repo, path: 'shared.txt', side: 'ours' });
  assert.deepEqual(resolved.status.conflicted, []);
  assert.equal(resolved.status.operation.kind, 'merge');

  const continued = await act({ action: 'operation.continue', repo });
  assert.equal(continued.status.operation, null);
  assert.deepEqual(continued.status.conflicted, []);
  assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'main\n');
  const log = await act({ action: 'log', repo, limit: 1 });
  assert.match(log.commits[0].subject, /Merge/);

  await rejectsWith(act({ action: 'operation.continue', repo }), 'E_INVALID_ARG', 'no operation in progress');
  await rejectsWith(act({ action: 'conflict.resolve', repo, path: 'shared.txt', side: 'mine' }), 'E_INVALID_ARG', 'bad side');
});

test('an in-progress merge can be aborted', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'abort'));
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await runGit(repo, ['add', '--', 'shared.txt']);
  await runGit(repo, ['commit', '-m', 'base']);
  await runGit(repo, ['checkout', '-b', 'side']);
  await writeFile(join(repo, 'shared.txt'), 'side\n');
  await runGit(repo, ['commit', '-am', 'side change']);
  await runGit(repo, ['checkout', 'main']);
  await writeFile(join(repo, 'shared.txt'), 'main\n');
  await runGit(repo, ['commit', '-am', 'main change']);
  await runGit(repo, ['merge', 'side'], { allowExitCodes: [1] });

  const aborted = await act({ action: 'operation.abort', repo });
  assert.equal(aborted.status.operation, null);
  assert.deepEqual(aborted.status.conflicted, []);
  assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'main\n');
  await rejectsWith(act({ action: 'operation.skip', repo }), 'E_INVALID_ARG', 'skip without operation');
});

test('submodule.list and submodule.update work on a repository without submodules', async (t) => {
  const repo = await seededRepo(t);
  assert.deepEqual(await act({ action: 'submodule.list', repo }), { submodules: [] });
  const updated = await act({ action: 'submodule.update', repo });
  assert.equal(typeof updated.output, 'string');
});

test('concurrent writes are serialised and reads stay consistent', async (t) => {
  const repo = await seededRepo(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(repo, name), `${name}\n`);

  const writes = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => act({ action: 'stage', repo, paths: [name] }));
  const reads = [0, 1, 2, 3].map(() => act({ action: 'status', repo }));
  const results = await Promise.all([...writes, ...reads]);
  assert.equal(results.length, 8);
  for (const result of results) {
    if (result.status !== undefined) assert.equal(result.status.repo, repo);
  }
  const final = await act({ action: 'status', repo });
  assert.deepEqual(
    final.staged.map((entry) => entry.path).sort(),
    ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
  );
});

test('unknown and malformed actions report coded errors', async () => {
  await rejectsWith(act({ action: 'repo.explode' }), 'E_UNSUPPORTED', 'unknown action');
  await rejectsWith(act({ action: '' }), 'E_UNSUPPORTED', 'missing action');
  await rejectsWith(act({}), 'E_UNSUPPORTED', 'missing action field');
  await rejectsWith(handleAction(NO_SERVICES, null), 'E_INVALID_ARG', 'null body');
  await rejectsWith(handleAction(NO_SERVICES, []), 'E_INVALID_ARG', 'array body');
});

test('repos.list scans registered workspaces and the checkouts beside them', async (t) => {
  const home = await workspace(t);
  const alpha = join(home, 'workspace', 'alpha');
  const beta = join(home, 'workspace', 'beta');
  await mkdir(alpha, { recursive: true });
  await initRepo(alpha);
  await initRepo(beta);
  const missing = join(home, 'workspace', 'gone');

  const registry = { list: () => [{ path: alpha }, { path: missing }, { path: '' }, {}] };
  const ctx = { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) };
  const value = await act({ action: 'repos.list', settings: { scanDepth: 3 } }, ctx);

  assert.deepEqual(value.workspaceRoots, [alpha, missing]);
  assert.deepEqual(value.repos.map((repo) => repo.path).sort(), [alpha, beta].sort());
  assert.ok(value.roots.includes(alpha), 'the workspace itself is a scan root');
  assert.ok(value.roots.includes(join(home, 'workspace')), 'the sibling directory is a shallow root');
  assert.equal(value.suggestedRoots, undefined);
  assert.equal(value.truncated, false);
});

test('repos.list survives a Host without a workspace registry', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'solo'));
  const value = await act({ action: 'repos.list', extraRoots: [repo], settings: {} });
  assert.deepEqual(value.workspaceRoots, []);
  assert.deepEqual(value.repos.map((entry) => entry.path), [repo]);
});

test('repos.list scopes discovery to the opened workspace and its nested checkouts', async (t) => {
  const home = await workspace(t);
  const opened = join(home, 'opened');
  await mkdir(join(opened, 'systems', 'frontend'), { recursive: true });
  await mkdir(join(opened, 'systems', 'backend'), { recursive: true });
  const outer = await initRepo(opened);
  const front = await initRepo(join(opened, 'systems', 'frontend', 'app'));
  const back = await initRepo(join(opened, 'systems', 'backend', 'api'));
  // A repository outside the opened folder must not leak in while the opened
  // folder has checkouts of its own.
  const elsewhere = await initRepo(join(home, 'elsewhere', 'other'));

  const registry = { list: () => [{ path: join(home, 'elsewhere', 'other') }] };
  const sessions = { get: () => ({ header: { cwd: opened } }) };
  const ctx = {
    get: (key) => (key === 'sessions' ? sessions : key === 'workspaceRegistry' ? registry : undefined),
  };
  const value = await act({ action: 'repos.list', sessionId: 'session-1', settings: { scanDepth: 5 } }, ctx);

  assert.equal(value.scopedToWorkspace, true);
  assert.deepEqual(value.repos.map((repo) => repo.path).sort(), [outer, front, back].sort());
  assert.ok(!value.repos.some((repo) => repo.path === elsewhere), 'other workspaces stay out of a scoped list');
  assert.equal(value.roots[0], opened, 'the opened folder is the first scan root');
});

test('repos.list stops descending when the opened folder is a single checkout', async (t) => {
  const home = await workspace(t);
  const repo = await initRepo(join(home, 'solo'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.js'), 'export default 1;\n');

  const sessions = { get: () => ({ header: { cwd: repo } }) };
  const ctx = { get: (key) => (key === 'sessions' ? sessions : undefined) };
  const value = await act({ action: 'repos.list', sessionId: 'session-1', settings: {} }, ctx);
  assert.deepEqual(value.repos.map((entry) => entry.path), [repo]);
  assert.equal(value.scopedToWorkspace, true);
  assert.equal(value.suggestedRoots, undefined);
});
