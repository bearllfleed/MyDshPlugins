/**
 * Failure-path coverage for every action that can be refused by git.
 *
 * The user-visible contract is that a refusal never surfaces as a bare
 * `E_GIT_FAILED` with English prose: each known refusal gets its own code (so
 * the Client can localize a title) and, where the user must change something
 * first, a pre-check that reports the real cause instead of git's wording.
 *
 * This file also pins the code table itself: `git/util.js` owns the list, the
 * Client must translate every entry, and the two must not drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAction } from '../git/actions.js';
import { DESTRUCTIVE_RAW_PATTERNS, classifyGitFailure, runGit } from '../git/exec.js';
import { ERROR_CODES, GitError } from '../git/util.js';

const NO_SERVICES = { get: () => undefined };

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function initRepo(path) {
  await runGit(null, ['init', '-b', 'main', path]);
  await runGit(path, ['config', 'user.name', 'DSH Git Test']);
  await runGit(path, ['config', 'user.email', 'dsh-git@example.com']);
  return path;
}

async function seededRepo(t, file = 'tracked.txt', content = 'one\n') {
  const root = await workspace(t);
  const repo = await initRepo(join(root, 'repo'));
  await writeFile(join(repo, file), content);
  await runGit(repo, ['add', '--', file]);
  await runGit(repo, ['commit', '-m', 'first']);
  return repo;
}

function act(request, ctx = NO_SERVICES) {
  return handleAction(ctx, request);
}

async function rejectsWith(promise, code, label) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GitError, `${label}: expected GitError, got ${error}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return true;
  });
}

test('the Client translates every Host error code', async () => {
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const block = /const KNOWN_CODES = \[([\s\S]*?)\];/.exec(clientSource);
  assert.ok(block !== null, 'client.js must declare KNOWN_CODES');
  const clientCodes = [...block[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...clientCodes].sort(), [...ERROR_CODES].sort(), 'KNOWN_CODES must mirror ERROR_CODES');

  for (const language of ['zh', 'en']) {
    const dictionary = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'));
    for (const code of ERROR_CODES) {
      assert.equal(typeof dictionary[`error.${code}`], 'string', `locale/${language}.json is missing error.${code}`);
      assert.notEqual(dictionary[`error.${code}`], '', `locale/${language}.json error.${code} must not be empty`);
    }
  }
});

test('classifyGitFailure maps refusals onto their own codes', () => {
  const cases = [
    ['error: cannot delete branch \'x\' used by worktree at \'/w\'', 'E_BRANCH_IN_USE'],
    ['error: the branch \'x\' is not fully merged', 'E_BRANCH_NOT_MERGED'],
    ['fatal: a branch named \'main\' already exists', 'E_ALREADY_EXISTS'],
    ['fatal: tag \'v1\' already exists', 'E_ALREADY_EXISTS'],
    ['error: no branch named \'nope\'', 'E_NOT_FOUND'],
    ['fatal: No configured push destination', 'E_NO_REMOTE'],
    ['fatal: The current branch main has no upstream branch', 'E_NO_UPSTREAM'],
    ['! [rejected]        main -> main (non-fast-forward)', 'E_REJECTED'],
    ['fatal: Not possible to fast-forward, aborting.', 'E_DIVERGED'],
    ['error: Your local changes to the following files would be overwritten by checkout:', 'E_DIRTY_TREE'],
    ['husky - pre-commit hook exited with code 1', 'E_HOOK_FAILED'],
    ['fatal: this operation must be run in a work tree', 'E_BARE_REPO'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'E_NOT_REPO'],
    ['fatal: Authentication failed for \'https://example.com/repo.git/\'', 'E_AUTH_REQUIRED'],
    ['fatal: Unable to create \'/repo/.git/index.lock\': File exists.', 'E_LOCKED'],
  ];
  for (const [stderr, code] of cases) {
    assert.equal(classifyGitFailure({ stderr, exitCode: 128 }).code, code, stderr);
  }
  // `git commit` explains an empty index on stdout, not stderr.
  assert.equal(
    classifyGitFailure({ stdout: 'nothing to commit, working tree clean', exitCode: 1 }).code,
    'E_NOTHING_TO_COMMIT',
  );
  // `hint:` prose must not decide the code ("a branch that already exists").
  assert.equal(
    classifyGitFailure({
      stderr:
        "fatal: the requested upstream branch 'origin/main' does not exist\nhint:\n" +
        'hint: If you are planning on basing your work on an upstream\n' +
        'hint: branch that already exists at the remote, you may need to\n',
    }).code,
    'E_NOT_FOUND',
  );
  assert.equal(classifyGitFailure({ stderr: 'fatal: something else entirely', exitCode: 2 }).code, 'E_GIT_FAILED');
});

test('commit refuses an empty index with a useful detail', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'modified\n');
  await assert.rejects(act({ action: 'commit', repo, message: 'empty' }), (error) => {
    assert.equal(error.code, 'E_NOTHING_TO_COMMIT');
    assert.match(error.detail, /0 staged, 1 modified/);
    return true;
  });
  // `allowEmpty` opts back into git's own behaviour.
  const empty = await act({ action: 'commit', repo, message: 'empty', allowEmpty: true });
  assert.equal(typeof empty.hash, 'string');
});

test('commit surfaces a rejected hook instead of a generic failure', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed: 3 problems" >&2\nexit 1\n', {
    mode: 0o755,
  });
  await writeFile(join(repo, 'tracked.txt'), 'modified\n');
  await act({ action: 'stage', repo, paths: ['tracked.txt'] });
  await assert.rejects(act({ action: 'commit', repo, message: 'blocked' }), (error) => {
    assert.equal(error.code, 'E_HOOK_FAILED');
    assert.match(error.detail, /lint failed/);
    return true;
  });
});

test('branch.delete reports the checked-out branch and worktree holders', async (t) => {
  const repo = await seededRepo(t);
  await rejectsWith(act({ action: 'branch.delete', repo, name: 'main' }), 'E_BRANCH_CURRENT', 'current branch');

  const linked = join(repo, '..', 'linked');
  await runGit(repo, ['branch', 'held']);
  await runGit(repo, ['worktree', 'add', linked, 'held']);
  await rejectsWith(act({ action: 'branch.delete', repo, name: 'held' }), 'E_BRANCH_IN_USE', 'held by worktree');
  await rejectsWith(
    act({ action: 'branch.checkout', repo, name: 'held' }),
    'E_BRANCH_IN_USE',
    'checkout of a held branch',
  );
});

test('refusals for missing or duplicate targets keep their own codes', async (t) => {
  const repo = await seededRepo(t);
  await rejectsWith(act({ action: 'branch.create', repo, name: 'main' }), 'E_ALREADY_EXISTS', 'duplicate branch');
  await rejectsWith(act({ action: 'branch.rename', repo, from: 'ghost', to: 'other' }), 'E_NOT_FOUND', 'rename ghost');
  await rejectsWith(act({ action: 'branch.checkout', repo, name: 'ghost' }), 'E_NOT_FOUND', 'checkout ghost');
  await act({ action: 'tag.create', repo, name: 'v1' });
  await rejectsWith(act({ action: 'tag.create', repo, name: 'v1' }), 'E_ALREADY_EXISTS', 'duplicate tag');
  await rejectsWith(act({ action: 'tag.delete', repo, name: 'v9' }), 'E_NOT_FOUND', 'missing tag');
  await rejectsWith(act({ action: 'stash.apply', repo, index: 99 }), 'E_NOT_FOUND', 'missing stash entry');
  await rejectsWith(act({ action: 'stage', repo, paths: ['ghost.txt'] }), 'E_NOT_FOUND', 'missing path');
});

test('network actions refuse before spawning git when the remote side is missing', async (t) => {
  const repo = await seededRepo(t);
  await rejectsWith(act({ action: 'push', repo }), 'E_NO_REMOTE', 'push without a remote');
  await runGit(repo, ['remote', 'add', 'origin', join(repo, '..', 'nowhere.git')]);
  await rejectsWith(act({ action: 'push', repo }), 'E_NO_UPSTREAM', 'push without an upstream');
  await rejectsWith(act({ action: 'remote.add', repo, name: 'origin', url: 'x' }), 'E_ALREADY_EXISTS', 'duplicate remote');
  await rejectsWith(act({ action: 'remote.remove', repo, name: 'ghost' }), 'E_NOT_FOUND', 'missing remote');
  await rejectsWith(act({ action: 'fetch', repo, remote: 'ghost' }), 'E_NO_REMOTE', 'unknown remote');
});

test('a bare repository and an unresolved ref are reported precisely', async (t) => {
  const root = await workspace(t);
  const bare = join(root, 'bare.git');
  await runGit(null, ['init', '--bare', bare]);
  await rejectsWith(act({ action: 'status', repo: bare }), 'E_BARE_REPO', 'status of a bare repo');

  const repo = await seededRepo(t);
  await rejectsWith(act({ action: 'log', repo, ref: 'ghost' }), 'E_NOT_FOUND', 'log of an unknown ref');
  // The default ref still tolerates an unborn branch.
  const unborn = join(root, 'unborn');
  await initRepo(unborn);
  const log = await act({ action: 'log', repo: unborn });
  assert.deepEqual(log.commits, []);
});

test('conflict.resolve refuses a path that is not conflicted', async (t) => {
  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'clean\n');
  await rejectsWith(
    act({ action: 'conflict.resolve', repo, path: 'tracked.txt', side: 'ours' }),
    'E_INVALID_ARG',
    'clean path',
  );
});

test('destructive raw commands need an explicit confirm, and the Client agrees', async (t) => {
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  for (const source of DESTRUCTIVE_RAW_PATTERNS) {
    assert.ok(
      clientSource.includes(source.replace(/\\/g, '\\\\')),
      `client.js must embed the raw pattern ${source} so its confirm dialog matches the Host guard`,
    );
  }

  const repo = await seededRepo(t);
  await writeFile(join(repo, 'tracked.txt'), 'uncommitted\n');
  await rejectsWith(act({ action: 'raw', repo, command: 'git reset --hard' }), 'E_INVALID_ARG', 'raw reset --hard');
  const confirmed = await act({ action: 'raw', repo, command: 'git reset --hard', confirm: true });
  assert.equal(confirmed.exitCode, 0);
  // Harmless raw commands keep running without a confirm.
  const status = await act({ action: 'raw', repo, command: 'git status --short' });
  assert.equal(status.exitCode, 0);
});
