/**
 * Pure-parser unit tests: porcelain v2 status, ref tracking, unified diffs,
 * log records, branches, stash, tags, remotes and submodules.
 *
 * These feed literal fixture text into the exported parsers, so they run
 * without a repository and without spawning git.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStatusPorcelainV2,
  parseRefTrack,
} from '../git/status.js';
import { parseUnifiedDiff, parseDiffGitLine, buildDiffArgs, buildCommitDiffArgs } from '../git/diff.js';
import {
  parseLog,
  parseCommitLine,
  parseBranchLine,
  parseStashList,
  parseTagList,
  parseRemotes,
  parseSubmoduleStatus,
  parseDecoration,
  buildLogArgs,
} from '../git/history.js';

/** Join records with NUL, the way `-z` output arrives. */
function z(...records) {
  return records.join('\0') + '\0';
}

test('porcelain v2: ordinary records and branch headers', () => {
  const raw = z(
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaaa bbbb src/app.js',
    '1 .M N... 100644 100644 100644 aaaa bbbb README.md',
    '1 MM N... 100644 100644 100644 aaaa bbbb both.txt',
    '? notes.md',
  );
  const status = parseStatusPorcelainV2(raw);
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.head, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(status.detached, false);
  assert.equal(status.unborn, false);
  assert.deepEqual(status.staged, [
    { path: 'src/app.js', status: 'M', staged: true },
    { path: 'both.txt', status: 'M', staged: true },
  ]);
  assert.deepEqual(status.changed, [
    { path: 'README.md', status: 'M', staged: false },
    { path: 'both.txt', status: 'M', staged: false },
  ]);
  assert.deepEqual(status.untracked, [{ path: 'notes.md', status: '?', staged: false }]);
  assert.deepEqual(status.conflicted, []);
});

test('porcelain v2: rename record keeps the original path and score', () => {
  const raw = z(
    '# branch.oid 1111111111111111111111111111111111111111',
    '# branch.head feature',
    '2 R. N... 100644 100644 100644 aaaa bbbb R100 renamed.txt',
    'old name.txt',
  );
  const status = parseStatusPorcelainV2(raw);
  assert.equal(status.staged.length, 1);
  assert.deepEqual(status.staged[0], {
    path: 'renamed.txt',
    status: 'R',
    staged: true,
    origPath: 'old name.txt',
    score: 100,
  });
  assert.deepEqual(status.changed, []);
});

test('porcelain v2: copy record is reported with its score', () => {
  const raw = z(
    '# branch.head main',
    '2 C. N... 100644 100644 100644 aaaa bbbb C075 copy.txt',
    'source.txt',
  );
  const status = parseStatusPorcelainV2(raw);
  assert.deepEqual(status.staged[0], {
    path: 'copy.txt',
    status: 'C',
    staged: true,
    origPath: 'source.txt',
    score: 75,
  });
});

test('porcelain v2: unmerged records become conflicted entries', () => {
  const raw = z(
    '# branch.head main',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 both-modified.txt',
    'u AA N... 100644 100644 100644 100644 h1 h2 h3 both-added.txt',
    'u DD N... 100644 100644 100644 100644 h1 h2 h3 both-deleted.txt',
  );
  const status = parseStatusPorcelainV2(raw);
  assert.deepEqual(status.conflicted, [
    { path: 'both-modified.txt', status: 'U', staged: false, conflict: 'UU' },
    { path: 'both-added.txt', status: 'U', staged: false, conflict: 'AA' },
    { path: 'both-deleted.txt', status: 'U', staged: false, conflict: 'DD' },
  ]);
  assert.deepEqual(status.staged, []);
  assert.deepEqual(status.changed, []);
});

test('porcelain v2: paths keep spaces and non-ASCII bytes verbatim', () => {
  const raw = z(
    '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaa bbbb 文档 目录/说明 文档.md',
    '? 新建 文件.txt',
    '? émoji-🙂.txt',
  );
  const status = parseStatusPorcelainV2(raw);
  assert.equal(status.changed[0].path, '文档 目录/说明 文档.md');
  assert.deepEqual(status.untracked.map((entry) => entry.path), ['新建 文件.txt', 'émoji-🙂.txt']);
});

test('porcelain v2: unborn branch and detached HEAD', () => {
  const unborn = parseStatusPorcelainV2(z('# branch.oid (initial)', '# branch.head main', '? a.txt'));
  assert.equal(unborn.unborn, true);
  assert.equal(unborn.head, null);
  assert.equal(unborn.branch, 'main');
  assert.equal(unborn.detached, false);
  assert.equal(unborn.untracked.length, 1);

  const detached = parseStatusPorcelainV2(
    z('# branch.oid abcdefabcdefabcdefabcdefabcdefabcdefabcd', '# branch.head (detached)', '1 M. N... 100644 100644 100644 a b staged.txt'),
  );
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.unborn, false);
  assert.equal(detached.staged.length, 1);
});

test('porcelain v2: ignored records are dropped and empty input is safe', () => {
  const raw = z('# branch.head main', '! build/output.bin');
  const status = parseStatusPorcelainV2(raw);
  assert.deepEqual(status.untracked, []);
  assert.deepEqual(status.staged, []);
  assert.deepEqual(parseStatusPorcelainV2(''), {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    head: null,
    detached: false,
    unborn: false,
    staged: [],
    changed: [],
    untracked: [],
    conflicted: [],
  });
});

test('porcelain v2: newline-separated output is accepted too', () => {
  const raw = [
    '# branch.head main',
    '1 M. N... 100644 100644 100644 a b one.txt',
    '2 R. N... 100644 100644 100644 a b R090 two.txt\told-two.txt',
  ].join('\n');
  const status = parseStatusPorcelainV2(raw);
  assert.equal(status.staged.length, 2);
  assert.equal(status.staged[1].origPath, 'old-two.txt');
});

test('parseRefTrack reads the divergence counters', () => {
  assert.deepEqual(parseRefTrack('[ahead 2, behind 1]'), { ahead: 2, behind: 1, gone: false });
  assert.deepEqual(parseRefTrack('[ahead 3]'), { ahead: 3, behind: 0, gone: false });
  assert.deepEqual(parseRefTrack('[behind 4]'), { ahead: 0, behind: 4, gone: false });
  assert.deepEqual(parseRefTrack('[gone]'), { ahead: 0, behind: 0, gone: true });
  assert.deepEqual(parseRefTrack('ahead 7, behind 0'), { ahead: 7, behind: 0, gone: false });
  assert.deepEqual(parseRefTrack(''), { ahead: 0, behind: 0, gone: false });
  assert.deepEqual(parseRefTrack(undefined), { ahead: 0, behind: 0, gone: false });
});

test('parseUnifiedDiff counts additions, deletions and binary patches', () => {
  const patch = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' export {};',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/logo.png differ',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], {
    path: 'src/app.js',
    oldPath: null,
    status: 'M',
    binary: false,
    added: 2,
    removed: 1,
    header: ['diff --git a/src/app.js b/src/app.js', 'index 1111111..2222222 100644', '--- a/src/app.js', '+++ b/src/app.js'].join('\n'),
  });
  assert.equal(files[1].path, 'logo.png');
  assert.equal(files[1].status, 'A');
  assert.equal(files[1].binary, true);
  assert.equal(files[1].added, 0);
  assert.equal(files[1].removed, 0);
});

test('parseUnifiedDiff derives a status letter from the patch header', () => {
  const added = parseUnifiedDiff(
    ['diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+hi'].join('\n'),
  );
  assert.equal(added[0].status, 'A');
  const modified = parseUnifiedDiff(
    ['diff --git a/m.txt b/m.txt', 'index 1..2 100644', '--- a/m.txt', '+++ b/m.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
  );
  assert.equal(modified[0].status, 'M');
});

test('buildCommitDiffArgs asks git show for the commit own patch', () => {
  assert.deepEqual(buildCommitDiffArgs({ rev: 'abc', path: 'src/a.ts', context: 3 }), [
    'show',
    '--no-color',
    '--no-ext-diff',
    '--format=',
    '-m',
    '--first-parent',
    '-U3',
    'abc',
    '--',
    'src/a.ts',
  ]);
  assert.deepEqual(buildCommitDiffArgs({ rev: 'abc', ignoreWhitespace: true }), [
    'show',
    '--no-color',
    '--no-ext-diff',
    '--format=',
    '-m',
    '--first-parent',
    '--ignore-all-space',
    'abc',
    '--',
  ]);
});

test('parseUnifiedDiff reports renames through oldPath', () => {
  const patch = [
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'new.txt');
  assert.equal(files[0].oldPath, 'old.txt');
  assert.equal(files[0].status, 'R');
});

test('parseUnifiedDiff handles a deleted file and an empty patch', () => {
  const patch = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.equal(files[0].path, 'gone.txt');
  assert.equal(files[0].oldPath, null);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].status, 'D');
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('parseDiffGitLine reads quoted and plain headers', () => {
  assert.deepEqual(parseDiffGitLine('diff --git a/x.txt b/x.txt'), { oldPath: 'x.txt', path: 'x.txt' });
  assert.deepEqual(parseDiffGitLine('diff --git "a/sp ace.txt" "b/sp ace.txt"'), {
    oldPath: 'sp ace.txt',
    path: 'sp ace.txt',
  });
  assert.deepEqual(parseDiffGitLine('diff --git a/文档.md b/文档.md'), { oldPath: '文档.md', path: '文档.md' });
});

test('buildDiffArgs assembles the documented flags', () => {
  assert.deepEqual(buildDiffArgs({}), ['diff', '--no-color', '--no-ext-diff', '--']);
  assert.deepEqual(buildDiffArgs({ staged: true, path: 'a.txt' }), [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--cached',
    '--',
    'a.txt',
  ]);
  assert.deepEqual(buildDiffArgs({ rev: 'HEAD~2', context: 7, ignoreWhitespace: true }), [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--ignore-all-space',
    '-U7',
    'HEAD~2',
    '--',
  ]);
});

test('parseLog decodes every field and decorations', () => {
  const record = [
    'aaaa1111',
    'aaaa111',
    'bbbb2222 cccc3333',
    'Ada Lovelace',
    'ada@example.com',
    '2026-11-01T10:00:00+08:00',
    'HEAD -> main, origin/main, tag: v1',
    'Add the thing',
  ].join('\0');
  const commits = parseLog(`${record}\0\n`);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    hash: 'aaaa1111',
    shortHash: 'aaaa111',
    parents: ['bbbb2222', 'cccc3333'],
    author: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    date: '2026-11-01T10:00:00+08:00',
    refs: ['main', 'origin/main', 'v1'],
    subject: 'Add the thing',
  });
  assert.deepEqual(parseLog(''), []);
});

test('parseCommitLine tolerates an empty decoration and root commit', () => {
  const record = ['aaaa', 'aaa', '', 'Solo', 'solo@example.com', '2026-01-01T00:00:00Z', '', 'Initial'].join('\0');
  const commit = parseCommitLine(`${record}\0`);
  assert.deepEqual(commit.parents, []);
  assert.deepEqual(commit.refs, []);
  assert.equal(parseCommitLine('nonsense'), null);
  assert.deepEqual(parseDecoration('HEAD -> dev'), ['dev']);
  assert.deepEqual(parseDecoration(''), []);
});

test('buildLogArgs clamps the page size and keeps paths after --', () => {
  const { args, limit } = buildLogArgs({ limit: 5, skip: 10, path: 'src', ref: 'main' });
  assert.equal(limit, 5);
  assert.deepEqual(args, ['log', '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00', '-n', '6', '--skip', '10', 'main', '--', 'src']);
  assert.equal(buildLogArgs({ limit: 0 }).limit, 1);
  assert.equal(buildLogArgs({ limit: 99999 }).limit, 1000);
  assert.equal(buildLogArgs({ skip: -5 }).args.includes('--skip'), false);
});

test('parseBranchLine marks the current branch and divergence', () => {
  const line = [
    'main',
    'refs/heads/main',
    'origin/main',
    '[ahead 2, behind 1]',
    'abc123',
    'Latest work',
    '2026-11-01T10:00:00+08:00',
    'Ada',
  ].join('\0');
  const branch = parseBranchLine(line, 'main');
  assert.equal(branch.current, true);
  assert.equal(branch.remote, false);
  assert.equal(branch.upstream, 'origin/main');
  assert.equal(branch.ahead, 2);
  assert.equal(branch.behind, 1);
  assert.deepEqual(branch.lastCommit, { hash: 'abc123', subject: 'Latest work', date: '2026-11-01T10:00:00+08:00', author: 'Ada' });

  const remote = parseBranchLine(
    ['origin/main', 'refs/remotes/origin/main', '', '', 'abc123', 'Latest work', '2026-11-01T10:00:00+08:00', 'Ada'].join('\0'),
    'main',
  );
  assert.equal(remote.remote, true);
  assert.equal(remote.current, false);
  assert.equal(remote.upstream, null);
  assert.equal(parseBranchLine('origin/HEAD\0refs/remotes/origin/HEAD\0\0\0abc\0x\0d\0a', 'main'), null);
});

test('parseStashList decodes index, ref, message and date', () => {
  const first = ['stash@{0}', '1697760000', 'WIP on main: 1234567 tidy'].join('\0');
  const second = ['stash@{1}', '1697700000', 'On feature: message'].join('\0');
  const entries = parseStashList(`${first}\n${second}\n`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].ref, 'stash@{0}');
  assert.equal(entries[0].message, 'WIP on main: 1234567 tidy');
  assert.equal(entries[0].date, new Date(1697760000 * 1000).toISOString());
  assert.equal(entries[1].index, 1);
});

test('parseTagList distinguishes annotated tags', () => {
  const annotated = ['v1.0.0', 'aaa', '2026-01-01T00:00:00Z', 'Release one', 'tag'].join('\0');
  const lightweight = ['v0.9.0', 'bbb', '2025-12-01T00:00:00Z', 'Earlier', 'commit'].join('\0');
  const tags = parseTagList(`${annotated}\n${lightweight}`);
  assert.deepEqual(tags[0], {
    name: 'v1.0.0',
    hash: 'aaa',
    date: '2026-01-01T00:00:00Z',
    message: 'Release one',
    annotated: true,
  });
  assert.equal(tags[1].annotated, false);
});

test('parseRemotes merges fetch and push URLs', () => {
  const text = ['origin\tgit@example.com:repo.git (fetch)', 'origin\tgit@example.com:repo.git (push)', 'upstream\thttps://example.com/up.git (fetch)'].join('\n');
  assert.deepEqual(parseRemotes(text), [
    { name: 'origin', fetchUrl: 'git@example.com:repo.git', pushUrl: 'git@example.com:repo.git' },
    { name: 'upstream', fetchUrl: 'https://example.com/up.git', pushUrl: 'https://example.com/up.git' },
  ]);
  assert.deepEqual(parseRemotes(''), []);
});

test('parseSubmoduleStatus maps the leading marker to a state', () => {
  const text = [' abc123 vendor/lib (v1.0)', '+def456 vendor/other (v2.0)', '-012345 vendor/off (v0.1)'].join('\n');
  assert.deepEqual(parseSubmoduleStatus(text), [
    { path: 'vendor/lib', sha: 'abc123', state: 'initialized' },
    { path: 'vendor/other', sha: 'def456', state: 'modified' },
    { path: 'vendor/off', sha: '012345', state: 'uninitialized' },
  ]);
  assert.deepEqual(parseSubmoduleStatus(''), []);
});
