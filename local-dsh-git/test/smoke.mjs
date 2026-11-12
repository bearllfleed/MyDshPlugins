/**
 * Read-only smoke test against a real, user-owned repository.
 *
 * Nothing here mutates the target repository: the script only runs
 * status/log/for-each-ref/diff and asserts that every parser returns the
 * contract shape without throwing. It also mounts `index.js` on a fake
 * connection to prove the route registration and the response envelope.
 *
 * Run with `node test/smoke.mjs [repo-path]` (defaults to the current
 * directory, which must be a git work tree).
 */
import assert from 'node:assert/strict';
import { apply, handleRequest, ROUTE, name, inject } from '../index.js';
import { createConfig } from '../git/config.js';
import { runGit } from '../git/exec.js';
import { assertRepo, readSingleRepoInfo } from '../git/repos.js';
import { readStatus } from '../git/status.js';
import { readDiff } from '../git/diff.js';
import { readBranches, readLog, readRemotes, readShow, readStashList, readSubmoduleList, readTagList } from '../git/history.js';

/**
 * The repository this smoke test inspects: the first CLI argument, else the
 * current directory. It must be a real, already-initialised git repository —
 * pass one with `node test/smoke.mjs /path/to/repo`.
 */
const SAMPLE_REPO = process.argv[2] !== undefined ? process.argv[2] : process.cwd();

/** Collected one-line results, printed at the end. */
const report = [];

/**
 * Run one read-only probe and record its summary.
 * @param {string} label - probe name.
 * @param {() => Promise<string>} probe - the work.
 * @returns {Promise<void>}
 */
async function probe(label, probe) {
  const summary = await probe();
  report.push(`${label}: ${summary}`);
}

async function main() {
  assert.equal(name, 'dsh-git');
  assert.deepEqual(inject, ['connection']);
  assert.equal(ROUTE, '/api/dsh-git');

  let repo;
  try {
    repo = await assertRepo(SAMPLE_REPO);
  } catch (error) {
    console.log(`SMOKE SKIPPED — ${SAMPLE_REPO} is not a git repository (${error.code !== undefined ? error.code : error.message})`);
    console.log('Pass one explicitly: node test/smoke.mjs /path/to/repo');
    return;
  }
  assert.equal(repo.kind, 'repo');
  report.push(`assertRepo: ${repo.path} (${repo.kind})`);

  await probe('repo.info', async () => {
    const info = await readSingleRepoInfo(repo.path);
    assert.equal(typeof info.name, 'string');
    assert.ok(info.changed >= 0);
    return `${info.name} branch=${info.branch ?? '(none)'} unborn=${info.unborn} changed=${info.changed}`;
  });

  await probe('status', async () => {
    const status = await readStatus(repo.path);
    assert.equal(status.repo, repo.path);
    assert.ok(Array.isArray(status.staged) && Array.isArray(status.changed));
    assert.ok(Array.isArray(status.untracked) && Array.isArray(status.conflicted));
    assert.equal(typeof status.stashCount, 'number');
    return `branch=${status.branch ?? '(detached)'} head=${status.head ?? '(unborn)'} untracked=${status.untracked.length}`;
  });

  await probe('status porcelain v2 (raw)', async () => {
    const raw = await runGit(repo.path, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=no']);
    assert.equal(typeof raw.stdout, 'string');
    return `${raw.stdout.split('\0').filter(Boolean).length} records`;
  });

  await probe('log', async () => {
    const { commits, hasMore } = await readLog(repo.path, { limit: 5 });
    assert.ok(Array.isArray(commits));
    assert.equal(typeof hasMore, 'boolean');
    for (const commit of commits) {
      assert.match(commit.hash, /^[0-9a-f]{7,40}$/);
      assert.equal(typeof commit.subject, 'string');
    }
    return `${commits.length} commit(s), hasMore=${hasMore}`;
  });

  await probe('for-each-ref / branches', async () => {
    const { current, branches } = await readBranches(repo.path, { includeRemote: true });
    assert.ok(Array.isArray(branches));
    for (const branch of branches) {
      assert.equal(typeof branch.name, 'string');
      assert.equal(typeof branch.fullName, 'string');
      assert.equal(typeof branch.current, 'boolean');
    }
    return `current=${current ?? '(none)'} branches=${branches.length}`;
  });

  await probe('tags / remotes / stash / submodules', async () => {
    const [{ tags }, { remotes }, { entries }, { submodules }] = await Promise.all([
      readTagList(repo.path),
      readRemotes(repo.path),
      readStashList(repo.path),
      readSubmoduleList(repo.path),
    ]);
    assert.ok(Array.isArray(tags) && Array.isArray(remotes) && Array.isArray(entries) && Array.isArray(submodules));
    return `tags=${tags.length} remotes=${remotes.length} stashes=${entries.length} submodules=${submodules.length}`;
  });

  await probe('diff', async () => {
    const diff = await readDiff(repo.path, {});
    assert.ok(Array.isArray(diff.files));
    assert.equal(typeof diff.text, 'string');
    assert.equal(typeof diff.truncated, 'boolean');
    for (const file of diff.files) {
      assert.equal(typeof file.path, 'string');
      assert.equal(typeof file.added, 'number');
      assert.equal(typeof file.removed, 'number');
      assert.equal(typeof file.binary, 'boolean');
    }
    return `${diff.files.length} file(s), ${diff.text.length} bytes`;
  });

  await probe('show HEAD (tolerates an unborn branch)', async () => {
    try {
      const shown = await readShow(repo.path, 'HEAD');
      assert.equal(typeof shown.commit.hash, 'string');
      return `${shown.commit.shortHash} ${shown.files.length} file(s)`;
    } catch (error) {
      if (['E_GIT_FAILED', 'E_NOT_REPO', 'E_NOT_FOUND'].includes(error?.code)) return `skipped (${error.code})`;
      throw error;
    }
  });

  // Route registration through a fake `connection` service.
  const registered = [];
  const connection = {
    fetch: {
      register(spec) {
        registered.push(spec);
        return () => {};
      },
    },
  };
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['connection']);
      callback({
        get: (key) => (key === 'connection' ? connection : undefined),
        effect: (fn) => fn(),
      });
    },
    get: () => undefined,
  };
  apply(ctx, { scanDepth: 3 });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, ROUTE);
  assert.deepEqual(registered[0].methods, ['POST']);
  assert.equal(registered[0].requestBody, 'buffered');
  assert.equal(typeof registered[0].fetch, 'function');
  report.push(`route: ${registered[0].methods.join(',')} ${registered[0].path} requestBody=${registered[0].requestBody}`);

  const config = createConfig({ scanDepth: 3 });
  const okResponse = await registered[0].fetch({ json: async () => ({ action: 'config.get' }) });
  assert.equal(okResponse.status, 200);
  assert.equal(okResponse.headers.get('cache-control'), 'no-store');
  const okBody = await okResponse.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.value.config.scanDepth, 3);
  report.push(`envelope ok: config.get -> scanDepth=${okBody.value.config.scanDepth}`);

  const statusResponse = await registered[0].fetch({
    json: async () => ({ action: 'status', repo: repo.path }),
  });
  const statusBody = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.value.repo, repo.path);
  report.push(`envelope ok: status -> branch=${statusBody.value.branch ?? '(none)'}`);

  const badAction = await (await handleRequest(ctx, { json: async () => ({ action: 'nope' }) }, config)).json();
  assert.equal(badAction.ok, false);
  assert.equal(badAction.error.code, 'E_UNSUPPORTED');
  report.push(`envelope error: unknown action -> ${badAction.error.code}`);

  const badJson = await (await handleRequest(ctx, { text: async () => '{not json' }, config)).json();
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error.code, 'E_INVALID_ARG');
  report.push(`envelope error: invalid JSON -> ${badJson.error.code}`);

  const badRepo = await (await handleRequest(ctx, { json: async () => ({ action: 'status', repo: '/tmp' }) }, config)).json();
  assert.equal(badRepo.ok, false);
  assert.equal(badRepo.error.code, 'E_NOT_REPO');
  report.push(`envelope error: /tmp as repo -> ${badRepo.error.code}`);

  for (const line of report) console.log(`  ${line}`);
  console.log(`SMOKE OK — ${report.length} probes against ${SAMPLE_REPO}`);
}

main().catch((error) => {
  console.error('SMOKE FAILED');
  for (const line of report) console.error(`  ${line}`);
  console.error(error);
  process.exitCode = 1;
});
