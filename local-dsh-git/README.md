# dsh-git

DeepSeekRuntime 的 **Git 源代码管理插件**，交互对齐 VSCode 的 Source Control：多仓库发现、右侧栏标签、提交、分支、历史、diff 与远端同步。

## 它长在哪里

| 位置 | 说明 |
| --- | --- |
| 会话标题行右上角 | Git 图标（带未提交变更数角标），与模型选择器、`···`、右栏按钮同排 |
| 右侧栏 | 点击图标后新增「Git」标签，与「文件」等标签并列，互不影响 |
| 右侧栏「开始」页 | 新增「源代码管理」入口卡片 |

## 功能

- **多仓库**：以**当前打开的工作区为准**递归扫描——工作区本身是仓库、十几个仓库嵌在它下面也能全部列出（穿过仓库继续下钻）；会话开在空目录时才回退到已打开的 DSH 工作区、各工作区的同级目录、自定义扫描根目录 + 手动添加；扫描深度可配（默认 5，对齐 VSCode 的 `git.repositoryScanMaxDepth`）；自动发现策略对齐 `git.autoRepositoryDetection`（`true` / `false` / `subFolders`）。一个仓库都没扫到时，空状态会列出主目录下确实含仓库的目录，一键加入扫描根
- **变更**：已暂存 / 更改 / 未跟踪 / 冲突 四组，逐文件暂存、取消暂存、丢弃；点击看统一 diff
- **提交**：多行消息、⌘/Ctrl+Enter、修正上次提交（amend）、全部暂存并提交、提交并推送 / 提交并同步
- **分支**：列出本地与远端分支（含 upstream、ahead/behind）、切换、新建、重命名、删除、设置上游
- **历史**：分页 log，提交详情（作者/时间/完整消息/文件列表），单文件 diff
- **同步**：fetch / pull / push，支持 `--set-upstream`、`--force-with-lease`（需二次确认）
- **其它**：贮藏（list/push/apply/pop/drop）、标签、远程（增删改）、子模块、冲突取 ours/theirs、合并/变基/拣选的继续与中止
- **逃生口**：面板内「运行 Git 命令」可执行任意 `git` 子命令（argv 直传，不经 shell）

## 安装

插件以本地目录（`link:`）方式安装到当前 profile。先克隆仓库，再把插件目录的**绝对路径**交给 `plugin_manager`：

```bash
git clone git@github.com:bearllfleed/MyDshPlugins.git
# 然后让 DeepSeekRuntime 里的 agent 执行：
# plugin_manager install_bundle target=<克隆路径>/MyDshPlugins/local-dsh-git
```

也可以只装打包好的 tgz（`npm pack` 产物，无需克隆）：

```bash
plugin_manager install_bundle target=<绝对路径>/local-dsh-git-0.1.7.tgz
```

安装后**刷新页面**即可看到图标。修改 `client.js` 后刷新页面生效；修改 `index.js`（Host 半）后需重载插件：

```
plugin_manager set_plugin target="include:dsh-git" enabled=false
plugin_manager set_plugin target="include:dsh-git" enabled=true
```

卸载：

```
plugin_manager remove_bundle target="@local/dsh-git"
```

## 设置

面板右上角齿轮打开设置，保存在浏览器 `localStorage`（键 `dsh-git:settings`）：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 扫描深度 | 5 | 相对扫描根目录的最大下钻层数（1–10） |
| 扫描根目录 | 空 | 额外的绝对路径，每行一个。留空也会自动扫描当前打开的工作区（穿过其中的仓库继续下钻） |
| 自动发现 | subFolders | `false` 时只显示手动添加的仓库 |
| 拉取策略 | merge | `merge` / `rebase` / `ff-only` |
| 刷新间隔 | 3000ms | 面板可见时的状态轮询 |

手动添加的仓库存在 `localStorage['dsh-git:extraRoots']`，每次请求由 Host 重新校验。

## 安全与权限

- 插件**不注册任何模型侧工具**：所有操作都由用户在界面上点击触发，因此不扩大 agent 的沙箱权限面。
- git 以 **argv 数组**方式启动（`ctx.subprocess.spawn`），不经过 shell；用户输入只作为独立参数传递，`raw` 命令会先做词法切分并断言首词为 `git`。
- 破坏性操作（丢弃更改、强制删除分支、force push）要求二次确认，并显示完整命令与仓库路径；「运行 Git 命令」这个逃生口同样受约束——Host 会拒绝 `push --force`、`reset --hard`、`clean -f`、`branch -D`、`filter-branch`、`stash drop` 等改写历史/丢弃改动的命令，除非请求带上 `confirm: true`，客户端在执行前会弹出确认框。
- 凭据：`GIT_TERMINAL_PROMPT=0`，私有仓库缺凭据时会快速失败并提示先在终端完成一次认证，不会卡住界面。
- 仓库路径必须通过 Host 校验（绝对路径、真实存在、含 `.git`、无 `..` 越界）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 看不到图标 | 刷新页面；`plugin_manager list_plugins` 确认 `@local/dsh-git` 已启用 |
| 标签打不开 | 确认 `@deepseek-ai/dsh-client-ui-sidebar-right` 在 profile 中（本插件依赖它的 `sidebarRightTabs`） |
| 列表里没有我的仓库 | 先在空状态里点建议的目录（主目录下含仓库的文件夹）；仍没有就打开设置填「扫描根目录」，或用「添加仓库」填绝对路径 |
| 提示未找到 git | 安装 git 并确保 `git` 在 PATH 中 |
| 提示 index.lock | 另一个 git 进程在跑；关闭后重试，必要时手动删除 `.git/index.lock` |
| fetch/push 失败 E_AUTH_REQUIRED | 先在终端对同一远端完成一次认证（HTTPS token 或 SSH key） |
| 删分支提示「这是当前检出的分支」 | 该分支正被当前工作区检出，先切到别的分支再删 |
| 删分支提示「分支正在其他工作区检出」 | 该分支被另一个 worktree 占用，错误详情里有占用路径 |
| 提交提示「没有可提交的改动」 | 暂存区是空的，先勾选文件；确实要空提交就用「空提交」 |
| 提交/推送提示「Git 钩子拒绝了这次操作」 | pre-commit/pre-push 钩子（husky、lint-staged 等）失败，错误详情里是钩子的原始输出，先在终端修好再提交 |
| 推送提示「远程拒绝了推送」/「本地与远程已分叉」 | 先 fetch，必要时 pull 后再推；分叉时不要 force push |
| 拉取提示「本地改动会被覆盖」 | 先提交或贮藏本地改动 |

## 错误提示

界面上的失败提示由三段组成：**本地化标题**（错误码）+ **一行中文建议**（`error.<code>.hint`，告诉下一步做什么）+ **折叠的「原始输出」**（git 的真实输出，去掉 `hint:` 建议行与重复句，便于排查）。所以不会再出现「中文标题 + 三行英文报错」的情况——git 的 `error:` 句、`hint:` 建议和 Host 自己的英文 message 本来会把同一件事说三遍。错误码覆盖了 git 常见的拒绝原因，不再统一显示 `git exited with code 1`：

`E_NOT_REPO` `E_NO_GIT` `E_TIMEOUT` `E_AUTH_REQUIRED` `E_LOCKED` `E_CONFLICT` `E_INVALID_ARG` `E_UNSUPPORTED` `E_INTERNAL` `E_GIT_FAILED` `E_BARE_REPO` `E_HOOK_FAILED` `E_NOTHING_TO_COMMIT` `E_BRANCH_CURRENT` `E_BRANCH_IN_USE` `E_BRANCH_NOT_MERGED` `E_DIRTY_TREE` `E_ALREADY_EXISTS` `E_NOT_FOUND` `E_NO_UPSTREAM` `E_NO_REMOTE` `E_REJECTED` `E_DIVERGED`

其中「当前分支不能删」「暂存区为空」「没有 remote/上游」「目标不在冲突里」这些情况在调用 git **之前**就被拦下，因此提示里给出的是下一步动作，而不是 git 的英文报错。

当前分支和它跟踪的上游**不同名**时（比如本地 `dev_1.5.10-voice-dingyuanguang` 跟踪 `origin/dev_1.5.10`），git 默认拒绝推送并打印五行关于 `push.default` 的说明。现在面板直接问你「推送到哪个分支？」，两个选项都写明目标分支，选完照做，上游配置不动。

删一个还有未合并提交的分支时，提示会直接说清会丢什么（「还有 1 个提交没有合并到当前分支：331e958 wip: voice」），并**弹出「强制删除」确认框**——不再是死路一条要你自己去终端敲 `git branch -D`。

## 开发

```
dsh-git/
├── index.js          # Host 入口：路由 + 动作分发
├── git/              # 执行器、仓库发现、porcelain 解析、diff、历史、钩子、worktree
├── client.js         # Client 入口：三处 UI 注册 + 面板
├── locale/           # zh / en
├── test/             # node --test 单测 + 真实仓库只读冒烟
└── CONTRACT.md       # Host/Client 接口契约
```

```bash
node --check index.js && node --check client.js
node --test                          # 126 个测试（Host 解析/执行/发现/动作/网络 + Client 装配/字典）
node test/smoke.mjs /path/to/repo    # 对真实仓库的只读冒烟（不给参数则用当前目录）
```

没有构建步骤：没有 TypeScript、没有打包器。`client.js` 是浏览器直接执行的 ESM 包装（`window.__ModuleLoader__.load`），`index.js` 与 `git/*.js` 是普通 Node ESM。改完直接生效——Host 半要重载插件，Client 半要刷新页面。

> 本机 Node v22.23.2 下 `node --test test/`（目录作为位置参数）会报 `Cannot find module`，用裸 `node --test` 或 `node --test "test/*.test.mjs"`。
>
> 裸 `node --test` 会递归发现**所有** `*.test.mjs`：如果像验证分发包那样把 tgz 解压到了本仓库的 `dist/package/`，测试会跑两遍（数字翻倍）。解压到仓库外，或用 `node --test "test/*.test.mjs"`。

## 二次开发（在分发包基础上改）

分发包里带齐了源码、接口契约和测试，解压就能改：

```bash
tar xzf local-dsh-git-0.1.6.tgz      # 解出 package/，里面就是插件源码
cd package
node --test                          # 126 个测试全绿再动手
node test/smoke.mjs /path/to/repo    # 可选：对你自己某个真实仓库只读跑一遍
```

改完之后两种装法：

**1. 目录安装（推荐，改一次不用重打包）**

```bash
plugin_manager install_bundle target=<解压出来的 package 目录绝对路径>
```

profile 会把它记成 `link:` 依赖，源码始终在你手里。之后改 `client.js` / `git/*.js`：

- Host 半（`index.js`、`git/*.js`）→ `plugin_manager set_plugin include:dsh-git enabled=false` 再 `enabled=true` 重载；
- Client 半（`client.js`、`locale/*.json`、`icon.svg`）→ 重载后刷新页面。

**2. 打包再分发**

```bash
npm pack --pack-destination dist     # 产出新的 local-dsh-git-<version>.tgz
```

`.tgz` 安装是**拷贝**进 profile 的 `node_modules`，改那里的文件也会生效，但下次重装会被覆盖——想长期改就用上面的目录安装。

几条容易踩的：

- `locale/zh.json`、`locale/en.json` 和 `client.js` 里的内嵌字典是**三份**，必须同步；`node --test` 里有断言，不同步会红。
- 新增动作要在三处对齐：`git/actions.js` 的 switch、`CONTRACT.md` 的表格、`client.js` 的调用点。
- 新增错误码要同时改 `git/util.js` 的 `ERROR_CODES`、`client.js` 的 `KNOWN_CODES` 和两份 locale 的 `error.<code>` + `error.<code>.hint`；`test/host-failures.test.mjs` 会断言三方一致。
- 破坏性动作一律要 `confirm: true`，`raw` 命令走 `isDestructiveRaw` 判定——别绕过。

## 打包分发

```bash
npm pack --pack-destination dist
# → dist/local-dsh-git-0.1.6.tgz（28 个文件：源码 + 测试 + CONTRACT.md）
```

对方安装：`plugin_manager install_bundle target=<...>/local-dsh-git-0.1.6.tgz`，然后刷新页面。

包里刻意带了 `test/` 和 `CONTRACT.md`：拿到包的人解压后 `node --test` 就能验证 126 个测试、`node test/smoke.mjs <repo>` 能对任意仓库只读冒烟，不必先理解全部代码。想改的话见下一节。

## 已验证

- 上游分支不同名（0.1.7）：`push` 前先比对本地分支名与 `@{u}` 的短名，不同则回 `E_UPSTREAM_MISMATCH`（detail `local branch "X" tracks "origin/Y"`），面板弹出「远程同名分支 / 现有上游分支」选择；实测两条路都通——选同名分支会在远程新建 `dev_1.5.10-voice-dingyuanguang` 且 `status.upstream` 仍是 `origin/main`，选上游分支则把提交推到 `main`；`node --test` 130/130
- 分发包自包含（0.1.6）：`npm pack` 出的 28 个文件解压到空目录后 `node --test` 直接 126/126 通过、`node test/smoke.mjs <repo>` 15 probes OK，无需任何安装步骤——对方拿到包就能改、能验。
- 报错可读（0.1.5）：删除未合并分支的提示从「中文标题 + 三行英文（error:/hint:/重复句）」变成「分支尚未完全合并 + 还有 N 个提交没有合并到当前分支：<hash 主题> + 折叠的原始输出」，并直接给出「强制删除」确认框；23 个错误码各配一条中文建议；`detail` 在 Host 侧统一清洗（去 `hint:` 行、去 `error:`/`fatal:` 前缀、去重、截 2048 字符）。实测 `git branch -d dev_1.5.10-voice-dingyuanguang` 现在回 `E_BRANCH_NOT_MERGED` / detail `1 commit(s) are not merged into HEAD: 331e958 wip: voice`；`node --test` 126/126 通过
- 提交差异可读（0.1.4）：提交详情里点开某个文件，看到的是**这次提交对它的改动**（`git show -m --first-parent`），不再是「没有差异」——原来用 `git diff <rev> -- <path>`（提交 vs 工作区），提交新增后没人动过的文件必然是空补丁；文件路径改成「目录暗色 + 文件名完整」，不再把 `lesson_plan_voice_field.dart` 截成 `...voice_field.dart`；提交里的文件行状态字母由补丁头推导（`A`/`M`/`D`/`R`），不再是清一色的 `?`；提交详情底部加「查看完整差异」一次看全。实测 riceai 仓库 `2b38472`（8 个文件、2230 增）逐文件与整体均正常，`node --test` 120/120 通过
- Host 半：对 `/Users/bearllflee/workspace` 真实执行 `repos.list`（发现 7 个仓库）、`status`、`log`、`branches.list`、`diff`，以及错误路径（非仓库 → `E_NOT_REPO`）
- 失败路径全面收口（0.1.3）：逐 action 探测了 40+ 条失败路径（当前分支/worktree 占用/未合并的删除、空暂存提交、钩子拒绝、无 remote/上游的推送、分叉的 pull、重名/缺失的 branch/tag/remote/stash、bare 仓库、坏 ref、非冲突路径的 resolve），把原来统一退化成 `E_GIT_FAILED` 的情况细分为 13 个新错误码并给出中文标题；`node --test` 114/114 通过，新增 `test/host-failures.test.mjs` 9 个用例，其中一条断言 Host 错误码表与客户端字典/`KNOWN_CODES` 完全一致，防止新错误码「没有翻译就上线」
- 以工作区为准的多仓库发现（0.1.2）：把会话打开的工作区当扫描根并**穿过命中的仓库继续下钻**，所以「工作区本身是仓库、十几个仓库嵌在它下面」的布局能全部列出——实测打开 `/Users/bearllflee/workspace/riceai-devkit` 扫出 **16 个仓库**（含 ai-games、rehab-platform-riceai、riceai、riceai-admin、report-service、riceai-agent-service 等），146ms；会话开在空目录时回退到已注册工作区，实测 7 个仓库，55ms
- 多仓库自动发现（0.1.1）：用真实 `~/.dsh/storages/workspace.json` 里的工作区（InSight、riceai-devkit、default-workspace）驱动 `repos.list`，87ms 内返回 7 个仓库（InSight、riceai-devkit、AwesomeSkills、MeetingCopilot、multi-lan-evm、shadcn-admin、磨课），无需任何配置
- 单测 105/105 通过；Client 装配测试会真实执行 `client.js` 工厂与 `apply()`，断言三处 UI 注册、locale 双语对齐、头部按钮可渲染
- 真机：图标出现在会话标题行右上角，右侧栏「Git」标签可打开且不影响其它标签，「开始」页出现「源代码管理」入口
