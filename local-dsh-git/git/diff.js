/**
 * Unified-diff parsing for the dsh-git Host half.
 *
 * `parseUnifiedDiff` is pure so the Client's file list and its `+a -b` counters
 * can be tested without a repository. `readDiff` builds the git command line,
 * asks for untracked files through `--no-index`, and truncates oversized output.
 */
import { gitError, normalizeRepoRelativePath, truncateText } from './util.js';
import { runGit } from './exec.js';

/** Maximum size of the raw diff text returned to the Client. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** Default number of context lines around each hunk. */
export const DEFAULT_CONTEXT = 3;

/**
 * Undo git's C-style quoting for one path token.
 * @param {string} token - a quoted or bare path.
 * @returns {string} the decoded path.
 */
function unquotePath(token) {
  const text = token.trim();
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') return text;
  const body = text.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      out += character;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) break;
    index += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      default: {
        const octal = /^[0-7]{3}/.exec(body.slice(index));
        if (octal !== null) {
          out += String.fromCharCode(Number.parseInt(octal[0], 8));
          index += 2;
        } else {
          out += next;
        }
      }
    }
  }
  return out;
}

/**
 * Peel the `a/` or `b/` prefix from a diff path, mapping `/dev/null` to null.
 * @param {string} value - raw path from the patch.
 * @returns {string | null}
 */
function cleanDiffPath(value) {
  const text = unquotePath(value);
  if (text === '/dev/null') return null;
  if (text.startsWith('a/') || text.startsWith('b/')) return text.slice(2);
  return text;
}

/**
 * Parse the two paths from a `diff --git` header line.
 * @param {string} line - the whole header line.
 * @returns {{ oldPath: string | null, path: string | null }}
 */
export function parseDiffGitLine(line) {
  const rest = line.startsWith('diff --git ') ? line.slice(11) : '';
  if (rest === '') return { oldPath: null, path: null };
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (match !== null) return { oldPath: cleanDiffPath(match[1]), path: cleanDiffPath(match[2]) };
    return { oldPath: null, path: null };
  }
  const separator = rest.lastIndexOf(' b/');
  if (separator > 0) {
    return { oldPath: cleanDiffPath(rest.slice(0, separator)), path: cleanDiffPath(rest.slice(separator + 1)) };
  }
  return { oldPath: null, path: null };
}

/**
 * Parse a complete unified diff into the contract's `DiffFile` list.
 *
 * Counts `+`/`-` lines inside hunks only, marks binary patches, keeps the raw
 * metadata block as `header`, and reports renames through `oldPath`.
 * @param {string} text - raw `git diff` output.
 * @returns {object[]} one `DiffFile` per changed file.
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string' || text === '') return [];
  const files = [];
  let current = null;
  let inHunk = false;

  const finish = () => {
    if (current === null) return;
    if (current.path === null) current.path = current.oldPath ?? '';
    files.push({
      path: current.path,
      oldPath: current.oldPath === current.path ? null : current.oldPath,
      // The status letter the Client paints on a file row. A patch does not
      // carry porcelain codes, so the letter is read from the patch header;
      // without it every commit file rendered as `?` (untracked).
      status: current.status,
      binary: current.binary,
      added: current.added,
      removed: current.removed,
      header: current.headerLines.join('\n'),
    });
    current = null;
    inHunk = false;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      const paths = parseDiffGitLine(line);
      current = {
        path: paths.path,
        oldPath: paths.oldPath,
        status: 'M',
        binary: false,
        added: 0,
        removed: 0,
        headerLines: [line],
      };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        current.oldPath = cleanDiffPath(line.slice(4).split('\t')[0]);
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('+++ ')) {
        const path = cleanDiffPath(line.slice(4).split('\t')[0]);
        if (path !== null) current.path = path;
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('new file mode ')) {
        current.status = 'A';
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        current.status = 'D';
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        current.status = 'R';
        current.oldPath = unquotePath(line.slice(12));
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.path = unquotePath(line.slice(10));
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('copy from ')) {
        current.oldPath = unquotePath(line.slice(10));
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('copy to ')) {
        current.path = unquotePath(line.slice(8));
        current.headerLines.push(line);
        continue;
      }
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        current.binary = true;
        current.headerLines.push(line);
        continue;
      }
      if (line !== '') current.headerLines.push(line);
      continue;
    }
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  finish();
  return files;
}

/**
 * Ask whether a path is tracked by the index.
 * @param {string} repoPath - repository path.
 * @param {string} path - repository-relative path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} options - transport options.
 * @returns {Promise<boolean>}
 */
async function isTracked(repoPath, path, options) {
  try {
    const result = await runGit(repoPath, ['ls-files', '--error-unmatch', '--', path], {
      ...options,
      allowExitCodes: [1],
    });
    return result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Build the argument list for one diff request.
 * @param {{
 *   path?: string,
 *   staged?: boolean,
 *   rev?: string,
 *   context?: number,
 *   ignoreWhitespace?: boolean,
 * }} params - diff parameters.
 * @returns {string[]}
 */
export function buildDiffArgs(params) {
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (params.ignoreWhitespace === true) args.push('--ignore-all-space');
  if (typeof params.context === 'number' && Number.isFinite(params.context)) {
    const context = Math.max(0, Math.min(50, Math.trunc(params.context)));
    args.push(`-U${context}`);
  }
  if (params.staged === true) args.push('--cached');
  if (typeof params.rev === 'string' && params.rev !== '') args.push(params.rev);
  args.push('--');
  if (typeof params.path === 'string' && params.path !== '') args.push(params.path);
  return args;
}

/**
 * Build the argument list that shows what one commit changed.
 *
 * `git diff <rev> -- <path>` compares the commit against the *working tree*,
 * which is empty for a file the commit introduced and nobody touched since —
 * exactly the "no changes" a reader of the commit view must never see. The
 * commit's own change is `git show <rev> -- <path>` (against the first parent),
 * so the reader gets the patch that belongs to the commit.
 * @param {{ path?: string, rev: string, context?: number, ignoreWhitespace?: boolean }} params - diff parameters.
 * @returns {string[]}
 */
export function buildCommitDiffArgs(params) {
  const args = ['show', '--no-color', '--no-ext-diff', '--format=', '-m', '--first-parent'];
  if (params.ignoreWhitespace === true) args.push('--ignore-all-space');
  if (typeof params.context === 'number' && Number.isFinite(params.context)) {
    const context = Math.max(0, Math.min(50, Math.trunc(params.context)));
    args.push(`-U${context}`);
  }
  args.push(params.rev, '--');
  if (typeof params.path === 'string' && params.path !== '') args.push(params.path);
  return args;
}

/**
 * Produce the `diff` action payload.
 *
 * When a single untracked path is requested, git's normal diff is empty, so the
 * file is rendered against `/dev/null` through `--no-index` (exit code 1 is the
 * documented success for that mode).
 * @param {string} repoPath - validated repository path.
 * @param {{
 *   path?: string,
 *   staged?: boolean,
 *   rev?: string,
 *   context?: number,
 *   ignoreWhitespace?: boolean,
 * }} params - diff parameters.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<{ files: object[], text: string, truncated: boolean }>}
 */
export async function readDiff(repoPath, params = {}, options = {}) {
  const relative = typeof params.path === 'string' && params.path !== '' ? normalizeRepoRelativePath(params.path) : null;
  const staged = params.staged === true;
  const hasRev = typeof params.rev === 'string' && params.rev !== '';
  let args;
  if (hasRev) {
    args = buildCommitDiffArgs({ ...params, rev: params.rev, path: relative ?? undefined });
  } else if (relative !== null && !staged && !(await isTracked(repoPath, relative, options))) {
    args = ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', relative];
  } else {
    args = buildDiffArgs({ ...params, path: relative ?? undefined });
  }
  const result = await runGit(repoPath, args, { ...options, allowExitCodes: [1] });
  const clipped = truncateText(result.stdout, MAX_DIFF_BYTES);
  return { files: parseUnifiedDiff(clipped.text), text: clipped.text, truncated: clipped.truncated };
}

/**
 * Guard for the `diff` action: a repository must have a work tree.
 * @param {{ kind: string }} repo - the validated repository.
 * @returns {void}
 */
export function requireWorkTree(repo) {
  if (repo.kind === 'bare') throw gitError('E_INVALID_ARG', 'a bare repository has no work tree');
}
