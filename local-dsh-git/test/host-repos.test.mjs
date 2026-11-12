/**
 * Repository discovery tests.
 *
 * Every fixture lives under a fresh `os.tmpdir()` directory and is created with
 * real `git init`, so the BFS, the `.git` detection and the `RepoInfo` fields are
 * exercised against git itself rather than a mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRepo,
  detectRepositoryKind,
  discoverRepositories,
  invalidateDiscoveryCache,
  listWorktrees,
  MAX_REPOSITORIES,
  normalizeRoots,
  readSingleRepoInfo,
  repoRelative,
  SHALLOW_ROOT_DEPTH,
  siblingRoots,
  SKIPPED_DIRECTORIES,
  suggestScanRoots,
} from '../git/repos.js';
import { runGit } from '../git/exec.js';
import { GitError } from '../git/util.js';

/** Create a temporary directory that is removed when the test ends. */
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-repos-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Initialise a repository with a deterministic branch name. */
async function initRepo(path) {
  await mkdir(path, { recursive: true });
  await runGit(null, ['init', '-b', 'main', path]);
  return path;
}

test('detectRepositoryKind distinguishes repos, worktrees and bare repos', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'normal'));
  assert.deepEqual(await detectRepositoryKind(repo), { kind: 'repo' });

  const bare = join(root, 'bare.git');
  await runGit(null, ['init', '--bare', bare]);
  assert.deepEqual(await detectRepositoryKind(bare), { kind: 'bare' });

  const worktree = join(root, 'linked');
  await runGit(repo, ['commit', '--allow-empty', '-m', 'first']);
  await runGit(repo, ['worktree', 'add', worktree, '-b', 'side']);
  assert.deepEqual(await detectRepositoryKind(worktree), { kind: 'worktree' });

  const plain = join(root, 'plain');
  await mkdir(plain);
  assert.equal(await detectRepositoryKind(plain), null);
  assert.equal(await detectRepositoryKind(join(root, 'missing')), null);
});

test('assertRepo rejects malformed and non-repository paths', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'repo'));
  const accepted = await assertRepo(repo);
  assert.equal(accepted.path, repo);
  assert.equal(accepted.kind, 'repo');

  await mkdir(join(root, 'empty'));
  const rejections = [
    [null, 'E_INVALID_ARG'],
    ['', 'E_INVALID_ARG'],
    ['relative/path', 'E_INVALID_ARG'],
    [`${repo}/../repo`, 'E_INVALID_ARG'],
    [join(root, 'missing'), 'E_NOT_REPO'],
    [join(root, 'empty'), 'E_NOT_REPO'],
    [`${repo}\0evil`, 'E_INVALID_ARG'],
  ];
  for (const [value, code] of rejections) {
    await assert.rejects(assertRepo(value), (error) => error instanceof GitError && error.code === code, String(value));
  }
});

test('repoRelative keeps paths inside the repository', () => {
  const repo = '/tmp/example-repo';
  assert.equal(repoRelative(repo, 'src/app.js'), 'src/app.js');
  assert.equal(repoRelative(repo, './src/./app.js'), 'src/app.js');
  assert.equal(repoRelative(repo, 'docs/说明 文档.md'), 'docs/说明 文档.md');
  for (const value of ['/etc/passwd', '../outside', '', 'src/../../outside']) {
    assert.throws(() => repoRelative(repo, value), (error) => error.code === 'E_INVALID_ARG', value);
  }
});

test('normalizeRoots resolves, deduplicates and drops unusable roots', async (t) => {
  const root = await workspace(t);
  const first = join(root, 'one');
  const second = join(root, 'two');
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(root, 'file.txt'), 'not a directory');
  const roots = await normalizeRoots([first, first, second, 'relative', join(root, 'missing'), join(root, 'file.txt'), 42]);
  assert.deepEqual(roots, [first, second]);
});

test('discoverRepositories walks the tree within the depth limit', async (t) => {
  const root = await workspace(t);
  await initRepo(join(root, 'alpha'));
  await initRepo(join(root, 'beta'));
  await initRepo(join(root, 'group', 'gamma'));
  await initRepo(join(root, 'group', 'deeper', 'delta'));
  await mkdir(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'readme.md'), 'hello');
  invalidateDiscoveryCache();

  const shallow = await discoverRepositories({ roots: [root], scanDepth: 2, useCache: false });
  assert.deepEqual(
    shallow.repositories.map((repo) => repo.path).sort(),
    [join(root, 'alpha'), join(root, 'beta'), join(root, 'group', 'gamma')].sort(),
  );
  assert.equal(shallow.truncated, false);
  assert.deepEqual(shallow.roots, [root]);

  const deep = await discoverRepositories({ roots: [root], scanDepth: 3, useCache: false });
  assert.deepEqual(
    deep.repositories.map((repo) => repo.path).sort(),
    [
      join(root, 'alpha'),
      join(root, 'beta'),
      join(root, 'group', 'gamma'),
      join(root, 'group', 'deeper', 'delta'),
    ].sort(),
  );
  // node_modules is on the skip list, so the fake repository inside it is hidden.
  assert.equal(deep.repositories.some((repo) => repo.path.includes('node_modules')), false);
});

test('discoverRepositories stops descending at a repository and dedupes roots', async (t) => {
  const root = await workspace(t);
  const outer = await initRepo(join(root, 'outer'));
  await initRepo(join(outer, 'inner'));
  invalidateDiscoveryCache();
  const result = await discoverRepositories({ roots: [root, root], scanDepth: 4, useCache: false });
  assert.deepEqual(result.repositories.map((repo) => repo.path), [outer]);
  assert.deepEqual(result.roots, [root]);
});

test('discoverRepositories honours autoRepositoryDetection=false', async (t) => {
  const root = await workspace(t);
  await initRepo(join(root, 'scanned'));
  const extra = await workspace(t);
  const extraRepo = await initRepo(join(extra, 'explicit'));
  invalidateDiscoveryCache();
  const result = await discoverRepositories({
    roots: [root],
    extraRoots: [extraRepo],
    scanDepth: 3,
    autoRepositoryDetection: 'false',
    useCache: false,
  });
  assert.deepEqual(result.repositories.map((repo) => repo.path), [extraRepo]);
});

test('discoverRepositories caches results until invalidated', async (t) => {
  const root = await workspace(t);
  await initRepo(join(root, 'one'));
  invalidateDiscoveryCache();
  const first = await discoverRepositories({ roots: [root], scanDepth: 2 });
  const second = await discoverRepositories({ roots: [root], scanDepth: 2 });
  assert.deepEqual(second.repositories, first.repositories);

  await initRepo(join(root, 'two'));
  const stillCached = await discoverRepositories({ roots: [root], scanDepth: 2 });
  assert.equal(stillCached.repositories.length, 1);
  invalidateDiscoveryCache();
  const refreshed = await discoverRepositories({ roots: [root], scanDepth: 2 });
  assert.equal(refreshed.repositories.length, 2);
});

test('discoverRepositories reports branch, changed count and unborn state', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'fresh'));
  invalidateDiscoveryCache();
  const before = await discoverRepositories({ roots: [root], scanDepth: 1, useCache: false });
  assert.equal(before.repositories[0].unborn, true);
  assert.equal(before.repositories[0].branch, 'main');
  assert.equal(before.repositories[0].head, null);
  assert.equal(before.repositories[0].changed, 0);

  await writeFile(join(repo, 'tracked.txt'), 'one\n');
  await runGit(repo, ['add', 'tracked.txt']);
  await runGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'first']);
  await writeFile(join(repo, 'tracked.txt'), 'two\n');
  await writeFile(join(repo, 'untracked.txt'), 'new\n');
  const after = await discoverRepositories({ roots: [root], scanDepth: 1, useCache: false });
  const info = after.repositories[0];
  assert.equal(info.name, 'fresh');
  assert.equal(info.displayName, 'fresh');
  assert.equal(info.kind, 'repo');
  assert.equal(info.unborn, false);
  assert.match(info.head, /^[0-9a-f]{40}$/);
  assert.equal(info.changed, 2);
  assert.equal(info.error, undefined);
});

test('readSingleRepoInfo returns the full RepoInfo and listWorktrees finds the main tree', async (t) => {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'solo'));
  const info = await readSingleRepoInfo(repo);
  assert.equal(info.path, repo);
  assert.equal(info.branch, 'main');
  assert.equal(info.kind, 'repo');

  const worktrees = await listWorktrees(repo);
  assert.equal(worktrees.length, 1);
  // git reports the canonical path (on macOS /var is a symlink to /private/var).
  assert.equal(worktrees[0].path, await realpath(repo));
  assert.equal(worktrees[0].branch, 'main');

  await assert.rejects(readSingleRepoInfo(join(root, 'nope')), (error) => error.code === 'E_NOT_REPO');
});

test('discovery constants match the contract', () => {
  assert.equal(MAX_REPOSITORIES, 200);
  for (const name of ['node_modules', 'dist', 'build', 'target', 'vendor', '.venv', '__pycache__', '.next', '.cache', '.git']) {
    assert.ok(SKIPPED_DIRECTORIES.includes(name), name);
  }
});

test('siblingRoots returns the directories that hold workspaces', () => {
  const home = '/Users/example';
  assert.deepEqual(
    siblingRoots([`${home}/workspace/InSight`, `${home}/workspace/riceai-devkit`, `${home}/Documents/app`], home),
    [`${home}/workspace`, `${home}/Documents`],
  );
  // A workspace registered directly under $HOME must never expose $HOME itself,
  // and relative or empty input contributes nothing.
  assert.deepEqual(siblingRoots([`${home}/solo`], home), []);
  assert.deepEqual(siblingRoots([], home), []);
  assert.deepEqual(siblingRoots(['relative/path'], home), []);
});

test('suggestScanRoots only offers folders that hold repositories', async (t) => {
  const home = await workspace(t);
  await initRepo(join(home, 'workspace', 'alpha'));
  await initRepo(join(home, 'workspace', 'beta'));
  await initRepo(join(home, 'projects', 'nested', 'gamma'));
  await mkdir(join(home, 'code'), { recursive: true });

  assert.deepEqual(await suggestScanRoots(home, { useCache: false }), [
    { path: join(home, 'workspace'), count: 2 },
    { path: join(home, 'projects'), count: 1 },
  ]);
  assert.deepEqual(await suggestScanRoots('', { useCache: false }), []);
});

test('discoverRepositories caps a shallow root at its own depth budget', async (t) => {
  const home = await workspace(t);
  const near = await initRepo(join(home, 'workspace', 'near'));
  const deep = await initRepo(join(home, 'workspace', 'a', 'b', 'c', 'deep'));

  const shallow = await discoverRepositories({
    shallowRoots: [join(home, 'workspace')],
    scanDepth: 5,
    useCache: false,
  });
  assert.deepEqual(shallow.repositories.map((repo) => repo.path), [near]);
  assert.ok(SHALLOW_ROOT_DEPTH >= 1);

  const full = await discoverRepositories({ roots: [join(home, 'workspace')], scanDepth: 5, useCache: false });
  assert.deepEqual(
    full.repositories.map((repo) => repo.path).sort(),
    [near, deep].sort(),
  );
});

test('descendIntoRepositories finds the checkouts nested inside a workspace', async (t) => {
  const home = await workspace(t);
  const outer = await initRepo(join(home, 'container'));
  const nested = await initRepo(join(home, 'container', 'apps', 'web'));
  const deeper = await initRepo(join(home, 'container', 'apps', 'web', 'packages', 'ui'));

  const stopped = await discoverRepositories({ roots: [outer], scanDepth: 5, useCache: false });
  assert.deepEqual(stopped.repositories.map((repo) => repo.path), [outer]);

  const walked = await discoverRepositories({
    roots: [outer],
    scanDepth: 5,
    descendIntoRepositories: true,
    useCache: false,
  });
  assert.deepEqual(
    walked.repositories.map((repo) => repo.path).sort(),
    [outer, nested, deeper].sort(),
  );
});
