/**
 * Source-level tests for the dsh-git browser half.
 *
 * `client.js` is a browser bundle: it calls `window.__ModuleLoader__.load(...)`
 * at import time and needs `react` plus a live DSH page, so this suite never
 * imports it. Instead it
 *
 *   1. compiles it with `vm.Script` (syntax gate, nothing is executed),
 *   2. extracts the pure helper declarations out of the factory body and runs
 *      them in an isolated context, and
 *   3. checks the static contracts that are cheap to regress: locale parity,
 *      locale key coverage, token-only styling, no forbidden constructs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = path.join(root, 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'en.json'), 'utf8'));
const icon = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');

/** Keys contract §8 requires in both dictionaries. */
const REQUIRED_KEYS = [
  'tab.title',
  'guide.title',
  'guide.description',
  'header.button',
  'repo.none',
  'repo.add',
  'repo.init',
  'repo.refresh',
  'repo.settings',
  'status.staged',
  'status.changes',
  'status.untracked',
  'status.conflicts',
  'status.clean',
  'action.stage',
  'action.unstage',
  'action.discard',
  'action.openDiff',
  'action.commit',
  'action.commitPush',
  'action.commitSync',
  'action.amend',
  'action.stageAllCommit',
  'branch.title',
  'branch.current',
  'branch.create',
  'branch.rename',
  'branch.delete',
  'branch.checkout',
  'branch.upstream',
  'history.title',
  'history.loadMore',
  'history.empty',
  'stash.title',
  'tag.title',
  'remote.title',
  'submodule.title',
  'raw.title',
  'raw.run',
  'raw.placeholder',
  'operation.merge',
  'operation.rebase',
  'operation.cherryPick',
  'operation.revert',
  'operation.bisect',
  'operation.continue',
  'operation.skip',
  'operation.abort',
  'error.E_NOT_REPO',
  'error.E_NO_GIT',
  'error.E_TIMEOUT',
  'error.E_AUTH_REQUIRED',
  'error.E_LOCKED',
  'error.E_CONFLICT',
  'error.E_INVALID_ARG',
  'error.E_GIT_FAILED',
  'error.E_UNSUPPORTED',
  'error.E_INTERNAL',
  'confirm.discard',
  'confirm.deleteBranch',
  'confirm.forcePush',
  'common.cancel',
  'common.confirm',
  'common.copy',
  'common.close',
  'common.loading',
  'common.empty',
];

/**
 * Return the index just past the balanced closer of the bracket that opens at
 * `from`. String literals, template literals and comments are skipped so braces
 * inside them do not confuse the scan.
 * @param {string} text
 * @param {number} from - index of an opening `{`, `[` or `(`.
 * @returns {number}
 */
function scanBalanced(text, from) {
  const open = text.charAt(from);
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  let index = from;
  while (index < text.length) {
    const ch = text.charAt(index);
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      index += 1;
      while (index < text.length) {
        const inner = text.charAt(index);
        if (inner === '\\') {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === quote) break;
      }
      continue;
    }
    if (ch === '/' && text.charAt(index + 1) === '/') {
      const stop = text.indexOf('\n', index);
      index = stop < 0 ? text.length : stop + 1;
      continue;
    }
    if (ch === '/' && text.charAt(index + 1) === '*') {
      const stop = text.indexOf('*/', index + 2);
      index = stop < 0 ? text.length : stop + 2;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  throw new Error('unbalanced ' + open + ' starting at ' + from);
}

/**
 * Slice a top-level declaration (function or const object/array) out of the
 * factory body.
 * @param {string} header - e.g. `function middleEllipsis` or `const KNOWN_CODES =`.
 * @returns {string}
 */
function sliceDeclaration(header) {
  const start = source.indexOf('    ' + header);
  if (start < 0) throw new Error('declaration not found: ' + header);
  let cursor = start + header.length;
  // Skip the parameter list of a function declaration, then take the body or
  // the literal that follows the `=`.
  while (cursor < source.length) {
    const ch = source.charAt(cursor);
    if (ch === '{' || ch === '[') break;
    if (ch === '(') {
      cursor = scanBalanced(source, cursor);
      continue;
    }
    cursor += 1;
  }
  if (cursor >= source.length) throw new Error('no body for ' + header);
  return source.slice(start, scanBalanced(source, cursor));
}

const HELPER_DECLARATIONS = [
  'const KNOWN_CODES =',
  'const DEFAULT_SETTINGS =',
  'function isAbsolutePath',
  'function splitPathList',
  'function clampInt',
  'function middleEllipsis',
  'function splitRepoPath',
  'function splitUpstream',
  'function classifyDiffLine',
  'function classifyDiffLines',
  'function statusLetter',
  'function statusTone',
  'function formatDiffStat',
  'function shortHash',
  'function normalizeSettings',
  'function withScanRoot',
  'function pickRepo',
  'function describeError',
  'function cleanErrorText',
  'function repoOptionLabel',
  'function mergeRoots',
];

const HELPER_NAMES = [
  'isAbsolutePath',
  'splitPathList',
  'clampInt',
  'middleEllipsis',
  'splitRepoPath',
  'splitUpstream',
  'classifyDiffLine',
  'classifyDiffLines',
  'statusLetter',
  'statusTone',
  'formatDiffStat',
  'shortHash',
  'normalizeSettings',
  'withScanRoot',
  'pickRepo',
  'describeError',
  'cleanErrorText',
  'repoOptionLabel',
  'mergeRoots',
];

const helpers = (() => {
  const body = HELPER_DECLARATIONS.map(sliceDeclaration).join('\n\n');
  // Run in this realm (inside an IIFE) so returned arrays and objects keep the
  // intrinsic prototypes `deepStrictEqual` compares against.
  const script = new vm.Script(
    '(function () {\n' + body + '\nreturn {' + HELPER_NAMES.join(',') + '};\n})()',
    { filename: 'dsh-git-helpers.js' },
  );
  return script.runInThisContext();
})();

/** @param {string} key */
const fakeT = (key) => 'T:' + key;

test('client.js compiles without executing', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'client.js' }));
});

test('module shape matches the loader contract', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id: '@local\/dsh-git'/);
  assert.match(source, /factory\(require\)/);
  assert.match(source, /inject: \['slots', 'locale'\]/);
  assert.match(source, /apply\(ctx\)/);
  assert.equal(source.match(/require\(/g).length, 1, 'only one require call');
  assert.deepEqual([...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]), ['react']);
});

test('registers the three documented UI entry points', () => {
  assert.match(source, /ctx\.inject\(\['sidebarRightTabs'\]/);
  assert.match(source, /conversation\.session\.header\.utilities/);
  assert.match(source, /'sidebar\.right\.pane\.tab'/);
  assert.match(source, /'sidebar\.right\.pane\.tab\.title'/);
  assert.match(source, /guide: \[/);
  assert.match(source, /order: 30/);
  assert.match(source, /openTab\(TAB_ID\)/);
  assert.match(source, /openRightbar/);
});

test('avoids forbidden constructs', () => {
  assert.doesNotMatch(source, /\bTODO\b/);
  assert.doesNotMatch(source, /\bFIXME\b/);
  assert.doesNotMatch(source, /\bas any\b/);
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new Function/);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bprocess\./);
  assert.doesNotMatch(source, /from 'node:/);
});

test('styles use theme tokens only', () => {
  const customProps = [...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(customProps.length > 20, 'styles read many custom properties');
  // The palette documented for the shell: semantic aliases plus a small set of
  // global tokens that have no alias equivalent.
  const GLOBAL_TOKENS = ['--dsw-focus-ring-color', '--dsw-shadow-lv1', '--dsw-shadow-lv2', '--dsw-shadow-lv3'];
  const foreign = customProps.filter((name) => !name.startsWith('--dsw-alias-') && GLOBAL_TOKENS.indexOf(name) === -1);
  assert.deepEqual([...new Set(foreign)], [], 'every token is a documented theme token');
  assert.equal(source.match(/#[0-9a-fA-F]{3,8}\b/g), null, 'no hard-coded hex colors');
});

test('locale files stay in sync', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', key + ' is a string');
    assert.notEqual(value.trim(), '', key + ' is not empty');
    assert.equal(typeof en[key], 'string');
    assert.notEqual(en[key].trim(), '');
  }
  assert.equal(zh['tab.title'], 'Git');
});

test('every required contract key exists', () => {
  const missing = REQUIRED_KEYS.filter((key) => !(key in zh) || !(key in en));
  assert.deepEqual(missing, []);
});

test('every key referenced by client.js exists in both locales', () => {
  const used = new Set();
  for (const match of source.matchAll(/\bt\(\s*'([^']*)'/g)) {
    const key = match[1];
    // `t('error.' + code)` is dynamic; the concrete keys are required above.
    if (key === '' || key.endsWith('.')) continue;
    used.add(key);
  }
  assert.ok(used.size > 100, 'client.js uses the locale dictionary');
  const missing = [...used].filter((key) => !(key in zh) || !(key in en)).sort();
  assert.deepEqual(missing, []);
});

test('dictionaries cover every error code the client maps', () => {
  for (const code of ['E_NOT_REPO', 'E_NO_GIT', 'E_TIMEOUT', 'E_AUTH_REQUIRED', 'E_LOCKED', 'E_CONFLICT', 'E_INVALID_ARG', 'E_GIT_FAILED', 'E_UNSUPPORTED', 'E_INTERNAL']) {
    assert.equal(typeof zh['error.' + code], 'string');
    assert.equal(typeof en['error.' + code], 'string');
  }
  assert.equal(typeof zh['error.network'], 'string');
  assert.equal(typeof zh['error.unknown'], 'string');
});

test('icon.svg is an original 24x24 currentColor glyph', () => {
  assert.match(icon, /viewBox="0 0 24 24"/);
  assert.match(icon, /stroke="currentColor"/);
  assert.match(icon, /<circle /);
  assert.match(icon, /<path /);
  assert.doesNotMatch(icon, /<image/i);
  assert.doesNotMatch(icon, /href=/i);
  assert.doesNotMatch(icon, /<script/i);
});

test('isAbsolutePath accepts POSIX, drive and UNC paths', () => {
  assert.equal(helpers.isAbsolutePath('/tmp/repo'), true);
  assert.equal(helpers.isAbsolutePath('C:\\repo'), true);
  assert.equal(helpers.isAbsolutePath('d:/repo'), true);
  assert.equal(helpers.isAbsolutePath('\\\\server\\share'), true);
  assert.equal(helpers.isAbsolutePath('repo/sub'), false);
  assert.equal(helpers.isAbsolutePath(''), false);
  assert.equal(helpers.isAbsolutePath(null), false);
});

test('splitPathList trims, splits and de-duplicates', () => {
  assert.deepEqual(helpers.splitPathList('/a, /b\n/a'), ['/a', '/b']);
  assert.deepEqual(helpers.splitPathList([' x ', 'x', '', 'y']), ['x', 'y']);
  assert.deepEqual(helpers.splitPathList(undefined), []);
  assert.deepEqual(helpers.splitPathList(42), []);
});

test('clampInt rounds and clamps into range', () => {
  assert.equal(helpers.clampInt('99', 1, 10, 5), 10);
  assert.equal(helpers.clampInt('3', 1, 10, 5), 3);
  assert.equal(helpers.clampInt('3.7', 1, 10, 5), 3);
  assert.equal(helpers.clampInt(3.7, 1, 10, 5), 4);
  assert.equal(helpers.clampInt(0, 1, 10, 5), 1);
  assert.equal(helpers.clampInt('nope', 1, 10, 5), 5);
  assert.equal(helpers.clampInt(null, 1, 10, 5), 5);
});

test('splitRepoPath separates directory from file name', () => {
  assert.deepEqual(helpers.splitRepoPath('lib/common/voice/voice_field.dart'), {
    dir: 'lib/common/voice',
    name: 'voice_field.dart',
  });
  assert.deepEqual(helpers.splitRepoPath('README.md'), { dir: '', name: 'README.md' });
  assert.deepEqual(helpers.splitRepoPath('/abs/file.ts'), { dir: '/abs', name: 'file.ts' });
  assert.deepEqual(helpers.splitRepoPath('dir/'), { dir: 'dir', name: '' });
  assert.deepEqual(helpers.splitRepoPath(''), { dir: '', name: '' });
  assert.deepEqual(helpers.splitRepoPath(null), { dir: '', name: '' });
});

test('file paths render directory dimmed and file name whole', () => {
  assert.match(source, /function FilePathLabel/);
  assert.match(source, /className: 'dg-filepath-dir'/);
  assert.match(source, /className: 'dg-filepath-name'/);
  assert.match(source, /\.dg-filepath-dir \{[^}]*text-overflow: ellipsis/);
  // The old fixed-width truncation hid the file name; it must stay gone.
  assert.doesNotMatch(source, /middleEllipsis\(filePath, 34\)/);
  assert.doesNotMatch(source, /middleEllipsis\(path, 30\)/);
});

test('middleEllipsis keeps both ends inside the limit', () => {
  const long = 'packages/deep/nested/directory/file-name.ts';
  const short = helpers.middleEllipsis(long, 12);
  assert.equal(short.length, 12);
  assert.ok(short.includes('…'));
  assert.ok(short.startsWith('packa'));
  assert.ok(short.endsWith('.ts'));
  assert.equal(helpers.middleEllipsis('src/a.ts', 40), 'src/a.ts');
  assert.equal(helpers.middleEllipsis(null), '');
  assert.equal(helpers.middleEllipsis(long).length, 40);
});

test('classifyDiffLine tags unified-diff lines', () => {
  assert.equal(helpers.classifyDiffLine('@@ -1,2 +1,3 @@'), 'hunk');
  assert.equal(helpers.classifyDiffLine('+++ b/src/a.ts'), 'file');
  assert.equal(helpers.classifyDiffLine('--- a/src/a.ts'), 'file');
  assert.equal(helpers.classifyDiffLine('diff --git a/x b/x'), 'meta');
  assert.equal(helpers.classifyDiffLine('index 1234567..89abcde 100644'), 'meta');
  assert.equal(helpers.classifyDiffLine('new file mode 100644'), 'meta');
  assert.equal(helpers.classifyDiffLine('+added'), 'add');
  assert.equal(helpers.classifyDiffLine('-removed'), 'del');
  assert.equal(helpers.classifyDiffLine(' context'), 'ctx');
  assert.equal(helpers.classifyDiffLine(''), 'ctx');
  assert.equal(helpers.classifyDiffLine(null), 'ctx');
});

test('classifyDiffLines drops the trailing newline only', () => {
  const rows = helpers.classifyDiffLines('+a\n-b\n c\n');
  assert.deepEqual(rows.map((row) => row.kind), ['add', 'del', 'ctx']);
  assert.deepEqual(helpers.classifyDiffLines(''), []);
  assert.deepEqual(helpers.classifyDiffLines(null), []);
  assert.deepEqual(helpers.classifyDiffLines('\n').map((row) => row.text), ['']);
});

test('statusLetter and statusTone agree on the row badge', () => {
  assert.equal(helpers.statusLetter({ status: 'M' }), 'M');
  assert.equal(helpers.statusLetter({ status: 'R' }), 'R');
  assert.equal(helpers.statusLetter({ status: 'U', conflict: 'UU' }), 'U');
  assert.equal(helpers.statusLetter({ status: '?' }), '?');
  assert.equal(helpers.statusLetter({}), '?');
  assert.equal(helpers.statusLetter(null), '?');
  assert.equal(helpers.statusTone('A'), 'add');
  assert.equal(helpers.statusTone('C'), 'add');
  assert.equal(helpers.statusTone('D'), 'del');
  assert.equal(helpers.statusTone('M'), 'mod');
  assert.equal(helpers.statusTone('R'), 'mod');
  assert.equal(helpers.statusTone('T'), 'mod');
  assert.equal(helpers.statusTone('U'), 'conflict');
  assert.equal(helpers.statusTone('?'), 'new');
  assert.equal(helpers.statusTone('Z'), 'plain');
});

test('formatDiffStat and shortHash render compact labels', () => {
  assert.equal(helpers.formatDiffStat(12, 3), '+12 −3');
  assert.equal(helpers.formatDiffStat(undefined, NaN), '+0 −0');
  assert.equal(helpers.formatDiffStat(-5, 2.6), '+0 −3');
  assert.equal(helpers.shortHash('abcdef1234567890'), 'abcdef1');
  assert.equal(helpers.shortHash('abcdef1234567890', 10), 'abcdef1234');
  assert.equal(helpers.shortHash(null), '');
});

test('normalizeSettings repairs persisted values', () => {
  assert.deepEqual(
    helpers.normalizeSettings({
      scanDepth: '99',
      roots: '/a\n/b',
      autoDetection: 'subFolders',
      pullStrategy: 'ff-only',
    }),
    { scanDepth: 10, roots: ['/a', '/b'], autoDetection: 'subFolders', pullStrategy: 'ff-only' },
  );
  assert.deepEqual(helpers.normalizeSettings(null), {
    scanDepth: 5,
    roots: [],
    autoDetection: 'true',
    pullStrategy: 'merge',
  });
  assert.deepEqual(helpers.normalizeSettings({ scanDepth: 0, autoDetection: 'nope', pullStrategy: 'x' }), {
    scanDepth: 1,
    roots: [],
    autoDetection: 'true',
    pullStrategy: 'merge',
  });
});

test('pickRepo keeps the selection and prefers the containing repo', () => {
  const repos = [{ path: '/w/a' }, { path: '/w/a/nested/b' }, { path: '/w/c' }];
  assert.equal(helpers.pickRepo('/w/c', repos, ['/w/a']), '/w/c');
  assert.equal(helpers.pickRepo('/gone', repos, ['/w/a/nested/b/src']), '/w/a/nested/b');
  assert.equal(helpers.pickRepo('', repos, ['/elsewhere']), '/w/a');
  assert.equal(helpers.pickRepo('', [], ['/w']), '');
  assert.equal(helpers.pickRepo('', [{ path: '' }, null], ['/w']), '');
});

test('describeError localizes the code and keeps the raw detail', () => {
  const locked = Object.assign(new Error('index.lock exists'), { code: 'E_LOCKED', detail: 'fatal: locked' });
  assert.deepEqual(helpers.describeError(locked, fakeT), {
    code: 'E_LOCKED',
    title: 'T:error.E_LOCKED',
    hint: 'T:error.E_LOCKED.hint',
    raw: 'locked',
    detail: 'locked',
  });
  const offline = new Error('Failed to fetch');
  assert.deepEqual(helpers.describeError(offline, fakeT), {
    code: '',
    title: 'T:error.network',
    hint: '',
    raw: 'Failed to fetch',
    detail: 'Failed to fetch',
  });
  const odd = Object.assign(new Error('boom'), { code: 'E_WEIRD' });
  assert.equal(helpers.describeError(odd, fakeT).title, 'T:error.unknown');
  assert.deepEqual(helpers.describeError(null, fakeT), {
    code: '',
    title: 'T:error.network',
    hint: '',
    raw: '',
    detail: '',
  });
});

test('an unmerged branch error names the commits in the localized hint', () => {
  const error = Object.assign(new Error('the branch is not fully merged'), {
    code: 'E_BRANCH_NOT_MERGED',
    detail: '1 commit(s) are not merged into HEAD: 331e958 wip: voice',
  });
  const t = (key, params) => (params === undefined ? 'T:' + key : 'T:' + key + '|' + JSON.stringify(params));
  const info = helpers.describeError(error, t);
  assert.equal(info.title, 'T:error.E_BRANCH_NOT_MERGED');
  assert.equal(info.hint, 'T:error.E_BRANCH_NOT_MERGED.count|{"n":"1","list":"331e958 wip: voice"}');
  assert.equal(info.raw, '1 commit(s) are not merged into HEAD: 331e958 wip: voice');

  // Without the commit list the static hint stays in place.
  const bare = Object.assign(new Error('nope'), {
    code: 'E_BRANCH_NOT_MERGED',
    detail: '1 commit(s) are not merged into HEAD',
  });
  assert.equal(helpers.describeError(bare, t).hint, 'T:error.E_BRANCH_NOT_MERGED.hint');
});

test('cleanErrorText drops git advice, prefixes and repeats', () => {
  const stderr = [
    "error: the branch 'dev' is not fully merged",
    "hint: If you are sure you want to delete it, run 'git branch -D dev'",
    'hint: Disable this message with "git config set advice.forceDeleteBranch false"',
    '',
    "the branch 'dev' is not fully merged",
    'fatal: something else',
  ].join('\n');
  assert.equal(
    helpers.cleanErrorText(stderr),
    "the branch 'dev' is not fully merged\nsomething else",
  );
  assert.equal(helpers.cleanErrorText(''), '');
  assert.equal(helpers.cleanErrorText(null), '');
  assert.equal(helpers.cleanErrorText('hint: only advice'), '');
});

test('every known code has a localized hint', () => {
  const codes = Object.keys(zh)
    .filter((key) => /^error\.E_[A-Z_]+$/.test(key))
    .map((key) => key.slice('error.'.length));
  assert.ok(codes.length >= 20, 'expected the full error catalogue, got ' + codes.length);
  for (const code of codes) {
    assert.equal(typeof zh['error.' + code + '.hint'], 'string', 'zh hint for ' + code);
    assert.equal(typeof en['error.' + code + '.hint'], 'string', 'en hint for ' + code);
    assert.ok(zh['error.' + code + '.hint'].length > 4, 'zh hint text for ' + code);
    assert.ok(en['error.' + code + '.hint'].length > 4, 'en hint text for ' + code);
  }
  assert.equal(typeof zh['error.raw'], 'string');
  assert.equal(typeof en['error.raw'], 'string');
});

test('splitUpstream separates the remote from the branch name', () => {
  assert.deepEqual(helpers.splitUpstream('origin/dev_1.5.10'), { remote: 'origin', branch: 'dev_1.5.10' });
  assert.deepEqual(helpers.splitUpstream('main'), { remote: '', branch: 'main' });
  assert.deepEqual(helpers.splitUpstream(''), { remote: '', branch: '' });
  assert.deepEqual(helpers.splitUpstream(null), { remote: '', branch: '' });
});

test('a mismatched upstream asks which branch to push to', () => {
  // The choice is put in front of the user instead of relaying git's lecture.
  assert.match(source, /t\('push\.mismatchTitle'\)/);
  assert.match(source, /t\('push\.toSame'/);
  assert.match(source, /t\('push\.toUpstream'/);
  assert.match(source, /values\.to === 'upstream' \? 'upstream' : 'same'/);
  assert.match(source, /code !== 'E_UPSTREAM_MISMATCH'/);
  assert.match(source, /to: to === 'same' \|\| to === 'upstream' \? to : undefined/);
});

test('an unmerged delete offers the force path instead of a dead end', () => {
  assert.match(source, /code !== 'E_BRANCH_NOT_MERGED'/);
  assert.match(source, /t\('confirm\.forceDeleteBranch'/);
  assert.match(source, /force: force === true \? true : undefined/);
  assert.match(source, /dismissError: \(\) => setError\(null\)/);
});

test('the error bar shows a localized hint and hides raw output', () => {
  assert.match(source, /className: 'dg-error-hint'/);
  assert.match(source, /h\(\s*'details',\s*\{ className: 'dg-error-raw' \}/);
  assert.match(source, /t\('error\.raw'\)/);
});

test('repoOptionLabel summarizes a repository row', () => {
  assert.equal(helpers.repoOptionLabel({ name: 'demo', branch: 'main', changed: 2 }, fakeT), 'demo · main · ±2');
  assert.equal(helpers.repoOptionLabel({ displayName: 'Pretty', branch: 'dev' }, fakeT), 'Pretty · dev');
  assert.equal(helpers.repoOptionLabel({ name: 'x', detached: true }, fakeT), 'x · T:repo.detached');
  assert.equal(helpers.repoOptionLabel({ name: 'x', unborn: true }, fakeT), 'x · T:repo.unborn');
  assert.equal(helpers.repoOptionLabel({ path: '/w/x', branch: 'main', error: 'bad' }, fakeT), '/w/x · main · !');
  assert.equal(helpers.repoOptionLabel(null, fakeT), 'T:repo.noneSelected');
});

test('mergeRoots concatenates without duplicates', () => {
  assert.deepEqual(helpers.mergeRoots(['/a', ' /b '], ['/b', '/c', 7, '']), ['/a', '/b', '/c']);
  assert.deepEqual(helpers.mergeRoots(null, undefined), []);
  assert.deepEqual(helpers.mergeRoots([], ['/only']), ['/only']);
});

test('withScanRoot appends one directory and ignores empty input', () => {
  const base = { scanDepth: 5, roots: ['/a'], autoDetection: 'true', pullStrategy: 'merge' };
  assert.deepEqual(helpers.withScanRoot(base, '/b').roots, ['/a', '/b']);
  assert.deepEqual(helpers.withScanRoot(base, ' /b ').roots, ['/a', '/b']);
  assert.deepEqual(helpers.withScanRoot(base, '/a').roots, ['/a'], 'duplicates are dropped');
  assert.deepEqual(helpers.withScanRoot(base, '').roots, ['/a']);
  assert.deepEqual(helpers.withScanRoot(base, 42).roots, ['/a']);
  assert.deepEqual(helpers.withScanRoot(null, '/only').roots, ['/only']);
});

test('the empty state offers the suggested scan roots', () => {
  assert.match(source, /suggestedRoots/);
  assert.match(source, /onAddSuggestion: addScanRoot/);
  assert.match(source, /empty\.suggestHint/);
  assert.match(source, /empty\.suggest'/);
});
