# dsh-git — 实现契约（Lead 维护，只读）

本文件是 Host 半与 Client 半之间的唯一接口约定。任何一方都**不得**擅自改名、改形状。
两侧只通过 `POST /api/dsh-git` 通信；没有共享代码，没有跨侧 import。

包根目录：`/Users/bearllflee/Documents/deepseek-harness/default-workspace/dsh-git/`

## 0. 文件归属（写入范围，互不越界）

| 路径 | 归属 |
| --- | --- |
| `index.js`, `git/*.js`, `test/host-*.test.mjs`, `test/smoke.mjs` | **host-git** |
| `client.js`, `locale/zh.json`, `locale/en.json`, `icon.svg`, `test/client-*.test.mjs` | **client-git** |
| `package.json`, `cordis.patch.yml`, `README.md`, `CONTRACT.md` | Lead |

禁止修改彼此的文件；需要改契约时向 Lead 提出。

## 1. 硬性技术约束

- **禁止任何第三方 import**。Host 只用 `node:*` 内置模块；Client 只用 `require('react')` 与宿主提供的 `ctx`。插件以 `link:` 方式装进 profile，模块解析到不了 profile 的 `node_modules`，任何外部包都会在加载时抛错。
- Host 半是普通 Node ESM，导出 `name` / `inject` / `apply`（`Config` 不导出，见 §2）。
- Client 半是单文件 `window.__ModuleLoader__.load({...})`，返回 `{ name, inject, apply }`。
- 不要跑 `pnpm`、不要写 profile 目录、不要执行 `plugin_manager`（安装由 Lead 做）。
- 只用 `--dsw-alias-*` 设计 token 上色；禁止硬编码品牌色/圆角体系外的值。
- 所有可见文案走 locale，禁止裸中文字符串出现在 JSX 里。
- 不要 `as any`、不要 `// TODO` 占位、不要空实现。

## 2. Host 半：入口形状（已验证）

```js
// index.js
export const name = 'dsh-git';
export const inject = ['connection'];
export function apply(ctx, rawConfig) { /* ... */ }
```

- **不导出 `Config`**（避免 `@deepseek-ai/schemastery` 依赖）。配置以纯对象处理，字段见 §4，缺省值在 `git/config.js` 里补齐并做范围钳制。
- 路由注册（照抄 session-delete 已验证写法）：

```js
ctx.inject(['connection'], (scope) => {
  const connection = scope.get('connection');
  const register = connection?.fetch?.register?.bind(connection.fetch);
  scope.effect(
    () => register({ path: '/api/dsh-git', methods: ['POST'], requestBody: 'buffered', fetch: (request) => handle(ctx, request) }),
    'dsh-git: /api/dsh-git',
  );
});
```

- handler：`const body = await request.json()`；返回 `new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })`。业务错误也用 200 + `{ok:false}`（客户端只看 `ok`）。**任何异常都必须被捕获并转成 `{ok:false,error}`，绝不能让路由抛 500。**
- 其它服务按需 `ctx.get('subprocess')` / `ctx.get('sessions')`，必须判空并降级。

## 3. Host 半：git 执行器

- 首选 `ctx.subprocess.spawn(spec)`（argv 直传，不经 shell）：

```js
const handle = subprocess.spawn({
  argv: ['git', '-C', repoPath, '--no-pager', '-c', 'core.quotepath=false', ...args],
  cwd: repoPath,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
  graceMs: 2000,
  signal: controller.signal,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'en_US.UTF-8' },
});
```

读取输出：等 `handle.done` 后 `handle.collected.stdout.readFrom(0)` / `handle.collected.stderr.readFrom(0)`，取 `.text` 与 `.lossy`。超时用 `AbortController` + `graceMs`，到期 `handle.terminate()` 并映射为 `E_TIMEOUT`。
- 降级：`ctx.subprocess` 不存在时用 `ctx.get('shell')`，把 argv 逐项 POSIX 单引号转义后拼成 `command`，并传 `workdir: repoPath`、`env`。两条路径必须共用同一个 `runGit(repoPath, args, opts)` 签名与同一套错误映射。
- 错误映射（写进 `git/exec.js` 的 `classifyGitFailure`）：错误码清单以 `git/util.js` 的 `ERROR_CODES` 为唯一真源，客户端 `KNOWN_CODES` 与 `locale/*.json` 的 `error.<code>` 必须与之一致（`test/host-failures.test.mjs` 断言）。匹配顺序自上而下、命中即停：
  `E_NOT_REPO`（not a git repository）→ `E_BARE_REPO`（must be run in a work tree）→ `E_AUTH_REQUIRED`（could not read username/password、authentication failed、permission denied (publickey)、terminal prompts disabled）→ `E_LOCKED`（index.lock、unable to create、another git process）→ `E_HOOK_FAILED`（pre-commit/pre-push hook、hook exited with code、husky、lint-staged）→ `E_BRANCH_IN_USE`（used by worktree、already checked out）→ `E_BRANCH_NOT_MERGED`（not fully merged）→ `E_NOTHING_TO_COMMIT`（nothing to commit/amend）→ `E_DIRTY_TREE`（would be overwritten by checkout/merge/rebase、please commit your changes or stash）→ `E_REJECTED`（[rejected]、non-fast-forward、fetch first）→ `E_DIVERGED`（not possible to fast-forward、have diverged）→ `E_UPSTREAM_MISMATCH`（the upstream branch of your current branch does not match）→ `E_NO_UPSTREAM`（has no upstream branch、no tracking information）→ `E_NO_REMOTE`（no configured push destination、does not appear to be a git repository、no remote）→ `E_ALREADY_EXISTS`（already exists）→ `E_NOT_FOUND`（no branch named、pathspec did not match、unknown/bad revision、ambiguous argument、not found、does not exist、no such remote、is not a valid reference）→ `E_CONFLICT`（automatic merge failed、unmerged files、needs merge）→ 兜底 `E_GIT_FAILED`。
  两条实现约束：① **stdout 也参与匹配**——`git commit` 把 "nothing to commit" 写 stdout，`detail` 取 stderr 末 4KB、为空时退回 stdout 末 4KB；② 匹配前先剔除 `hint:` 行，否则 `branch.setUpstream` 的提示文案（"a branch that already exists"）会把错误码误判成 `E_ALREADY_EXISTS`。`message` 用英文短句（客户端按 `code` 本地化）。`detail` 是**给读者看的**，因此构造时先清洗：剔除 `hint:` 建议行、去掉行首 `error:` / `fatal:` 前缀、去重、截到 2048 字符——git 一次拒绝会同时给出 `error:` 句、`hint:` 建议，加上 Host 自己的 `message`，不去重就是同一句英文出现三遍。客户端把 `detail` 放在折叠的「原始输出」里，另按错误码给一行中文建议（`error.<code>.hint`）。
- `push` 的目标分支参数 `to`：`'same'` → `git push <remote> HEAD`（推到远程同名分支），`'upstream'` → `git push <remote> HEAD:<upstreamBranch>`（推到当前跟踪的上游）。两者都**不改上游配置**，只影响这一次推送；省略 `to` 且上游名与分支名不同则回 `E_UPSTREAM_MISMATCH`，交给用户选。`to` 不能与显式 `branch` 同时出现（`E_INVALID_ARG`）。
- 前置校验（在调用 git 之前拦下，比解析 stderr 更准，且能给出可执行建议）：`commit` 空索引 → `E_NOTHING_TO_COMMIT`（detail 形如 `0 staged, 1 modified, 2 untracked`；`amend`/`allowEmpty` 时跳过）；`branch.delete` 目标为当前分支 → `E_BRANCH_CURRENT`、被其他 worktree 检出 → `E_BRANCH_IN_USE`（detail 为占用路径）；git 以 "not fully merged" 拒绝时（仅在未带 `force` 时）补算 `git rev-list --count HEAD..<branch>` 与 `git log --format=%h %s --max-count=3`，detail 固定形如 `3 commit(s) are not merged into HEAD: abc1234 msg, def5678 msg`（客户端用这条固定句式把提交列表翻成中文建议）；`branch.checkout` 目标被其他 worktree 检出 → `E_BRANCH_IN_USE`；`push` 无 remote → `E_NO_REMOTE`、无上游且未指定 remote → `E_NO_UPSTREAM`、上游分支名与当前分支名不同（`push.default=simple` 会拒绝）→ `E_UPSTREAM_MISMATCH`（detail 形如 `local branch "dev_1.5.10-voice-dingyuanguang" tracks "origin/main"`，客户端据此弹「推到同名分支 / 推到上游分支」选择）；`conflict.resolve` 目标不在冲突列表 → `E_INVALID_ARG`；`log` 显式传 `ref` 且无法解析 → `E_NOT_FOUND`（只有默认 HEAD 的 unborn 分支才返回空历史）。
- hook 兜底：`commit` / `push` 收到 `E_GIT_FAILED` 时，用 `git/hooks.js` 的 `findInstalledHook()`（`git rev-parse --git-path hooks`，遵循 `core.hooksPath`，POSIX 下要求可执行位）检查该阶段是否有钩子，有则改报 `E_HOOK_FAILED`——钩子通常只打印自己的输出，git 的 stderr 里根本没有 "hook" 字样。

## 4. Host 半：请求/响应契约

请求体：`{ action: string, sessionId?: string, repo?: string, ...params }`
响应体：`{ ok: true, value: <T> }` 或 `{ ok: false, error: { code: string, message: string, detail?: string } }`

`repo` 一律是绝对路径。Host 必须校验：绝对路径、存在、`.git` 存在（目录或文件）、解析后不含 `..` 越界。不合法 → `E_NOT_REPO`。
`sessionId` 用于取 `sessions.get(sessionId)?.header?.cwd` 作为默认扫描根与默认 repo（可为空）。

### 4.1 动作表（唯一白名单，`git/actions.js` 里 `switch (action)`）

| action | params | value |
| --- | --- | --- |
| `config.get` | — | `{ config }`（Host 合并后的有效配置） |
| `repos.list` | `extraRoots?: string[]` | `{ repos: RepoInfo[], roots: string[], truncated: boolean, workspaceRoots: string[], scopedToWorkspace: boolean, suggestedRoots?: { path: string, count: number }[] }` |
| `repo.init` | `path: string` | `{ repo: RepoInfo }` |
| `repo.info` | `repo` | `RepoInfo` |
| `status` | `repo` | `Status` |
| `diff` | `repo`, `path?: string`, `staged?: boolean`, `rev?: string`（该提交**自身**的改动）, `context?: number`, `ignoreWhitespace?: boolean` | `{ files: DiffFile[], text: string, truncated: boolean }` |
| `log` | `repo`, `limit?: number`, `skip?: number`, `path?: string`, `ref?: string` | `{ commits: CommitInfo[], hasMore: boolean }` |
| `show` | `repo`, `rev: string` | `{ commit: CommitInfo, body: string, files: DiffFile[], text: string, truncated: boolean }` |
| `stage` | `repo`, `paths: string[]` | `{ status: Status }` |
| `unstage` | `repo`, `paths: string[]` | `{ status: Status }` |
| `discard` | `repo`, `paths: string[]`, `confirm: true` | `{ status: Status }` |
| `stageAll` / `unstageAll` | `repo` | `{ status: Status }` |
| `commit` | `repo`, `message: string`, `amend?: boolean`, `signoff?: boolean`, `allowEmpty?: boolean` | `{ hash: string, subject: string }` |
| `branches.list` | `repo`, `includeRemote?: boolean` | `{ current: string \| null, branches: BranchInfo[] }` |
| `branch.create` | `repo`, `name`, `startPoint?`, `checkout?: boolean` | `{ status: Status }` |
| `branch.checkout` | `repo`, `name` | `{ status: Status }` |
| `branch.rename` | `repo`, `from`, `to` | `{ status: Status }` |
| `branch.delete` | `repo`, `name`, `force?: boolean`, `confirm?: boolean` | `{ status: Status }` |
| `branch.setUpstream` | `repo`, `branch`, `upstream` | `{}` |
| `fetch` | `repo`, `remote?`, `prune?: boolean` | `{ output: string }` |
| `pull` | `repo`, `remote?`, `branch?` | `{ output: string, status: Status }` |
| `push` | `repo`, `remote?`, `branch?`, `setUpstream?: boolean`, `force?: 'none' \| 'with-lease'`, `confirm?: boolean` | `{ output: string }` |
| `remote.list` | `repo` | `{ remotes: { name, fetchUrl, pushUrl }[] }` |
| `remote.add` | `repo`, `name`, `url` | `{}` |
| `remote.remove` | `repo`, `name` | `{}` |
| `remote.setUrl` | `repo`, `name`, `url`, `push?: boolean` | `{}` |
| `stash.list` | `repo` | `{ entries: StashEntry[] }` |
| `stash.push` | `repo`, `message?`, `includeUntracked?` | `{ status: Status }` |
| `stash.apply` / `stash.pop` / `stash.drop` | `repo`, `index: number` | `{ status: Status }` |
| `tag.list` | `repo` | `{ tags: TagInfo[] }` |
| `tag.create` | `repo`, `name`, `message?`, `rev?` | `{}` |
| `tag.delete` | `repo`, `name` | `{}` |
| `tag.push` | `repo`, `name`, `remote?` | `{ output: string }` |
| `conflict.resolve` | `repo`, `path`, `side: 'ours' \| 'theirs'` | `{ status: Status }` |
| `operation.continue` / `operation.abort` / `operation.skip` | `repo` | `{ status: Status }` |
| `submodule.list` | `repo` | `{ submodules: { path, sha, state }[] }` |
| `submodule.update` | `repo` | `{ output: string }` |
| `raw` | `repo`, `command: string`, `confirm?: true` | `{ stdout: string, stderr: string, exitCode: number }` |

`raw`：客户端传用户输入的整行（如 `git log --oneline -5`）。Host 做词法切分（支持 `"` `'` 转义），断言首词为 `git`，去掉后作为 argv 追加到固定前缀执行；**绝不经 shell**。拒绝空命令，也拒绝 `--git-dir` / `--work-tree` / `--namespace` / `--exec-path` / `-C`（防止逃出当前仓库）。**破坏性命令必须带 `confirm: true`**：`git/exec.js` 的 `DESTRUCTIVE_RAW_PATTERNS`（force push、`push +refspec`、`reset --hard`、`clean -f`、`branch -D`、`update-ref -d`、`filter-branch`/`filter-repo`、`reflog expire`、`gc --prune`、`worktree remove --force`、`stash drop|clear`）命中且未确认 → `E_INVALID_ARG`；客户端 `client.js` 内嵌同一份 pattern 源串，执行前弹确认框，`test/host-failures.test.mjs` 断言两边一致。

### 4.2 数据结构

```ts
type RepoInfo = {
  path: string; name: string; displayName: string;
  kind: 'repo' | 'worktree' | 'bare';
  branch: string | null; detached: boolean; unborn: boolean;
  head: string | null; ahead: number; behind: number;
  changed: number; error?: string;
};
type FileEntry = {
  path: string; origPath?: string | null;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';
  staged: boolean; score?: number;
  conflict?: 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU';
};
type Status = {
  repo: string; branch: string | null; upstream: string | null;
  ahead: number; behind: number; head: string | null;
  detached: boolean; unborn: boolean;
  operation: { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'; detail?: string } | null;
  staged: FileEntry[]; changed: FileEntry[]; untracked: FileEntry[]; conflicted: FileEntry[];
  stashCount: number;
};
type DiffFile = { path: string; oldPath: string | null; status: 'A' | 'M' | 'D' | 'R'; binary: boolean; added: number; removed: number; header: string };
type CommitInfo = { hash: string; shortHash: string; parents: string[]; author: string; authorEmail: string; date: string; subject: string; refs: string[] };
type BranchInfo = { name: string; fullName: string; remote: boolean; current: boolean; upstream: string | null; ahead: number; behind: number; lastCommit: { hash: string; subject: string; date: string; author: string } | null };
type StashEntry = { index: number; ref: string; message: string; date: string };
type TagInfo = { name: string; hash: string; date: string; message: string; annotated: boolean };
```

### 差异语义（`diff`）

- 无 `rev`：工作区差异；`staged: true` 时是索引与 `HEAD` 的差异；单路径未跟踪文件走 `git diff --no-index /dev/null <path>`。
- 有 `rev`：**该提交自身的改动**，命令是 `git show --format= -m --first-parent <rev> -- <path>`，即与第一父提交比较。不能用 `git diff <rev> -- <path>`——那是「提交 vs 工作区」，一个由该提交新增、之后没人动过的文件会得到空补丁，提交详情里就会显示「没有差异」。
- 合并提交按第一父提交展示；根提交与空树比较，正常输出 `new file mode`。
- `DiffFile.status` 由补丁头推导（`new file mode` → `A`、`deleted file mode` → `D`、`rename from` → `R`，其余 `M`），补丁本身不含 porcelain 状态码；客户端文件行直接用它上色，否则提交详情里每个文件都会显示成未跟踪的 `?`。

解析来源固定：
- `status`：`git status --porcelain=v2 -z --branch --untracked-files=all --ignored=no`。`-z` 下字段以 `\0` 分隔，`1`/`2`/`u`/`?`/`!` 前缀，`2` 后跟 origPath。
- `log`：`git log --format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00` + `-n`/`--skip`。
- `branches.list`：`git for-each-ref --format='%(refname:short)%00%(refname)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00%(contents:subject)%00%(committerdate:iso-strict)%00%(authorname)' refs/heads refs/remotes`。
- 操作态（merge/rebase/…）：检查 `.git/MERGE_HEAD`、`rebase-merge`/`rebase-apply`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`BISECT_LOG`（worktree 用 `git rev-parse --git-dir` 定位）。
- `ahead/behind`：优先用 porcelain v2 的 `# branch.ab +N -M`，无 upstream 时为 0。

### 4.3 发现算法

扫描以**当前打开的工作区为准**（`sessionCwd` = `sessions.get(sessionId).header.cwd`），分两阶段：

1. **主扫描** = `[sessionCwd]`，下钻到 `config.scanDepth`，且**穿过命中的仓库继续下钻**（`descendIntoRepositories: true`）。这样「工作区本身是一个仓库、十几个仓库嵌在它下面」的布局也能全部扫出来。主扫描扫到 ≥1 个仓库时，返回 `scopedToWorkspace: true`，结果只含这个工作区里的仓库。
2. **补充扫描** = `config.roots + extraRoots`（永远参与）；仅当主扫描一个仓库都没有时，再加上「已注册工作区路径」与其同级目录（`siblingRoots`），保证会话开在空目录时面板不空。
2. **浅根** = 每个已注册工作区路径的父目录（`siblingRoots()`），只下钻 2 层（`SHALLOW_ROOT_DEPTH`），用于发现工作区旁边的同级仓库（对齐 VSCode 的 `subFolders` 行为）；父目录等于 `$HOME`、`/` 或本身是工作区时跳过。
3. 已注册工作区路径来自 Host `workspaceRegistry.list()?.map(w => w.path)`；拿不到该服务时视为空数组，不影响其它根。

一个仓库都没发现时，返回 `suggestedRoots`：在 `$HOME` 下探测 `workspace/workspaces/projects/code/dev/src/repos/git/Documents/Desktop`（深度 2，缓存 60s），只回确实含仓库的目录及其仓库数，供客户端空状态一键加入扫描根。广度优先，深度 ≤ `config.scanDepth`；主扫描命中含 `.git` 的目录即收录**并继续下钻**，补充扫描命中即收录并停止下钻；跳过 `node_modules`、`dist`、`build`、`target`、`vendor`、`.venv`、`__pycache__`、`.next`、`.cache`、`.git`、`Library`、`.Trash`。上限 200 个仓库（超出置 `truncated: true`）、5000 个目录（`MAX_SCANNED_DIRECTORIES`，防止穿过大仓库时扫爆）。缓存 10s（按 roots+depth+descend 作 key），写操作后失效。`config.autoRepositoryDetection === 'false'` 时只返回 `extraRoots` 命中的仓库。

`RepoInfo.changed` 用一次 `git status --porcelain=v2 -z` 统计变更文件数（失败则 `error` 填短信息、`changed=0`，不整体失败）。

### 4.4 并发与安全

- 每个 repo 路径一把异步互斥锁（`Map<string, Promise>` 链），写类动作串行；读类动作最多并行 2 个。
- 破坏性动作（`discard`、`branch.delete` + `force`、`push` + `force`）必须带 `confirm: true`，否则 `E_INVALID_ARG`。
- `paths` 每项必须是仓库内相对路径，且不含 `..`；用 `--` 分隔传给 git。
- 校验 ref/分支/tag 名：`git check-ref-format --branch <name>` 通过才算合法（禁止 `--upload-pack=` 之类注入）。

## 5. Client 半：注册三处 UI（逐字依据已验证产物）

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-git',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ...组件...
    return {
      name: '@local/dsh-git',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(ctx);                       // locale.register('dsh-git', {zh, en}) 之后用
        // 1) 右侧栏标签 + 「开始」页入口卡
        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.sidebarRightTabs;
          if (!tabs || typeof tabs.register !== 'function') return;
          scope.effect(() => tabs.register({
            id: 'dsh-git',
            kind: 'dsh-git',
            title: () => t('tab.title'),
            guide: [{ order: 30, title: () => t('guide.title'), description: () => t('guide.description'), icon: GitIcon }],
          }), 'dsh-git: sidebar tab');
          scope.effect(() => scope.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-git' }, GitPanel), 'dsh-git: pane body');
          scope.effect(() => scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'dsh-git' }, GitTabTitle), 'dsh-git: pane title');
        });
        // 2) 会话头部右上角图标
        ctx.effect(() => ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'dsh-git', order: 10, label: () => t('header.button') },
          GitHeaderButton,
        ), 'dsh-git: header button');
      },
    };
  },
});
```

打开标签：
```js
function openGit(ctx) {
  const sb = ctx.get('sidebarRight');
  if (sb && typeof sb.openTab === 'function') { sb.openTab('dsh-git'); return true; }
  try { ctx.get('layout')?.openRightbar?.(); return true; } catch { return false; }
}
```

- 头部按钮组件收到的 props 里至少有 `sessionId`，可能还有 `useSession`/`useConversation`；**只用 `sessionId`，其余不要依赖**。组件必须能在 props 为空时不崩（`sessionId` 缺失时用 `undefined` 请求）。
- 面板组件同样只依赖 `sessionId`；不要假设 `host`/`useSession` 一定存在。
- 标签标题组件渲染「Git」小图标 + 文本，宽度自适应。

## 6. Client 半：请求封装

```js
async function call(action, params) {
  const res = await fetch('/api/dsh-git', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await res.json();
  if (!data.ok) { const e = new Error(data.error?.message || 'request failed'); e.code = data.error?.code; e.detail = data.error?.detail; throw e; }
  return data.value;
}
```
同源相对路径即可，鉴权由 connection 负责。所有调用都要 `try/catch`，错误展示为内联条（含 `code` 本地化文案 + `detail` 原文 + 复制按钮）。

## 7. Client 半：UI 结构（必须实现）

面板（宽度自适应 320–440px，纵向滚动，仅用 `--dsw-alias-*`）：

1. **顶栏**：仓库下拉（`<select>` 或自绘列表；多仓库时显示 `displayName` + 分支 + 变更数）、刷新按钮、同步三连（fetch / pull / push，带 `↑n ↓m` 徽标）、设置按钮。
2. **操作横幅**（`status.operation` 非空时）：`合并中`/`变基中`/`拣选中`/`回滚中` + `继续`/`跳过`/`中止`。
3. **变更分组**（每组可折叠，折叠态存 `localStorage['dsh-git:collapsed']`）：`冲突` → `已暂存的更改` → `更改` → `未跟踪`。行：状态字母（M/A/D/R/C/U/?）+ 文件名（`R` 显示 `old → new`）+ hover 动作（暂存 / 取消暂存 / 丢弃）。点击行打开 diff 子视图。
4. **提交区**：`textarea`（placeholder「消息（⌘Enter 提交）」）、主按钮 `提交` + 下拉（`提交并推送`、`提交并同步`、`修正上次提交`、`全部暂存并提交`）。无暂存内容时主按钮禁用。
5. **折叠区**：`分支`（当前分支 + 上游 + ahead/behind；列表可搜索；切换/新建/重命名/删除/设上游）、`历史`（默认 30 条，滚动加载更多；点开提交 → 详情：作者/时间/完整消息/文件列表，点文件看 diff）、`贮藏`、`标签`、`远程`、`子模块`、`运行 Git 命令`（输入行 + 执行 + 输出区，等宽字体，保留 stderr）。
6. **diff 子视图**：返回按钮、文件路径 + `+a -b`、等宽行渲染，`+` 行绿底、`-` 行红底、`@@` 行淡底；`binary` 或 `truncated` 显示提示；顶部可 `暂存此文件`。
7. **空状态**（无仓库）：图标 + 「未发现 Git 仓库」+ `初始化仓库`（调 `repo.init`，path 用会话 cwd）/ `添加仓库`（输入绝对路径，存 `localStorage['dsh-git:extraRoots']`）/ `打开设置`。
8. **设置浮层**：`扫描深度`（1–10，默认 5）、`扫描根目录`（多行绝对路径，逗号或换行分隔）、`自动发现`（true/false/subFolders）、`拉取策略`（merge/rebase/ff-only）。全部存 `localStorage['dsh-git:settings']` 并随请求下发。

刷新：面板可见且 `document.visibilityState === 'visible'` 时按 3s 轮询 `status`；任何写操作成功后立即重取；切换仓库、切换标签、窗口聚焦时也重取。轮询用 `setInterval`，卸载时清理。

快捷键：`⌘/Ctrl+Enter` 提交；`⌘/Ctrl+R`（面板内）刷新并阻止默认。

## 8. Client 半：i18n

`ctx.locale.register('dsh-git', { zh, en })`，`zh` 为中文（默认语言），`en` 为英文。取词：优先 `ctx.locale.bind('dsh-git')` 或 `ctx.locale.getLocale()` 判断，退化时用 zh。必须存在的 key：

```
tab.title, guide.title, guide.description, header.button,
repo.none, repo.add, repo.init, repo.refresh, repo.settings,
status.staged, status.changes, status.untracked, status.conflicts, status.clean,
action.stage, action.unstage, action.discard, action.openDiff, action.commit, action.commitPush,
action.commitSync, action.amend, action.stageAllCommit,
branch.title, branch.current, branch.create, branch.rename, branch.delete, branch.checkout, branch.upstream,
history.title, history.loadMore, history.empty,
stash.title, tag.title, remote.title, submodule.title, raw.title, raw.run, raw.placeholder,
operation.merge, operation.rebase, operation.cherryPick, operation.revert, operation.bisect,
operation.continue, operation.skip, operation.abort,
error.E_NOT_REPO, error.E_NO_GIT, error.E_TIMEOUT, error.E_AUTH_REQUIRED, error.E_LOCKED, error.E_CONFLICT, error.E_INVALID_ARG, error.E_GIT_FAILED, error.E_UNSUPPORTED, error.E_INTERNAL,
error.E_BARE_REPO, error.E_HOOK_FAILED, error.E_NOTHING_TO_COMMIT, error.E_BRANCH_CURRENT, error.E_BRANCH_IN_USE, error.E_BRANCH_NOT_MERGED, error.E_DIRTY_TREE, error.E_ALREADY_EXISTS, error.E_NOT_FOUND, error.E_NO_UPSTREAM, error.E_UPSTREAM_MISMATCH, error.E_NO_REMOTE, error.E_REJECTED, error.E_DIVERGED,
confirm.discard, confirm.deleteBranch, confirm.rawDanger, confirm.forcePush, common.cancel, common.confirm, common.copy, common.close, common.loading, common.empty
```

## 9. 验收命令（Lead 执行，双方可自测）

```bash
cd /Users/bearllflee/Documents/deepseek-harness/default-workspace/dsh-git
node --test test/                      # 纯函数单测
node test/smoke.mjs                    # 对 ~/workspace/InSight 只读冒烟
node --check index.js                  # Host 语法
node --input-type=module -e "import('./client.js')"  # Client 语法（会因 window 缺失失败，用 --check 代替）
node --check client.js
```

单测至少要覆盖：porcelain v2 解析（普通/重命名/冲突/未跟踪/中文与空格路径/未出生分支）、`parseRefTrack`（`[ahead 2, behind 1]`）、argv 组装与 `shellQuote`、ref 校验拒绝 `--upload-pack=`、发现算法（临时 fixture 目录，含嵌套仓库/跳过目录/深度限制/去重）。
