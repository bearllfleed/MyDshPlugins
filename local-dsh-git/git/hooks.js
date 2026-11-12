/**
 * Hook detection for the dsh-git Host half.
 *
 * A failing hook usually prints only its own message, so git's stderr does not
 * say "hook". When a write command fails generically, the action checks whether
 * a hook for that phase exists at all — if it does, the failure is reported as
 * `E_HOOK_FAILED` with the hook's own output as detail, which is the only thing
 * the user can act on.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runGit } from './exec.js';

/** Hooks that can run during `git commit`, in execution order. */
export const COMMIT_HOOKS = Object.freeze(['pre-commit', 'prepare-commit-msg', 'commit-msg']);
/** Hooks that can run during `git push`. */
export const PUSH_HOOKS = Object.freeze(['pre-push']);

/**
 * Resolve the hooks directory, honouring `core.hooksPath`.
 * @param {string} repoPath - repository path.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<string | null>}
 */
export async function hooksDirectory(repoPath, options = {}) {
  try {
    const result = await runGit(repoPath, ['rev-parse', '--git-path', 'hooks'], { ...options, timeoutMs: 5000 });
    const value = result.stdout.trim();
    if (value === '') return null;
    return isAbsolute(value) ? value : join(repoPath, value);
  } catch {
    return null;
  }
}

/**
 * Find the first existing (and, on POSIX, executable) hook among `names`.
 * @param {string} repoPath - repository path.
 * @param {readonly string[]} names - hook file names.
 * @param {{ ctx?: unknown, timeoutMs?: number }} [options] - transport options.
 * @returns {Promise<string | null>} the hook name, or null when none is installed.
 */
export async function findInstalledHook(repoPath, names, options = {}) {
  const directory = await hooksDirectory(repoPath, options);
  if (directory === null) return null;
  for (const name of names) {
    try {
      const info = await stat(join(directory, name));
      if (!info.isFile()) continue;
      // Git ignores hooks without the executable bit; Windows has no bit.
      if (process.platform !== 'win32' && (info.mode & 0o111) === 0) continue;
      return name;
    } catch {
      // Missing hook: keep looking.
    }
  }
  return null;
}
