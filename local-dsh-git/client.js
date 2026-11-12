// @ts-check
/**
 * Browser half of the dsh-git bundle.
 *
 * Renders a source-control panel in the right sidebar (repository picker, change
 * groups, commit box, branches, history, stashes, tags, remotes, submodules, raw
 * git commands and a diff view) plus a Git button in the conversation header.
 * Every side effect lives in the Host half: this file only talks to
 * `POST /api/dsh-git` and never touches the filesystem itself.
 *
 * Design rules followed here:
 * - one file, no imports besides `react` (the bundle is linked into a profile
 *   whose module resolution cannot reach third-party packages);
 * - colors come from `--dsw-alias-*` tokens only, so the panel follows the
 *   active theme;
 * - every visible string comes from the locale service (`zh` is the default);
 * - the panel survives a missing service, a missing session id and a failed
 *   request without ever going blank.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-git',
  factory(require) {
    /** @type {typeof import('react')} */
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------------
    // 1. Constants
    // ---------------------------------------------------------------------

    /** Locale namespace owned by this bundle. */
    const NS = 'dsh-git';
    /** Host route on the connection service's authenticated `/api` channel. */
    const ROUTE = '/api/dsh-git';
    /** Right-sidebar tab id, also used as the pane slot key. */
    const TAB_ID = 'dsh-git';
    /** Header utilities slot id. */
    const HEADER_ID = 'dsh-git';
    /** Status poll interval while the panel is visible. */
    const POLL_MS = 3000;
    /** Page size for the history list. */
    const LOG_PAGE = 30;
    /** Hard cap on rendered diff lines, so a huge diff cannot freeze the pane. */
    const DIFF_LINE_LIMIT = 3000;
    /** localStorage keys (all namespaced, all optional). */
    const STORE = {
      settings: 'dsh-git:settings',
      collapsed: 'dsh-git:collapsed',
      extraRoots: 'dsh-git:extraRoots',
      repo: 'dsh-git:repo',
    };

    // ---------------------------------------------------------------------
    // 2. Locale dictionaries
    // ---------------------------------------------------------------------

    const dicts = {
      zh: {
        'tab.title': 'Git',
        'tab.unavailable': 'Git 服务不可用',
        'guide.title': '源代码管理',
        'guide.description': '查看仓库状态、提交变更、管理分支与历史。',
        'header.button': 'Git',
        'repo.none': '未发现 Git 仓库',
        'repo.noneSelected': '未选择仓库',
        'repo.add': '添加仓库',
        'repo.init': '初始化仓库',
        'repo.refresh': '刷新',
        'repo.settings': '设置',
        'repo.fetch': '获取远程更新',
        'repo.pull': '拉取',
        'repo.push': '推送',
        'repo.detached': '分离 HEAD',
        'repo.unborn': '尚无提交',
        'repo.upstreamNone': '未设置上游',
        'repo.aheadBehind': '↑{ahead} ↓{behind}',
        'repo.stashCount': '贮藏 {n}',
        'repo.selectLabel': '仓库',
        'status.staged': '已暂存的更改',
        'status.changes': '更改',
        'status.untracked': '未跟踪',
        'status.conflicts': '冲突',
        'status.clean': '工作区干净，没有变更。',
        'status.loading': '正在读取仓库状态…',
        'action.stage': '暂存',
        'action.unstage': '取消暂存',
        'action.discard': '丢弃更改',
        'action.openDiff': '查看差异',
        'action.stageAll': '全部暂存',
        'action.unstageAll': '全部取消暂存',
        'action.commit': '提交',
        'action.commitPush': '提交并推送',
        'action.commitSync': '提交并同步',
        'action.amend': '修正上次提交',
        'action.stageAllCommit': '全部暂存并提交',
        'action.commitPlaceholder': '消息（⌘Enter 提交）',
        'action.commitMenu': '更多提交操作',
        'action.resolveOurs': '采用当前版本',
        'action.resolveTheirs': '采用合入版本',
        'action.busy': '正在执行…',
        'branch.title': '分支',
        'branch.current': '当前分支',
        'branch.create': '新建分支',
        'branch.rename': '重命名',
        'branch.delete': '删除分支',
        'branch.checkout': '切换分支',
        'branch.upstream': '设置上游',
        'branch.search': '搜索分支',
        'branch.empty': '没有分支',
        'branch.name': '分支名',
        'branch.namePlaceholder': '例如 feature/login',
        'branch.startPoint': '起点（可选）',
        'branch.renameTo': '新分支名',
        'branch.upstreamName': '上游（如 origin/main）',
        'branch.deleteForce': '强制删除（未合并也删除）',
        'history.title': '历史',
        'history.loadMore': '加载更多',
        'history.empty': '暂无提交',
        'history.detail': '提交详情',
        'history.author': '作者',
        'history.date': '时间',
        'history.parents': '父提交',
        'history.files': '变更文件',
        'history.viewAll': '查看完整差异',
        'history.hash': '哈希',
        'history.loading': '正在读取提交…',
        'stash.title': '贮藏',
        'stash.empty': '没有贮藏',
        'stash.push': '贮藏当前更改',
        'stash.apply': '应用',
        'stash.pop': '弹出',
        'stash.drop': '删除',
        'stash.message': '说明（可选）',
        'stash.includeUntracked': '包含未跟踪文件',
        'tag.title': '标签',
        'tag.empty': '没有标签',
        'tag.create': '新建标签',
        'tag.delete': '删除标签',
        'tag.push': '推送标签',
        'tag.name': '标签名',
        'tag.message': '说明（可选）',
        'tag.annotated': '附注标签',
        'remote.title': '远程',
        'remote.empty': '没有远程',
        'remote.add': '添加远程',
        'remote.remove': '移除远程',
        'remote.setUrl': '修改地址',
        'remote.name': '名称',
        'remote.url': '地址',
        'remote.fetchUrl': '获取地址',
        'remote.pushUrl': '推送地址',
        'submodule.title': '子模块',
        'submodule.empty': '没有子模块',
        'submodule.update': '更新子模块',
        'submodule.path': '路径',
        'submodule.state': '状态',
        'submodule.sha': '提交',
        'raw.title': '运行 Git 命令',
        'raw.run': '执行',
        'raw.placeholder': 'git log --oneline -5',
        'raw.hint': '只支持以 git 开头的命令，不经 shell 执行。',
        'raw.output': '输出',
        'raw.stderr': '错误输出',
        'raw.exitCode': '退出码 {code}',
        'raw.empty': '执行后会在这里显示输出。',
        'operation.merge': '合并中',
        'operation.rebase': '变基中',
        'operation.cherryPick': '拣选中',
        'operation.revert': '回滚中',
        'operation.bisect': '二分查找中',
        'operation.continue': '继续',
        'operation.skip': '跳过',
        'operation.abort': '中止',
        'operation.detail': '详情：{detail}',
        'error.title': '出错了',
        'error.unknown': '未知错误',
        'error.network': '无法连接到 Git 服务',
        'error.detail': '详情',
        'error.E_NOT_REPO': '不是一个 Git 仓库',
        'error.E_NO_GIT': '找不到 git 命令',
        'error.E_TIMEOUT': 'Git 操作超时',
        'error.E_AUTH_REQUIRED': '需要登录远程仓库',
        'error.E_LOCKED': '仓库被锁定（可能有另一个 Git 进程）',
        'error.E_CONFLICT': '存在未解决的冲突',
        'error.E_INVALID_ARG': '参数不合法',
        'error.E_GIT_FAILED': 'Git 命令执行失败',
        'error.E_BARE_REPO': '这是裸仓库，没有工作区',
        'error.E_HOOK_FAILED': 'Git 钩子拒绝了这次操作',
        'error.E_NOTHING_TO_COMMIT': '没有可提交的改动',
        'error.E_BRANCH_CURRENT': '这是当前检出的分支',
        'error.E_BRANCH_IN_USE': '分支正在其他工作区检出',
        'error.E_BRANCH_NOT_MERGED': '分支尚未完全合并',
        'error.E_DIRTY_TREE': '本地改动会被覆盖',
        'error.E_ALREADY_EXISTS': '目标已存在',
        'error.E_NOT_FOUND': '找不到目标',
        'error.E_NO_UPSTREAM': '当前分支没有上游',
        'error.E_NO_REMOTE': '没有可用的远程',
        'error.E_REJECTED': '远程拒绝了推送',
        'error.E_DIVERGED': '本地与远程已分叉',
        'error.E_NOT_REPO.hint': '这个目录不是 Git 仓库，请选择仓库根目录。',
        'error.E_NO_GIT.hint': '找不到 git 可执行文件，请确认已安装并在 PATH 中。',
        'error.E_TIMEOUT.hint': '命令超时。网络操作可能需要先在终端里完成一次认证。',
        'error.E_AUTH_REQUIRED.hint': '远端要求认证，请先在终端里用 git 认证一次。',
        'error.E_LOCKED.hint': '另一个 git 进程正占用索引，稍后重试；确认没有进程后，可删除 .git/index.lock。',
        'error.E_CONFLICT.hint': '还有未解决的冲突，解决后再继续。',
        'error.E_INVALID_ARG.hint': '参数不合法，请检查填写的内容。',
        'error.E_GIT_FAILED.hint': 'git 执行失败，展开「原始输出」查看原因。',
        'error.E_UNSUPPORTED.hint': '当前仓库或 git 版本不支持这个操作。',
        'error.E_INTERNAL.hint': '插件内部错误，可以重试一次。',
        'error.E_BARE_REPO.hint': '裸仓库没有工作区，无法执行需要工作区的操作。',
        'error.E_HOOK_FAILED.hint': '仓库的钩子（如 husky、lint-staged）拒绝了这次操作，请按原始输出修正后重试。',
        'error.E_NOTHING_TO_COMMIT.hint': '暂存区是空的，先暂存要提交的改动。',
        'error.E_BRANCH_CURRENT.hint': '这是当前检出的分支，先切到别的分支再删。',
        'error.E_BRANCH_IN_USE.hint': '该分支正在其他 worktree 中检出，先在那里切走或移除那个 worktree。',
        'error.E_BRANCH_NOT_MERGED.hint': '该分支还有未合并的提交。确认不再需要时，用「强制删除」。',
        'error.E_BRANCH_NOT_MERGED.count': '还有 {n} 个提交没有合并到当前分支：{list}',
        'error.E_DIRTY_TREE.hint': '有未提交的改动会被覆盖，请先提交或贮藏。',
        'error.E_ALREADY_EXISTS.hint': '同名目标已存在，换一个名字或先删掉旧的。',
        'error.E_NOT_FOUND.hint': '找不到目标分支、标签、提交或路径，请检查拼写。',
        'error.E_NO_UPSTREAM.hint': '当前分支没有上游分支，先设置上游再推送。',
        'error.E_UPSTREAM_MISMATCH': '上游分支和当前分支不同名',
        'error.E_UPSTREAM_MISMATCH.hint': '当前分支跟踪的上游分支名字不一样，git 默认拒绝推送。选择推到「同名分支」或「上游分支」即可。',
        'push.mismatchTitle': '推送到哪个分支？',
        'push.mismatchField': '目标分支',
        'push.toSame': '远程同名分支 {branch}',
        'push.toUpstream': '现有上游分支 {branch}',
        'push.mismatchHint': '当前分支 {branch} 跟踪的是 {upstream}，两者不同名。选「同名分支」会推到远程上同名的分支，选「上游分支」会推到你已有的上游。上游配置不会被改动。',
        'error.E_NO_REMOTE.hint': '仓库没有配置远端，先添加一个 remote。',
        'error.E_REJECTED.hint': '远端拒绝了这次推送，先拉取、处理差异后再推。',
        'error.E_DIVERGED.hint': '本地和远端各有独立提交，需要合并或变基后再推。',
        'error.raw': '原始输出',
        'error.E_UNSUPPORTED': '当前环境不支持该操作',
        'error.E_INTERNAL': '插件内部错误',
        'confirm.title': '请确认',
        'confirm.discard': '丢弃这些更改？此操作无法撤销。',
        'confirm.forceDeleteBranch': '分支「{name}」还有未合并的提交，强制删除后这些提交会从历史里消失（可用 git reflog 找回）。',
        'confirm.deleteBranch': '删除分支「{name}」？',
        'confirm.rawDanger': '这条命令会丢弃改动或改写历史，确定执行吗？\n\n{command}',
        'confirm.forcePush': '强制推送会覆盖远程历史，确定继续？',
        'confirm.deleteTag': '删除标签「{name}」？',
        'confirm.removeRemote': '移除远程「{name}」？',
        'confirm.dropStash': '删除这条贮藏？',
        'common.cancel': '取消',
        'common.confirm': '确定',
        'common.copy': '复制',
        'common.copied': '已复制',
        'common.close': '关闭',
        'common.loading': '加载中…',
        'common.empty': '暂无内容',
        'common.back': '返回',
        'common.create': '创建',
        'common.save': '保存',
        'common.remove': '移除',
        'common.apply': '应用',
        'common.retry': '重试',
        'common.search': '搜索',
        'common.none': '无',
        'common.unknown': '未知',
        'common.optional': '可选',
        'common.refresh': '刷新',
        'common.discard': '丢弃',
        'common.delete': '删除',
        'common.rename': '重命名',
        'common.checkout': '切换',
        'diff.title': '差异',
        'diff.back': '返回',
        'diff.stageFile': '暂存此文件',
        'diff.unstageFile': '取消暂存此文件',
        'diff.binary': '二进制文件，无法显示差异。',
        'diff.truncated': '差异过大，已截断。',
        'diff.empty': '没有差异。',
        'diff.loading': '正在读取差异…',
        'diff.staged': '已暂存',
        'diff.stat': '+{added} −{removed}',
        'diff.limit': '差异过长，仅显示前 {n} 行。',
        'settings.title': 'Git 设置',
        'settings.scanDepth': '扫描深度',
        'settings.scanDepthHint': '从扫描根向下查找仓库的层数（1–10）。',
        'settings.roots': '扫描根目录',
        'settings.rootsHint': '每行一个绝对路径。',
        'settings.autoDetection': '自动发现仓库',
        'settings.auto.true': '开启',
        'settings.auto.false': '关闭',
        'settings.auto.subFolders': '仅子目录',
        'settings.pullStrategy': '拉取策略',
        'settings.pull.merge': '合并',
        'settings.pull.rebase': '变基',
        'settings.pull.ffOnly': '仅快进',
        'settings.saved': '设置已保存',
        'settings.reset': '恢复默认',
        'settings.extraRoots': '额外仓库路径',
        'settings.extraRootsHint': '「添加仓库」保存的路径也会参与扫描。',
        'empty.body': '选择一个目录来初始化仓库，或添加已有的仓库路径。',
        'empty.path': '绝对路径',
        'empty.pathPlaceholder': '/Users/you/project',
        'empty.settings': '打开设置',
        'empty.scanning': '正在扫描仓库…',
        'empty.truncated': '仓库过多，只显示前 200 个。',
        'empty.initHint': '会在该目录执行 git init。',
        'action.resolve': '解决冲突',
        'branch.checkoutAfter': '创建后切换到该分支',
        'branch.newName': '新名称',
        'branch.noMatch': '没有匹配的分支',
        'branch.startPointPlaceholder': '起点（默认 HEAD）',
        'branch.upstreamPlaceholder': 'origin/main',
        'commit.done': '已提交：{subject}',
        'commit.emptyHint': '暂存更改后即可提交',
        'commit.message': '提交信息',
        'commit.stagedCount': '已暂存 {n} 个文件',
        'common.required': '{name} 不能为空',
        'empty.addHint': '添加一个包含 Git 仓库的目录',
        'empty.suggestHint': '这些目录里已经有仓库，点一下加入扫描根：',
        'empty.suggest': '扫描 {path}（{n} 个仓库）',
        'empty.scanned': '当前扫描：{list}',
        'error.unavailable': 'Git 服务不可用',
        'error.unavailableHint': '右侧栏服务未就绪，无法打开 Git 面板',
        'remote.namePlaceholder': 'origin',
        'remote.urlPlaceholder': 'git@github.com:owner/repo.git',
        'repo.added': '已添加仓库：{path}',
        'repo.changed': '±{n}',
        'repo.fetchDone': '已获取远程更新',
        'repo.forcePush': '强制推送',
        'repo.initDone': '仓库已初始化',
        'repo.pullDone': '已拉取',
        'repo.pushDone': '已推送',
        'repo.select': '选择仓库',
        'settings.save': '保存',
        'stash.messagePlaceholder': '说明（可选）',
        'tag.messagePlaceholder': '注解（可选）',
        'tag.namePlaceholder': 'v1.0.0',
        'tag.rev': '目标修订',
        'tag.revPlaceholder': 'HEAD',
      },
      en: {
        'tab.title': 'Git',
        'tab.unavailable': 'Git service unavailable',
        'guide.title': 'Source Control',
        'guide.description': 'Review repository status, commit changes, and manage branches and history.',
        'header.button': 'Git',
        'repo.none': 'No Git repository found',
        'repo.noneSelected': 'No repository selected',
        'repo.add': 'Add repository',
        'repo.init': 'Initialize repository',
        'repo.refresh': 'Refresh',
        'repo.settings': 'Settings',
        'repo.fetch': 'Fetch',
        'repo.pull': 'Pull',
        'repo.push': 'Push',
        'repo.detached': 'Detached HEAD',
        'repo.unborn': 'No commits yet',
        'repo.upstreamNone': 'No upstream',
        'repo.aheadBehind': '↑{ahead} ↓{behind}',
        'repo.stashCount': 'Stashes {n}',
        'repo.selectLabel': 'Repository',
        'status.staged': 'Staged changes',
        'status.changes': 'Changes',
        'status.untracked': 'Untracked',
        'status.conflicts': 'Conflicts',
        'status.clean': 'The working tree is clean.',
        'status.loading': 'Loading repository status…',
        'action.stage': 'Stage',
        'action.unstage': 'Unstage',
        'action.discard': 'Discard changes',
        'action.openDiff': 'Open diff',
        'action.stageAll': 'Stage all',
        'action.unstageAll': 'Unstage all',
        'action.commit': 'Commit',
        'action.commitPush': 'Commit and push',
        'action.commitSync': 'Commit and sync',
        'action.amend': 'Amend last commit',
        'action.stageAllCommit': 'Stage all and commit',
        'action.commitPlaceholder': 'Message (⌘Enter to commit)',
        'action.commitMenu': 'More commit actions',
        'action.resolveOurs': 'Accept current',
        'action.resolveTheirs': 'Accept incoming',
        'action.busy': 'Working…',
        'branch.title': 'Branches',
        'branch.current': 'Current branch',
        'branch.create': 'New branch',
        'branch.rename': 'Rename',
        'branch.delete': 'Delete branch',
        'branch.checkout': 'Checkout',
        'branch.upstream': 'Set upstream',
        'branch.search': 'Search branches',
        'branch.empty': 'No branches',
        'branch.name': 'Branch name',
        'branch.namePlaceholder': 'e.g. feature/login',
        'branch.startPoint': 'Start point (optional)',
        'branch.renameTo': 'New name',
        'branch.upstreamName': 'Upstream (e.g. origin/main)',
        'branch.deleteForce': 'Force delete (even if unmerged)',
        'history.title': 'History',
        'history.loadMore': 'Load more',
        'history.empty': 'No commits',
        'history.detail': 'Commit details',
        'history.author': 'Author',
        'history.date': 'Date',
        'history.parents': 'Parents',
        'history.files': 'Changed files',
        'history.viewAll': 'View full diff',
        'history.hash': 'Hash',
        'history.loading': 'Loading commits…',
        'stash.title': 'Stashes',
        'stash.empty': 'No stashes',
        'stash.push': 'Stash changes',
        'stash.apply': 'Apply',
        'stash.pop': 'Pop',
        'stash.drop': 'Drop',
        'stash.message': 'Message (optional)',
        'stash.includeUntracked': 'Include untracked files',
        'tag.title': 'Tags',
        'tag.empty': 'No tags',
        'tag.create': 'New tag',
        'tag.delete': 'Delete tag',
        'tag.push': 'Push tag',
        'tag.name': 'Tag name',
        'tag.message': 'Message (optional)',
        'tag.annotated': 'Annotated',
        'remote.title': 'Remotes',
        'remote.empty': 'No remotes',
        'remote.add': 'Add remote',
        'remote.remove': 'Remove remote',
        'remote.setUrl': 'Change URL',
        'remote.name': 'Name',
        'remote.url': 'URL',
        'remote.fetchUrl': 'Fetch URL',
        'remote.pushUrl': 'Push URL',
        'submodule.title': 'Submodules',
        'submodule.empty': 'No submodules',
        'submodule.update': 'Update submodules',
        'submodule.path': 'Path',
        'submodule.state': 'State',
        'submodule.sha': 'Commit',
        'raw.title': 'Run Git command',
        'raw.run': 'Run',
        'raw.placeholder': 'git log --oneline -5',
        'raw.hint': 'Only commands starting with git; executed without a shell.',
        'raw.output': 'Output',
        'raw.stderr': 'Stderr',
        'raw.exitCode': 'Exit code {code}',
        'raw.empty': 'Output appears here after running a command.',
        'operation.merge': 'Merging',
        'operation.rebase': 'Rebasing',
        'operation.cherryPick': 'Cherry-picking',
        'operation.revert': 'Reverting',
        'operation.bisect': 'Bisecting',
        'operation.continue': 'Continue',
        'operation.skip': 'Skip',
        'operation.abort': 'Abort',
        'operation.detail': 'Detail: {detail}',
        'error.title': 'Something went wrong',
        'error.unknown': 'Unknown error',
        'error.network': 'Cannot reach the Git service',
        'error.detail': 'Details',
        'error.E_NOT_REPO': 'Not a Git repository',
        'error.E_NO_GIT': 'git is not installed',
        'error.E_TIMEOUT': 'Git operation timed out',
        'error.E_AUTH_REQUIRED': 'Remote authentication required',
        'error.E_LOCKED': 'Repository is locked by another Git process',
        'error.E_CONFLICT': 'Unresolved conflicts',
        'error.E_INVALID_ARG': 'Invalid argument',
        'error.E_GIT_FAILED': 'Git command failed',
        'error.E_BARE_REPO': 'A bare repository has no working tree',
        'error.E_HOOK_FAILED': 'A git hook rejected the operation',
        'error.E_NOTHING_TO_COMMIT': 'There is nothing to commit',
        'error.E_BRANCH_CURRENT': 'This branch is checked out here',
        'error.E_BRANCH_IN_USE': 'The branch is checked out in another worktree',
        'error.E_BRANCH_NOT_MERGED': 'The branch is not fully merged',
        'error.E_DIRTY_TREE': 'Local changes would be overwritten',
        'error.E_ALREADY_EXISTS': 'The target already exists',
        'error.E_NOT_FOUND': 'The target does not exist',
        'error.E_NO_UPSTREAM': 'The branch has no upstream',
        'error.E_NO_REMOTE': 'No remote is configured',
        'error.E_REJECTED': 'The remote rejected the push',
        'error.E_DIVERGED': 'Local and remote branches have diverged',
        'error.E_NOT_REPO.hint': 'This folder is not a git repository. Pick the repository root.',
        'error.E_NO_GIT.hint': 'The git executable was not found. Check that git is installed and on PATH.',
        'error.E_TIMEOUT.hint': 'The command timed out. Network operations may need one interactive sign-in in a terminal first.',
        'error.E_AUTH_REQUIRED.hint': 'The remote requires authentication. Sign in with git in a terminal first.',
        'error.E_LOCKED.hint': 'Another git process holds the index. Retry shortly, or remove .git/index.lock once nothing is running.',
        'error.E_CONFLICT.hint': 'Unresolved conflicts remain. Resolve them before continuing.',
        'error.E_INVALID_ARG.hint': 'The arguments are not valid. Check what was entered.',
        'error.E_GIT_FAILED.hint': 'git failed. Open "Raw output" for the reason.',
        'error.E_UNSUPPORTED.hint': 'This repository or git version does not support the operation.',
        'error.E_INTERNAL.hint': 'Internal plugin error. Retrying once may help.',
        'error.E_BARE_REPO.hint': 'A bare repository has no work tree, so this operation cannot run.',
        'error.E_HOOK_FAILED.hint': 'A repository hook (husky, lint-staged, …) rejected the operation. Fix what the raw output reports, then retry.',
        'error.E_NOTHING_TO_COMMIT.hint': 'The staging area is empty. Stage the changes to commit first.',
        'error.E_BRANCH_CURRENT.hint': 'This branch is checked out here. Switch to another branch before deleting it.',
        'error.E_BRANCH_IN_USE.hint': 'This branch is checked out in another worktree. Switch away there or remove that worktree.',
        'error.E_BRANCH_NOT_MERGED.hint': 'The branch still has unmerged commits. Use "Force delete" once you are sure it is no longer needed.',
        'error.E_BRANCH_NOT_MERGED.count': '{n} commit(s) are not merged into this branch: {list}',
        'error.E_DIRTY_TREE.hint': 'Uncommitted changes would be overwritten. Commit or stash them first.',
        'error.E_ALREADY_EXISTS.hint': 'A target with that name already exists. Pick another name or remove the old one.',
        'error.E_NOT_FOUND.hint': 'No such branch, tag, commit or path. Check the spelling.',
        'error.E_NO_UPSTREAM.hint': 'The branch has no upstream. Set one before pushing.',
        'error.E_UPSTREAM_MISMATCH': 'The upstream branch has a different name',
        'error.E_UPSTREAM_MISMATCH.hint': 'This branch tracks an upstream with a different name, so git refuses by default. Push to the same-name branch or to the existing upstream.',
        'push.mismatchTitle': 'Which branch should receive the push?',
        'push.mismatchField': 'Destination',
        'push.toSame': 'Remote branch with the same name: {branch}',
        'push.toUpstream': 'Existing upstream branch: {branch}',
        'push.mismatchHint': 'This branch {branch} tracks {upstream} — different names. The same-name option pushes to a remote branch named {branch}; the upstream option pushes to the branch you already track. Your upstream configuration is left untouched.',
        'error.E_NO_REMOTE.hint': 'The repository has no remote. Add one first.',
        'error.E_REJECTED.hint': 'The remote rejected the push. Pull and reconcile before pushing again.',
        'error.E_DIVERGED.hint': 'Local and remote have independent commits. Merge or rebase before pushing.',
        'error.raw': 'Raw output',
        'error.E_UNSUPPORTED': 'Operation not supported here',
        'error.E_INTERNAL': 'Plugin internal error',
        'confirm.title': 'Please confirm',
        'confirm.discard': 'Discard these changes? This cannot be undone.',
        'confirm.forceDeleteBranch': 'Branch "{name}" has unmerged commits. Force deleting it drops them from history (recoverable through git reflog).',
        'confirm.deleteBranch': 'Delete branch "{name}"?',
        'confirm.rawDanger': 'This command discards work or rewrites history. Run it?\n\n{command}',
        'confirm.forcePush': 'Force push overwrites remote history. Continue?',
        'confirm.deleteTag': 'Delete tag "{name}"?',
        'confirm.removeRemote': 'Remove remote "{name}"?',
        'confirm.dropStash': 'Drop this stash?',
        'common.cancel': 'Cancel',
        'common.confirm': 'Confirm',
        'common.copy': 'Copy',
        'common.copied': 'Copied',
        'common.close': 'Close',
        'common.loading': 'Loading…',
        'common.empty': 'Nothing here',
        'common.back': 'Back',
        'common.create': 'Create',
        'common.save': 'Save',
        'common.remove': 'Remove',
        'common.apply': 'Apply',
        'common.retry': 'Retry',
        'common.search': 'Search',
        'common.none': 'None',
        'common.unknown': 'Unknown',
        'common.optional': 'optional',
        'common.refresh': 'Refresh',
        'common.discard': 'Discard',
        'common.delete': 'Delete',
        'common.rename': 'Rename',
        'common.checkout': 'Checkout',
        'diff.title': 'Diff',
        'diff.back': 'Back',
        'diff.stageFile': 'Stage this file',
        'diff.unstageFile': 'Unstage this file',
        'diff.binary': 'Binary file — no text diff.',
        'diff.truncated': 'The diff is large and was truncated.',
        'diff.empty': 'No changes.',
        'diff.loading': 'Loading diff…',
        'diff.staged': 'Staged',
        'diff.stat': '+{added} −{removed}',
        'diff.limit': 'Diff too long — showing the first {n} lines.',
        'settings.title': 'Git settings',
        'settings.scanDepth': 'Scan depth',
        'settings.scanDepthHint': 'Directory levels to search below each root (1–10).',
        'settings.roots': 'Scan roots',
        'settings.rootsHint': 'One absolute path per line.',
        'settings.autoDetection': 'Auto-detect repositories',
        'settings.auto.true': 'On',
        'settings.auto.false': 'Off',
        'settings.auto.subFolders': 'Subfolders only',
        'settings.pullStrategy': 'Pull strategy',
        'settings.pull.merge': 'Merge',
        'settings.pull.rebase': 'Rebase',
        'settings.pull.ffOnly': 'Fast-forward only',
        'settings.saved': 'Settings saved',
        'settings.reset': 'Reset to defaults',
        'settings.extraRoots': 'Extra repository paths',
        'settings.extraRootsHint': 'Paths saved by "Add repository" are scanned too.',
        'empty.body': 'Initialize a repository in a directory, or add an existing repository path.',
        'empty.path': 'Absolute path',
        'empty.pathPlaceholder': '/Users/you/project',
        'empty.settings': 'Open settings',
        'empty.scanning': 'Scanning for repositories…',
        'empty.truncated': 'Too many repositories — showing the first 200.',
        'empty.initHint': 'Runs git init in that directory.',
        'action.resolve': 'Resolve conflict',
        'branch.checkoutAfter': 'Check out after creating',
        'branch.newName': 'New name',
        'branch.noMatch': 'No matching branches',
        'branch.startPointPlaceholder': 'Start point (defaults to HEAD)',
        'branch.upstreamPlaceholder': 'origin/main',
        'commit.done': 'Committed: {subject}',
        'commit.emptyHint': 'Stage changes to enable commit',
        'commit.message': 'Commit message',
        'commit.stagedCount': '{n} staged files',
        'common.required': '{name} is required',
        'empty.addHint': 'Add a directory that contains a Git repository',
        'empty.suggestHint': 'Repositories already live here — click to add the folder:',
        'empty.suggest': 'Scan {path} ({n} repositories)',
        'empty.scanned': 'Scanning: {list}',
        'error.unavailable': 'Git service unavailable',
        'error.unavailableHint': 'The sidebar service is not ready, so the Git panel cannot open',
        'remote.namePlaceholder': 'origin',
        'remote.urlPlaceholder': 'git@github.com:owner/repo.git',
        'repo.added': 'Repository added: {path}',
        'repo.changed': '±{n}',
        'repo.fetchDone': 'Fetched from remote',
        'repo.forcePush': 'Force push',
        'repo.initDone': 'Repository initialized',
        'repo.pullDone': 'Pulled',
        'repo.pushDone': 'Pushed',
        'repo.select': 'Select repository',
        'settings.save': 'Save',
        'stash.messagePlaceholder': 'Message (optional)',
        'tag.messagePlaceholder': 'Annotation (optional)',
        'tag.namePlaceholder': 'v1.0.0',
        'tag.rev': 'Target revision',
        'tag.revPlaceholder': 'HEAD',
      },
    };

    // ---------------------------------------------------------------------
    // 3. Styles (alias tokens only; the pane lives at 320–440px wide)
    // ---------------------------------------------------------------------

    const styles = `
      .dg-root {
        position: relative;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        min-width: 0;
        font-size: 13px;
        line-height: 20px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
      }
      .dg-root *,
      .dg-root *::before,
      .dg-root *::after { box-sizing: border-box; }
      .dg-root button { font: inherit; }
      .dg-top {
        display: flex;
        flex: none;
        align-items: center;
        gap: 3px;
        padding: 6px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .dg-select {
        flex: 1;
        min-width: 0;
        height: 26px;
        padding: 0 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .dg-select:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .dg-iconbtn {
        position: relative;
        display: grid;
        place-items: center;
        width: 26px;
        height: 26px;
        flex: none;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .dg-iconbtn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dg-iconbtn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
      .dg-iconbtn:disabled { opacity: 0.45; cursor: default; }
      .dg-iconbtn:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .dg-iconbtn-on {
        background: var(--dsw-alias-interactive-bg-active);
        color: var(--dsw-alias-label-primary);
      }
      .dg-syncbadge {
        position: absolute;
        top: -1px;
        right: -2px;
        min-width: 13px;
        height: 13px;
        padding: 0 3px;
        border-radius: 7px;
        background: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-label-primary-foreground);
        font-size: 9px;
        font-weight: 600;
        line-height: 13px;
        text-align: center;
      }
      .dg-meta {
        display: flex;
        flex: none;
        align-items: center;
        gap: 6px;
        min-width: 0;
        padding: 3px 8px 5px;
        font-size: 11px;
        line-height: 16px;
        color: var(--dsw-alias-label-tertiary);
      }
      .dg-meta-branch {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--dsw-alias-label-secondary);
        font-weight: 500;
      }
      .dg-meta-spacer { flex: 1; }
      .dg-meta-item { flex: none; }
      .dg-busy {
        flex: none;
        padding: 3px 8px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        line-height: 16px;
      }
      .dg-banner {
        display: flex;
        flex: none;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
        font-size: 12px;
        line-height: 18px;
      }
      .dg-banner-text { flex: 1; min-width: 0; overflow-wrap: break-word; }
      .dg-scroll {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 6px;
      }
      .dg-group { margin-bottom: 4px; }
      .dg-group-head {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 3px 2px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        font-weight: 600;
        line-height: 16px;
        letter-spacing: 0.02em;
        text-align: left;
        cursor: pointer;
      }
      .dg-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dg-group-head:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: -1px;
      }
      .dg-group-toggle,
      .dg-sec-toggle {
        display: flex;
        flex: 1;
        align-items: center;
        gap: 4px;
        min-width: 0;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .dg-group-toggle:focus-visible,
      .dg-sec-toggle:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .dg-group-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dg-count {
        flex: none;
        padding: 0 6px;
        border-radius: 9px;
        background: var(--dsw-alias-bg-layer-3);
        color: var(--dsw-alias-label-tertiary);
        font-size: 10px;
        font-weight: 600;
        line-height: 15px;
      }
      .dg-group-action {
        flex: none;
        padding: 0 4px;
        border: 0;
        border-radius: 4px;
        background: none;
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
        line-height: 16px;
        cursor: pointer;
      }
      .dg-group-action:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dg-caret {
        display: inline-block;
        width: 10px;
        flex: none;
        font-size: 9px;
        line-height: 16px;
        transition: transform 120ms ease;
      }
      .dg-caret-open { transform: rotate(90deg); }
      .dg-row {
        display: flex;
        align-items: center;
        gap: 5px;
        min-height: 22px;
        padding: 1px 3px;
        border-radius: 5px;
        cursor: pointer;
      }
      .dg-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dg-row:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: -1px;
      }
      .dg-letter {
        width: 13px;
        flex: none;
        font-family: var(--dsw-alias-mono-font-family, monospace);
        font-size: 11px;
        font-weight: 700;
        text-align: center;
      }
      .dg-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
        text-overflow: ellipsis;
        color: var(--dsw-alias-label-primary);
      }
      .dg-name-dim { color: var(--dsw-alias-label-tertiary); }
      .dg-row-actions { display: none; flex: none; align-items: center; gap: 1px; }
      .dg-row:hover .dg-row-actions,
      .dg-row:focus-within .dg-row-actions { display: flex; }
      .dg-mini {
        display: grid;
        place-items: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .dg-mini:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
      .dg-mini:disabled { opacity: 0.4; cursor: default; }
      .dg-mini:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: -1px;
      }
      .dg-tone-add { color: var(--dsw-alias-state-success-primary); }
      .dg-tone-del { color: var(--dsw-alias-state-error-primary); }
      .dg-tone-mod { color: var(--dsw-alias-state-warn-primary); }
      .dg-tone-conflict { color: var(--dsw-alias-state-error-primary); }
      .dg-tone-new { color: var(--dsw-alias-label-tertiary); }
      .dg-tone-plain { color: var(--dsw-alias-label-secondary); }
      .dg-commit {
        margin: 8px 0 6px;
        padding-top: 8px;
        border-top: 1px solid var(--dsw-alias-border-l1);
      }
      .dg-textarea {
        display: block;
        width: 100%;
        min-height: 54px;
        max-height: 180px;
        padding: 6px 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 7px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        line-height: 18px;
        resize: vertical;
      }
      .dg-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
      .dg-textarea:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 0;
        border-color: transparent;
      }
      .dg-commit-row { position: relative; display: flex; align-items: center; gap: 4px; margin-top: 6px; }
      .dg-primary {
        display: flex;
        flex: 1;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border: 1px solid transparent;
        border-radius: 7px;
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
        color: var(--dsw-alias-label-primary-foreground);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .dg-primary:hover:not(:disabled) { filter: brightness(1.06); }
      .dg-primary:disabled { opacity: 0.45; cursor: default; }
      .dg-primary:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 2px;
      }
      .dg-caretbtn {
        display: grid;
        place-items: center;
        width: 26px;
        height: 28px;
        flex: none;
        padding: 0;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 7px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .dg-caretbtn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dg-caretbtn:disabled { opacity: 0.45; cursor: default; }
      .dg-menu {
        position: absolute;
        right: 0;
        bottom: calc(100% + 4px);
        z-index: 6;
        min-width: 168px;
        max-width: 100%;
        padding: 4px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-3));
        box-shadow: var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.18));
      }
      .dg-menu-item {
        display: block;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: 5px;
        background: none;
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        line-height: 18px;
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
      }
      .dg-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dg-menu-item:disabled { opacity: 0.45; cursor: default; }
      .dg-menu-item:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: -2px;
      }
      .dg-menu-item-danger { color: var(--dsw-alias-state-error-primary); }
      .dg-menu-down { top: calc(100% + 4px); bottom: auto; }
      .dg-anchor { position: relative; display: flex; flex: none; }
      .dg-sec { border-top: 1px solid var(--dsw-alias-border-l1); }
      .dg-sec-head {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 5px 2px;
        border: 0;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        font-weight: 600;
        line-height: 18px;
        text-align: left;
        cursor: pointer;
      }
      .dg-sec-head:hover { color: var(--dsw-alias-label-primary); }
      .dg-sec-head:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: -2px;
      }
      .dg-sec-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dg-sec-body { padding: 2px 0 8px; }
      .dg-hint {
        margin: 2px 0 4px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
        line-height: 16px;
      }
      .dg-note {
        margin: 4px 0;
        padding: 5px 8px;
        border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        line-height: 16px;
        overflow-wrap: break-word;
      }
      .dg-field { display: flex; flex-direction: column; gap: 3px; margin: 0 0 8px; }
      .dg-field-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
      .dg-field-row { display: flex; align-items: center; gap: 6px; }
      .dg-input,
      .dg-small-select {
        width: 100%;
        height: 28px;
        padding: 0 7px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
      }
      .dg-input:focus-visible,
      .dg-small-select:focus-visible,
      .dg-textarea:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 0;
      }
      .dg-check { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; cursor: pointer; }
      .dg-check input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
      .dg-btn {
        height: 26px;
        padding: 0 9px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font-size: 11px;
        line-height: 24px;
        white-space: nowrap;
        cursor: pointer;
      }
      .dg-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dg-btn:disabled { opacity: 0.45; cursor: default; }
      .dg-btn:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .dg-btn-danger {
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .dg-btn-danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
      }
      .dg-btnrow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 4px; }
      .dg-listrow {
        display: flex;
        align-items: center;
        gap: 5px;
        min-height: 24px;
        padding: 2px 3px;
        border-radius: 5px;
      }
      .dg-listrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dg-listmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .dg-listactions { flex: none; display: flex; align-items: center; gap: 1px; }
      .dg-listtitle {
        overflow: hidden;
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        line-height: 17px;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .dg-listsub {
        overflow: hidden;
        color: var(--dsw-alias-label-tertiary);
        font-size: 10px;
        line-height: 14px;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .dg-current {
        flex: none;
        padding: 0 5px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
        color: var(--dsw-alias-brand-primary);
        font-size: 10px;
        font-weight: 600;
        line-height: 15px;
      }
      .dg-error {
        flex: none;
        margin: 6px;
        padding: 7px 8px;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        line-height: 18px;
      }
      .dg-error-head { display: flex; align-items: flex-start; gap: 6px; }
      .dg-error-hint {
        padding: 0 8px 2px;
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        line-height: 16px;
      }
      .dg-error-raw > summary {
        padding: 0 8px 4px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
        line-height: 16px;
        cursor: pointer;
        user-select: none;
      }
      .dg-error-title { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: break-word; }
      .dg-error-detail {
        margin: 5px 0 0;
        max-height: 140px;
        overflow: auto;
        color: var(--dsw-alias-label-secondary);
        font-family: var(--dsw-alias-mono-font-family, monospace);
        font-size: 11px;
        line-height: 15px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .dg-error-actions { display: flex; gap: 4px; margin-top: 6px; }
      .dg-empty {
        display: flex;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 0;
        padding: 24px 18px;
        text-align: center;
        color: var(--dsw-alias-label-tertiary);
      }
      .dg-empty-icon { color: var(--dsw-alias-label-dimmed); }
      .dg-empty-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 20px; }
      .dg-empty-body { margin: 0; max-width: 280px; font-size: 12px; line-height: 18px; overflow-wrap: break-word; }
      .dg-empty .dg-input { max-width: 280px; }
      .dg-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 2px; }
      .dg-empty-suggest { display: flex; flex-direction: column; align-items: center; gap: 4px; max-width: 320px; margin-top: 2px; }
      .dg-empty-suggest .dg-hint { margin: 0; text-align: center; }
      .dg-empty-scanned { max-width: 320px; text-align: center; overflow-wrap: anywhere; }
      .dg-diff { display: flex; flex: 1; flex-direction: column; min-height: 0; }
      .dg-diff-head {
        display: flex;
        flex: none;
        align-items: center;
        gap: 6px;
        padding: 5px 6px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .dg-diff-path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .dg-filepath {
        display: flex;
        align-items: baseline;
        min-width: 0;
        overflow: hidden;
      }
      .dg-filepath-dir {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        color: var(--dsw-alias-label-tertiary);
      }
      .dg-filepath-name {
        flex: 0 0 auto;
        white-space: nowrap;
      }
      .dg-listtitle-path { display: block; }
      .dg-diff-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 2px 0 10px;
        background: var(--dsw-alias-bg-base);
      }
      .dg-line {
        display: block;
        padding: 0 8px;
        font-family: var(--dsw-alias-mono-font-family, monospace);
        font-size: 11.5px;
        line-height: 17px;
        white-space: pre;
        color: var(--dsw-alias-label-primary);
      }
      .dg-line-add { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent); }
      .dg-line-del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent); }
      .dg-line-hunk {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
      }
      .dg-line-meta { color: var(--dsw-alias-label-tertiary); }
      .dg-line-file { color: var(--dsw-alias-label-secondary); font-weight: 600; }
      .dg-pre {
        margin: 4px 0;
        max-height: 260px;
        overflow: auto;
        padding: 6px 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 7px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-alias-mono-font-family, monospace);
        font-size: 11px;
        line-height: 16px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .dg-kv {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: 2px 8px;
        margin: 4px 0;
        font-size: 11px;
        line-height: 16px;
      }
      .dg-kv-key { color: var(--dsw-alias-label-tertiary); }
      .dg-kv-val { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
      .dg-commit-card { padding: 4px 2px 8px; }
      .dg-commit-subject { margin: 0 0 4px; font-size: 13px; font-weight: 600; line-height: 19px; overflow-wrap: break-word; }
      .dg-scrim {
        position: fixed;
        inset: 0;
        z-index: 30;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.42));
      }
      .dg-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: min(360px, 100%);
        max-height: calc(100vh - 40px);
        overflow: auto;
        padding: 16px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px;
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
        box-shadow: var(--dsw-shadow-lv3, 0 16px 48px rgba(0, 0, 0, 0.28));
        color: var(--dsw-alias-label-primary);
      }
      .dg-card-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; }
      .dg-card-body { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: break-word; }
      .dg-card-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
      .dg-card-actions .dg-primary { flex: none; width: auto; padding: 0 14px; }
      .dg-headerbtn {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .dg-headerbtn:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dg-headerbtn:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .dg-tabtitle { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
      .dg-tabtitle-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      @media (max-width: 380px) {
        .dg-meta-item-optional { display: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dg-caret { transition: none; }
      }
    `;

    /** Inject the stylesheet once per document, so every surface can use it. */
    function injectStyles() {
      try {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin-css="dsh-git"]') !== null) return;
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-git';
        style.dataset.pluginCss = 'dsh-git';
        style.textContent = styles;
        document.head.appendChild(style);
      } catch (error) {
        console.error('[dsh-git] style injection failed', error);
      }
    }

    // ---------------------------------------------------------------------
    // 4. Pure helpers (no DOM, no React; also exposed for the unit tests)
    // ---------------------------------------------------------------------

    /** Error codes the Host half may return; each has an `error.<code>` string. */
    /**
     * Error codes the Host can return; each needs an `error.<code>` entry in
     * both dictionaries. `git/util.js`'s `ERROR_CODES` is the source of truth
     * and `test/host-failures.test.mjs` asserts the two lists stay identical.
     */
    const KNOWN_CODES = [
      'E_NOT_REPO',
      'E_NO_GIT',
      'E_TIMEOUT',
      'E_AUTH_REQUIRED',
      'E_LOCKED',
      'E_CONFLICT',
      'E_INVALID_ARG',
      'E_GIT_FAILED',
      'E_UNSUPPORTED',
      'E_INTERNAL',
      'E_BARE_REPO',
      'E_HOOK_FAILED',
      'E_NOTHING_TO_COMMIT',
      'E_BRANCH_CURRENT',
      'E_BRANCH_IN_USE',
      'E_BRANCH_NOT_MERGED',
      'E_DIRTY_TREE',
      'E_ALREADY_EXISTS',
      'E_NOT_FOUND',
      'E_NO_UPSTREAM',
      'E_UPSTREAM_MISMATCH',
      'E_NO_REMOTE',
      'E_REJECTED',
      'E_DIVERGED',
    ];

    /**
     * Raw commands that discard work or rewrite history; mirrors
     * `DESTRUCTIVE_RAW_PATTERNS` in the Host's `git/exec.js` (asserted by
     * `test/host-failures.test.mjs`) so the confirm dialog and the Host guard
     * agree. The Host rejects such a command unless it carries `confirm: true`.
     */
    const RAW_DESTRUCTIVE_PATTERNS = Object.freeze([
      'push\\b.*(--force|-f\\b|--force-with-lease|--mirror)',
      'push\\b.*\\+\\S+',
      'reset\\b.*--hard',
      'clean\\b.*-[a-z]*f',
      'branch\\b.*(-D\\b|--delete\\b.*--force)',
      'update-ref\\b.*(-d\\b|--delete)',
      'filter-branch|filter-repo',
      'reflog\\b.*expire',
      'gc\\b.*--prune',
      'worktree\\b.*remove\\b.*--force',
      'stash\\b.*(drop|clear)',
    ]);

    /** True when a typed `git ...` line would discard work or rewrite history. */
    function isDestructiveRawCommand(text) {
      const joined = String(text).trim().replace(/^git\s+/, '');
      return RAW_DESTRUCTIVE_PATTERNS.some((source) => new RegExp(source).test(joined));
    }

    /** Default client-side settings; the Host owns the authoritative config. */
    const DEFAULT_SETTINGS = {
      scanDepth: 5,
      roots: [],
      autoDetection: 'true',
      pullStrategy: 'merge',
    };

    /**
     * Absolute-path test that accepts POSIX, Windows drive and UNC shapes.
     * @param {unknown} value
     * @returns {boolean}
     */
    function isAbsolutePath(value) {
      if (typeof value !== 'string' || value === '') return false;
      if (value.charAt(0) === '/') return true;
      if (/^[A-Za-z]:[\\/]/.test(value)) return true;
      return value.slice(0, 2) === '\\\\';
    }

    /**
     * Split a settings textarea (newlines and/or commas) into unique paths.
     * @param {unknown} value - string or array of strings.
     * @returns {string[]}
     */
    function splitPathList(value) {
      const parts = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(/[\n,]/)
          : [];
      const seen = new Set();
      const out = [];
      for (const part of parts) {
        if (typeof part !== 'string') continue;
        const item = part.trim();
        if (item === '' || seen.has(item)) continue;
        seen.add(item);
        out.push(item);
      }
      return out;
    }

    /**
     * Clamp a numeric setting into range, falling back when it is not a number.
     * @param {unknown} value
     * @param {number} min
     * @param {number} max
     * @param {number} fallback
     * @returns {number}
     */
    function clampInt(value, min, max, fallback) {
      const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
      if (!Number.isFinite(parsed)) return fallback;
      const rounded = Math.round(parsed);
      if (rounded < min) return min;
      if (rounded > max) return max;
      return rounded;
    }

    /**
     * Keep both ends of a long path and drop the middle (`a/…/z`), so the
     * basename stays readable in a narrow pane.
     * @param {unknown} value
     * @param {number} [max]
     * @returns {string}
     */
    function middleEllipsis(value, max) {
      if (typeof value !== 'string') return '';
      const limit = Number.isFinite(max) && max > 5 ? Math.floor(max) : 40;
      if (value.length <= limit) return value;
      const head = Math.max(1, Math.ceil((limit - 1) / 2));
      const tail = Math.max(1, limit - 1 - head);
      return value.slice(0, head) + '…' + value.slice(value.length - tail);
    }

    /**
     * Split a repository-relative path into its directory and file name.
     *
     * A long path shown as `lib/common/voice/...voice_field.dart` hides the very
     * part a reader needs (which file, in which folder), so the panels render the
     * directory dimmed and the file name whole instead.
     * @param {unknown} value - path to split.
     * @returns {{ dir: string, name: string }}
     */
    function splitRepoPath(value) {
      const path = typeof value === 'string' ? value : '';
      const cut = path.lastIndexOf('/');
      if (cut === -1) return { dir: '', name: path };
      return { dir: path.slice(0, cut), name: path.slice(cut + 1) };
    }

    /**
     * Split an upstream reference such as `origin/dev_1.5.10` into its remote
     * and branch name. A local upstream (`main`) has no remote part.
     * @param {unknown} value
     * @returns {{ remote: string, branch: string }}
     */
    function splitUpstream(value) {
      const text = typeof value === 'string' ? value : '';
      const cut = text.indexOf('/');
      if (cut === -1) return { remote: '', branch: text };
      return { remote: text.slice(0, cut), branch: text.slice(cut + 1) };
    }

    /**
     * Classify one raw unified-diff line.
     * @param {unknown} value
     * @returns {'meta'|'file'|'hunk'|'add'|'del'|'ctx'}
     */
    function classifyDiffLine(value) {
      const text = typeof value === 'string' ? value : '';
      if (text.slice(0, 2) === '@@') return 'hunk';
      if (text.slice(0, 3) === '+++' || text.slice(0, 3) === '---') return 'file';
      if (
        text.slice(0, 10) === 'diff --git' ||
        text.slice(0, 6) === 'index ' ||
        text.slice(0, 13) === 'new file mode' ||
        text.slice(0, 17) === 'deleted file mode' ||
        text.slice(0, 16) === 'similarity index' ||
        text.slice(0, 11) === 'rename from' ||
        text.slice(0, 9) === 'rename to' ||
        text.slice(0, 8) === 'old mode' ||
        text.slice(0, 8) === 'new mode' ||
        text.slice(0, 12) === 'Binary files'
      ) {
        return 'meta';
      }
      if (text.charAt(0) === '+') return 'add';
      if (text.charAt(0) === '-') return 'del';
      return 'ctx';
    }

    /**
     * Turn a diff body into renderable rows.
     * @param {unknown} text
     * @returns {{kind: string, text: string}[]}
     */
    function classifyDiffLines(text) {
      if (typeof text !== 'string' || text === '') return [];
      const body = text.slice(-1) === '\n' ? text.slice(0, -1) : text;
      return body.split('\n').map((line) => ({ kind: classifyDiffLine(line), text: line }));
    }

    /**
     * The single status letter shown in a change row.
     * @param {any} entry - a FileEntry from the Host half.
     * @returns {string}
     */
    function statusLetter(entry) {
      if (entry === null || typeof entry !== 'object') return '?';
      if (typeof entry.conflict === 'string' && entry.conflict !== '') return 'U';
      const status = typeof entry.status === 'string' ? entry.status : '';
      if (status === '') return '?';
      if (status === '?') return '?';
      return status.charAt(0);
    }

    /**
     * The palette tone for a status letter.
     * @param {string} letter
     * @returns {'add'|'del'|'mod'|'conflict'|'new'|'plain'}
     */
    function statusTone(letter) {
      switch (letter) {
        case 'A':
        case 'C':
          return 'add';
        case 'D':
          return 'del';
        case 'M':
        case 'R':
        case 'T':
          return 'mod';
        case 'U':
          return 'conflict';
        case '?':
          return 'new';
        default:
          return 'plain';
      }
    }

    /**
     * `+12 −3` for a diff or a file entry.
     * @param {unknown} added
     * @param {unknown} removed
     * @returns {string}
     */
    function formatDiffStat(added, removed) {
      const plus = Number.isFinite(added) ? Math.max(0, Math.round(added)) : 0;
      const minus = Number.isFinite(removed) ? Math.max(0, Math.round(removed)) : 0;
      return '+' + String(plus) + ' −' + String(minus);
    }

    /**
     * Shorten a commit hash for display.
     * @param {unknown} hash
     * @param {number} [length]
     * @returns {string}
     */
    function shortHash(hash, length) {
      if (typeof hash !== 'string') return '';
      const size = Number.isFinite(length) && length > 0 ? Math.floor(length) : 7;
      return hash.slice(0, size);
    }

    /**
     * Normalize persisted settings into the shape the request layer sends.
     * @param {unknown} raw
     * @returns {{scanDepth: number, roots: string[], autoDetection: string, pullStrategy: string}}
     */
    function normalizeSettings(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const autoDetection =
        source.autoDetection === 'true' || source.autoDetection === 'false' || source.autoDetection === 'subFolders'
          ? source.autoDetection
          : DEFAULT_SETTINGS.autoDetection;
      const pullStrategy =
        source.pullStrategy === 'merge' || source.pullStrategy === 'rebase' || source.pullStrategy === 'ff-only'
          ? source.pullStrategy
          : DEFAULT_SETTINGS.pullStrategy;
      return {
        scanDepth: clampInt(source.scanDepth, 1, 10, DEFAULT_SETTINGS.scanDepth),
        roots: splitPathList(source.roots),
        autoDetection,
        pullStrategy,
      };
    }

    /**
     * Append one directory to the persisted scan roots.
     * @param {unknown} settings - current settings (persisted or normalized).
     * @param {unknown} path - directory to add.
     * @returns {{scanDepth: number, roots: string[], autoDetection: string, pullStrategy: string}}
     */
    function withScanRoot(settings, path) {
      const value = typeof path === 'string' ? path.trim() : '';
      const source = settings !== null && typeof settings === 'object' ? settings : {};
      const roots = Array.isArray(source.roots) ? source.roots : [];
      if (value === '') return normalizeSettings(source);
      return normalizeSettings(Object.assign({}, source, { roots: [...roots, value] }));
    }

    /**
     * Keep the current repository when it still exists, otherwise prefer the
     * repository that contains the session working directory.
     * @param {unknown} previous
     * @param {any[]} repos
     * @param {unknown} roots
     * @returns {string}
     */
    function pickRepo(previous, repos, roots) {
      const list = Array.isArray(repos) ? repos.filter((repo) => repo && typeof repo.path === 'string' && repo.path !== '') : [];
      if (list.length === 0) return '';
      if (typeof previous === 'string' && previous !== '' && list.some((repo) => repo.path === previous)) return previous;
      const root = Array.isArray(roots) && typeof roots[0] === 'string' ? roots[0] : '';
      if (root !== '') {
        const inside = list.filter((repo) => root === repo.path || root.slice(0, repo.path.length + 1) === repo.path + '/');
        if (inside.length > 0) {
          inside.sort((left, right) => right.path.length - left.path.length);
          return inside[0].path;
        }
      }
      return list[0].path;
    }

    /**
     * Map a thrown request error onto a localized title plus raw detail.
     * @param {any} error
     * @param {(key: string, params?: any) => string} t
     * @returns {{code: string, title: string, detail: string}}
     */
    function describeError(error, t) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
      const known = KNOWN_CODES.indexOf(code) !== -1;
      let title;
      if (known) title = t('error.' + code);
      else if (code === '') title = t('error.network');
      else title = t('error.unknown');
      const hintKey = 'error.' + code + '.hint';
      const hintText = known ? t(hintKey) : '';
      const hint = hintText === hintKey ? '' : hintText;
      const detail = error !== null && typeof error === 'object' && typeof error.detail === 'string' ? error.detail : '';
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
      // git writes its advice as `hint:` lines and prefixes the same sentence
      // with `error:`, which is how one failure ended up on screen three times
      // in English under a Chinese title. The reader gets the localized title
      // and one actionable line; the rest stays behind "raw output".
      // A specific git detail beats the Host's short message; showing both put
      // the same sentence on screen twice.
      const raw = cleanErrorText(detail !== '' ? detail : message);
      // The Host reports the unmerged commits in one fixed sentence; turning it
      // into the localized line keeps the actionable part in Chinese instead of
      // hiding it behind the raw-output toggle.
      let actionable = hint;
      if (code === 'E_BRANCH_NOT_MERGED') {
        const unmerged = /^(\d+) commit\(s\) are not merged into HEAD(?::\s*(.+))?$/m.exec(raw);
        if (unmerged !== null && typeof unmerged[2] === 'string' && unmerged[2].trim() !== '') {
          actionable = t('error.E_BRANCH_NOT_MERGED.count', { n: unmerged[1], list: unmerged[2].trim() });
        }
      }
      return { code, title, hint: actionable, raw, detail: raw };
    }

    /**
     * Turn git's stderr into the few lines worth showing: no `hint:` advice, no
     * `error:`/`fatal:` prefixes, no repeated sentence.
     * @param {unknown} value - raw error text.
     * @returns {string}
     */
    function cleanErrorText(value) {
      if (typeof value !== 'string' || value === '') return '';
      const seen = new Set();
      const lines = [];
      for (const rawLine of value.split('\n')) {
        const trimmed = rawLine.trim();
        if (trimmed === '' || trimmed.toLowerCase().startsWith('hint:')) continue;
        const line = trimmed.replace(/^(?:error|fatal):\s*/i, '');
        if (line === '' || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
      }
      return lines.join('\n');
    }

    /**
     * A repository line for the picker: name, branch and pending change count.
     * @param {any} repo
     * @param {(key: string, params?: any) => string} t
     * @returns {string}
     */
    function repoOptionLabel(repo, t) {
      if (repo === null || typeof repo !== 'object') return t('repo.noneSelected');
      const name = typeof repo.displayName === 'string' && repo.displayName !== ''
        ? repo.displayName
        : typeof repo.name === 'string' && repo.name !== ''
          ? repo.name
          : typeof repo.path === 'string'
            ? repo.path
            : '';
      const parts = [name];
      if (repo.detached === true) parts.push(t('repo.detached'));
      else if (typeof repo.branch === 'string' && repo.branch !== '') parts.push(repo.branch);
      else if (repo.unborn === true) parts.push(t('repo.unborn'));
      if (typeof repo.changed === 'number' && repo.changed > 0) parts.push('±' + String(repo.changed));
      if (typeof repo.error === 'string' && repo.error !== '') parts.push('!');
      return parts.filter((part) => part !== '').join(' · ');
    }

    // ---------------------------------------------------------------------
    // 5. Storage (best effort: private mode and disabled storage must not throw)
    // ---------------------------------------------------------------------

    /**
     * @param {string} key
     * @returns {string}
     */
    function readString(key) {
      try {
        const value = window.localStorage.getItem(key);
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    }

    /**
     * @param {string} key
     * @param {string} value
     */
    function writeString(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage may be unavailable; the panel keeps working from memory.
      }
    }

    /**
     * @param {string} key
     * @returns {any}
     */
    function readJson(key) {
      const raw = readString(key);
      if (raw === '') return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    /**
     * @param {string} key
     * @param {unknown} value
     */
    function writeJson(key, value) {
      try {
        writeString(key, JSON.stringify(value));
      } catch {
        // Serialization cannot fail for the plain objects used here, but the
        // panel must not care either way.
      }
    }

    /** @returns {{scanDepth: number, roots: string[], autoDetection: string, pullStrategy: string}} */
    function loadSettings() {
      return normalizeSettings(readJson(STORE.settings));
    }

    /**
     * Translate the persisted Client settings into the Host's configuration
     * keys (`autoDetection` is a UI name; the Host reads
     * `autoRepositoryDetection`, mirroring VSCode's setting name).
     * @param {unknown} value - persisted settings.
     * @returns {{scanDepth: number, roots: string[], autoRepositoryDetection: string, pullStrategy: string}}
     */
    function hostSettings(value) {
      const normalized = normalizeSettings(value);
      return {
        scanDepth: normalized.scanDepth,
        roots: normalized.roots,
        autoRepositoryDetection: normalized.autoDetection,
        pullStrategy: normalized.pullStrategy,
      };
    }

    /** @returns {Record<string, boolean>} */
    function loadCollapsed() {
      const raw = readJson(STORE.collapsed);
      const out = {};
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const key of Object.keys(raw)) {
          if (raw[key] === true) out[key] = true;
        }
      }
      return out;
    }

    /** @param {Record<string, boolean>} value */
    function saveCollapsed(value) {
      writeJson(STORE.collapsed, value);
    }

    /** @returns {string[]} */
    function loadExtraRoots() {
      return splitPathList(readJson(STORE.extraRoots));
    }

    /** @param {string[]} value */
    function saveExtraRoots(value) {
      writeJson(STORE.extraRoots, splitPathList(value));
    }

    // ---------------------------------------------------------------------
    // 6. Request layer
    // ---------------------------------------------------------------------

    /**
     * Call one Host action. Business failures arrive as `ok: false` and are
     * rethrown with `code`/`detail` so the UI can localize the code and show the
     * raw detail.
     * @param {string} action
     * @param {Record<string, any>} [params]
     * @returns {Promise<any>}
     */
    async function call(action, params) {
      const body = { action };
      if (params !== null && typeof params === 'object') {
        for (const key of Object.keys(params)) {
          if (params[key] !== undefined) body[key] = params[key];
        }
      }
      let response;
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        const error = new Error(cause instanceof Error ? cause.message : String(cause));
        error.code = '';
        error.detail = cause instanceof Error && typeof cause.stack === 'string' ? cause.stack : '';
        throw error;
      }
      let data;
      try {
        data = await response.json();
      } catch {
        const error = new Error('invalid response');
        error.code = 'E_INTERNAL';
        error.detail = 'HTTP ' + String(response.status);
        throw error;
      }
      if (data === null || typeof data !== 'object') {
        const error = new Error('invalid response');
        error.code = 'E_INTERNAL';
        error.detail = 'HTTP ' + String(response.status);
        throw error;
      }
      if (data.ok !== true) {
        const info = data.error !== null && typeof data.error === 'object' ? data.error : {};
        const error = new Error(typeof info.message === 'string' && info.message !== '' ? info.message : 'request failed');
        error.code = typeof info.code === 'string' ? info.code : 'E_INTERNAL';
        error.detail = typeof info.detail === 'string' ? info.detail : '';
        throw error;
      }
      return data.value;
    }

    /**
     * Copy text without depending on the async clipboard permission prompt.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async function writeClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // Fall through to the selection-based path.
      }
      try {
        if (typeof document === 'undefined') return false;
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    /**
     * Build the translator. `zh` is the default dictionary; the locale service
     * wins when it is bound and returns a string.
     * @param {any} ctx
     * @returns {(key: string, params?: any) => string}
     */
    function makeT(ctx) {
      let bind = null;
      try {
        if (ctx !== null && typeof ctx === 'object' && ctx.locale && typeof ctx.locale.bind === 'function') {
          bind = ctx.locale.bind(NS);
        }
      } catch {
        bind = null;
      }
      return function translate(key, params) {
        let text = null;
        if (bind !== null) {
          try {
            const value = bind(key);
            if (typeof value === 'string' && value !== '' && value !== key) text = value;
          } catch {
            text = null;
          }
        }
        if (text === null) {
          const fallback = dicts.zh[key] ?? dicts.en[key];
          text = typeof fallback === 'string' ? fallback : key;
        }
        if (params === null || params === undefined) return text;
        return text.replace(/\{(\w+)\}/g, (match, name) =>
          params[name] === undefined || params[name] === null ? match : String(params[name]),
        );
      };
    }

    // ---------------------------------------------------------------------
    // 7. Icons (original drawings; stroke follows currentColor)
    // ---------------------------------------------------------------------

    /**
     * @param {number} size
     * @param {string|undefined} className
     * @param {...any} children
     */
    function iconSvg(size, className, ...children) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className,
        },
        ...children,
      );
    }

    /**
     * Three dots joined by a branch: the bundle's mark, also shipped as icon.svg.
     * @param {{size?: number, className?: string}} [props]
     */
    function GitIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 16;
      const className = props !== null && typeof props === 'object' && typeof props.className === 'string' ? props.className : undefined;
      return iconSvg(
        size,
        className,
        h('circle', { key: 'a', cx: 7, cy: 6, r: 2.1 }),
        h('circle', { key: 'b', cx: 7, cy: 18, r: 2.1 }),
        h('circle', { key: 'c', cx: 17, cy: 9, r: 2.1 }),
        h('path', { key: 'd', d: 'M7 8.1v7.8' }),
        h('path', { key: 'e', d: 'M8.8 12.9h3.9a3 3 0 0 0 2.9-2.2' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function RefreshIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 14;
      return iconSvg(
        size,
        undefined,
        h('path', { key: 'a', d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }),
        h('path', { key: 'b', d: 'M19.5 4.5V9h-4.5' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function SettingsIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 14;
      return iconSvg(
        size,
        undefined,
        h('circle', { key: 'a', cx: 12, cy: 12, r: 2.9 }),
        h('path', {
          key: 'b',
          d: 'M12 3.5v2.2M12 18.3v2.2M4.9 7.6l1.9 1.1M17.2 15.3l1.9 1.1M4.9 16.4l1.9-1.1M17.2 8.7l1.9-1.1',
        }),
      );
    }

    /** @param {{size?: number}} [props] */
    function FetchIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 14;
      return iconSvg(
        size,
        undefined,
        h('path', { key: 'a', d: 'M12 4v10' }),
        h('path', { key: 'b', d: 'M8 10.5 12 14.5l4-4' }),
        h('path', { key: 'c', d: 'M5 19.5h14' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function PullIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 14;
      return iconSvg(
        size,
        undefined,
        h('path', { key: 'a', d: 'M12 4v11' }),
        h('path', { key: 'b', d: 'M7.5 10.5 12 15l4.5-4.5' }),
        h('path', { key: 'c', d: 'M5 19.5h14' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function PushIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 14;
      return iconSvg(
        size,
        undefined,
        h('path', { key: 'a', d: 'M12 20V9' }),
        h('path', { key: 'b', d: 'M7.5 13.5 12 9l4.5 4.5' }),
        h('path', { key: 'c', d: 'M5 4.5h14' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function ChevronIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 12;
      return iconSvg(size, undefined, h('path', { key: 'a', d: 'M7 9.5 12 14.5l5-5' }));
    }

    /** @param {{size?: number}} [props] */
    function BackIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 14;
      return iconSvg(
        size,
        undefined,
        h('path', { key: 'a', d: 'M19 12H5' }),
        h('path', { key: 'b', d: 'M11 6l-6 6 6 6' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function PlusIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 13;
      return iconSvg(size, undefined, h('path', { key: 'a', d: 'M12 5v14M5 12h14' }));
    }

    /** @param {{size?: number}} [props] */
    function MinusIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 13;
      return iconSvg(size, undefined, h('path', { key: 'a', d: 'M5 12h14' }));
    }

    /** @param {{size?: number}} [props] */
    function TrashIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 13;
      return iconSvg(
        size,
        undefined,
        h('path', { key: 'a', d: 'M4.5 6.5h15' }),
        h('path', { key: 'b', d: 'M9 6.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5' }),
        h('path', { key: 'c', d: 'M6.5 6.5l.8 12a1.2 1.2 0 0 0 1.2 1.1h7a1.2 1.2 0 0 0 1.2-1.1l.8-12' }),
      );
    }

    /** @param {{size?: number}} [props] */
    function CloseIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 13;
      return iconSvg(size, undefined, h('path', { key: 'a', d: 'M6 6l12 12M18 6 6 18' }));
    }

    /** @param {{size?: number}} [props] */
    function CopyIcon(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 13;
      return iconSvg(
        size,
        undefined,
        h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { key: 'b', d: 'M15 6.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5' }),
      );
    }

    // ---------------------------------------------------------------------
    // 8. Shared UI atoms and hooks
    // ---------------------------------------------------------------------

    /** A no-op used by fire-and-forget actions (errors are already surfaced). */
    function noop() {}

    /** Format an ISO date for a commit, tag or stash row. */
    function formatDate(value) {
      if (typeof value !== 'string' || value === '') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
      } catch {
        return value;
      }
    }

    /** Keep the latest value in a ref so effects can read it without a dep. */
    function useLatest(value) {
      const ref = React.useRef(value);
      ref.current = value;
      return ref;
    }

    /**
     * Load one resource when `active` flips true and reload on `key` changes.
     * The previous value survives a reload, so a poll never blanks the pane.
     * @param {boolean} active
     * @param {string} key
     * @param {() => Promise<any>} loader
     */
    function useAsync(active, key, loader) {
      const [state, setState] = React.useState({ status: 'idle', value: null, error: null });
      const [nonce, setNonce] = React.useState(0);
      const loaderRef = useLatest(loader);
      React.useEffect(() => {
        if (active !== true) {
          setState({ status: 'idle', value: null, error: null });
          return undefined;
        }
        let cancelled = false;
        setState((previous) => ({ status: 'loading', value: previous.value, error: null }));
        Promise.resolve()
          .then(() => loaderRef.current())
          .then(
            (value) => {
              if (!cancelled) setState({ status: 'ready', value, error: null });
            },
            (error) => {
              if (!cancelled) setState({ status: 'error', value: null, error });
            },
          );
        return () => {
          cancelled = true;
        };
      }, [active, key, nonce, loaderRef]);
      return {
        status: state.status,
        value: state.value,
        error: state.error,
        reload: React.useCallback(() => setNonce((value) => value + 1), []),
      };
    }

    /** A square icon button; `label` doubles as tooltip and accessible name. */
    function IconButton(props) {
      const label = typeof props.label === 'string' ? props.label : '';
      const classes = ['dg-iconbtn'];
      if (props.active === true) classes.push('dg-iconbtn-on');
      return h(
        'button',
        {
          type: 'button',
          className: classes.join(' '),
          title: typeof props.title === 'string' ? props.title : label,
          'aria-label': label,
          disabled: props.disabled === true,
          onClick: typeof props.onClick === 'function' ? props.onClick : undefined,
        },
        props.children,
      );
    }

    /** A compact text button (`dg-btn`), optionally in the danger tone. */
    /**
     * One repository path: dimmed directory that shrinks first, file name whole.
     * @param {{ path?: string }} props - the path to render.
     * @returns {object}
     */
    function FilePathLabel(props) {
      const parts = splitRepoPath(props.path);
      const title = typeof props.path === 'string' ? props.path : '';
      return h(
        'span',
        { className: 'dg-filepath', title },
        parts.dir === '' ? null : h('span', { className: 'dg-filepath-dir' }, parts.dir + '/'),
        h('span', { className: 'dg-filepath-name' }, parts.name),
      );
    }

    function TextButton(props) {
      const classes = ['dg-btn'];
      if (props.danger === true) classes.push('dg-btn-danger');
      return h(
        'button',
        {
          type: 'button',
          className: classes.join(' '),
          title: typeof props.title === 'string' ? props.title : undefined,
          disabled: props.disabled === true,
          onClick: typeof props.onClick === 'function' ? props.onClick : undefined,
        },
        props.children,
      );
    }

    /** An 18px inline action used inside list rows. */
    function MiniButton(props) {
      const label = typeof props.label === 'string' ? props.label : '';
      return h(
        'button',
        {
          type: 'button',
          className: 'dg-mini',
          title: label,
          'aria-label': label,
          disabled: props.disabled === true,
          onClick: (event) => {
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            if (typeof props.onClick === 'function') props.onClick(event);
          },
        },
        props.children,
      );
    }

    /**
     * A popover menu anchored to its parent. `direction` picks the side it opens
     * on: `up` (commit box) or `down` (top bar).
     */
    function PopoverMenu(props) {
      const [open, setOpen] = React.useState(false);
      const anchorRef = React.useRef(null);
      const items = Array.isArray(props.items) ? props.items : [];
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          if (anchorRef.current !== null && !anchorRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onPointer);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);
      const label = typeof props.label === 'string' ? props.label : '';
      return h(
        'div',
        { className: 'dg-anchor', ref: anchorRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dg-iconbtn' + (open ? ' dg-iconbtn-on' : ''),
            title: label,
            'aria-label': label,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            disabled: props.disabled === true,
            onClick: () => setOpen((value) => !value),
          },
          props.children,
        ),
        open
          ? h(
              'div',
              { className: 'dg-menu' + (props.direction === 'down' ? ' dg-menu-down' : ''), role: 'menu' },
              items.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    role: 'menuitem',
                    className: 'dg-menu-item' + (item.danger === true ? ' dg-menu-item-danger' : ''),
                    disabled: item.disabled === true,
                    onClick: () => {
                      setOpen(false);
                      if (typeof item.onSelect === 'function') item.onSelect();
                    },
                  },
                  item.label,
                ),
              ),
            )
          : null,
      );
    }

    /** Inline error banner: localized code, raw detail, copy and retry. */
    function ErrorBar(props) {
      const t = props.t;
      const info = describeError(props.error, t);
      const [copied, setCopied] = React.useState(false);
      React.useEffect(() => {
        if (!copied) return undefined;
        const timer = window.setTimeout(() => setCopied(false), 1500);
        return () => window.clearTimeout(timer);
      }, [copied]);
      const copy = () => {
        const text = [info.title, info.hint, info.raw].filter((part) => part !== '').join('\n\n');
        void writeClipboard(text).then((ok) => {
          if (ok) setCopied(true);
        });
      };
      return h(
        'div',
        { className: 'dg-error', role: 'alert' },
        h(
          'div',
          { className: 'dg-error-head' },
          h('span', { className: 'dg-error-title' }, info.title),
          typeof props.onDismiss === 'function'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dg-mini',
                  title: t('common.close'),
                  'aria-label': t('common.close'),
                  onClick: props.onDismiss,
                },
                h(CloseIcon, { size: 11 }),
              )
            : null,
        ),
        info.hint !== '' ? h('div', { className: 'dg-error-hint' }, info.hint) : null,
        info.raw !== ''
          ? h(
              'details',
              { className: 'dg-error-raw' },
              h('summary', {}, t('error.raw')),
              h('pre', { className: 'dg-error-detail' }, info.raw),
            )
          : null,
        h(
          'div',
          { className: 'dg-error-actions' },
          h(TextButton, { onClick: copy }, copied ? t('common.copied') : t('common.copy')),
          typeof props.onRetry === 'function' ? h(TextButton, { onClick: props.onRetry }, t('common.retry')) : null,
        ),
      );
    }

    /**
     * The header shared by the seven collapsible sections: caret, title, count
     * and optional action buttons.
     */
    function SectionShell(props) {
      return h(
        'section',
        { className: 'dg-sec' },
        h(
          'div',
          { className: 'dg-sec-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dg-sec-toggle',
              'aria-expanded': props.open === true,
              onClick: props.onToggle,
            },
            h(
              'span',
              { className: 'dg-caret' + (props.open === true ? ' dg-caret-open' : ''), 'aria-hidden': 'true' },
              '▸',
            ),
            h('span', { className: 'dg-sec-title' }, props.title),
            typeof props.count === 'number' && props.count > 0 ? h('span', { className: 'dg-count' }, String(props.count)) : null,
          ),
          props.actions === undefined ? null : props.actions,
        ),
        props.open === true ? h('div', { className: 'dg-sec-body' }, props.children) : null,
      );
    }

    /** One collapsible change group (conflicts / staged / changes / untracked). */
    function ChangeGroup(props) {
      const collapsed = props.collapsed === true;
      return h(
        'section',
        { className: 'dg-group' },
        h(
          'div',
          { className: 'dg-group-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dg-group-toggle',
              'aria-expanded': collapsed !== true,
              onClick: props.onToggle,
            },
            h('span', { className: 'dg-caret' + (collapsed ? '' : ' dg-caret-open'), 'aria-hidden': 'true' }, '▸'),
            h('span', { className: 'dg-group-title' }, props.title),
            typeof props.count === 'number' && props.count > 0
              ? h('span', { className: 'dg-count' }, String(props.count))
              : null,
          ),
          props.action === null || props.action === undefined
            ? null
            : h('button', { type: 'button', className: 'dg-group-action', onClick: props.action.onClick }, props.action.label),
        ),
        collapsed ? null : h('div', null, props.children),
      );
    }

    /** One changed file: status letter, middle-ellipsized name, hover actions. */
    function FileRow(props) {
      const t = props.t;
      const entry = props.entry !== null && typeof props.entry === 'object' ? props.entry : {};
      const path = typeof entry.path === 'string' ? entry.path : '';
      const origPath = typeof entry.origPath === 'string' ? entry.origPath : '';
      const label = origPath !== '' && origPath !== path ? origPath + ' → ' + path : path;
      const letter = statusLetter(entry);
      const tone = statusTone(letter);
      const actions = [];
      if (props.conflicted === true) {
        actions.push(
          h(MiniButton, { key: 'resolve', label: t('action.resolve'), onClick: props.onOpen }, h('span', { className: 'dg-tone-mod' }, '⇄')),
        );
      } else if (props.staged === true) {
        actions.push(h(MiniButton, { key: 'unstage', label: t('action.unstage'), onClick: props.onUnstage }, h(MinusIcon, { size: 11 })));
      } else {
        actions.push(h(MiniButton, { key: 'stage', label: t('action.stage'), onClick: props.onStage }, h(PlusIcon, { size: 11 })));
        actions.push(h(MiniButton, { key: 'discard', label: t('action.discard'), onClick: props.onDiscard }, h(TrashIcon, { size: 11 })));
      }
      return h(
        'div',
        {
          className: 'dg-row',
          role: 'button',
          tabIndex: 0,
          title: label,
          onClick: props.onOpen,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              props.onOpen();
            }
          },
        },
        h('span', { className: 'dg-letter dg-tone-' + tone }, letter),
        h('span', { className: 'dg-name' }, middleEllipsis(label, 38)),
        h('span', { className: 'dg-row-actions' }, actions),
      );
    }

    /** `+a −b` rows for a commit's key/value block. */
    function kvRows(entries) {
      const out = [];
      for (const entry of entries) {
        if (entry === null || entry === undefined) continue;
        const key = entry[0];
        const value = entry[1];
        if (typeof value !== 'string' || value === '') continue;
        out.push(h('span', { key: 'k:' + key, className: 'dg-kv-key' }, key));
        out.push(h('span', { key: 'v:' + key, className: 'dg-kv-val' }, value));
      }
      return out;
    }

    // ---------------------------------------------------------------------
    // 9. Views: diff, commit detail, operation banner, commit box
    // ---------------------------------------------------------------------

    /** A unified diff for one path (working tree, index or a revision). */
    function DiffView(props) {
      const ui = props.ui;
      const t = ui.t;
      const target = props.target !== null && typeof props.target === 'object' ? props.target : {};
      const path = typeof target.path === 'string' ? target.path : '';
      const staged = target.staged === true;
      const rev = typeof target.rev === 'string' && target.rev !== '' ? target.rev : undefined;
      const conflict = target.conflict === true;
      const key = ui.repo + '|' + path + '|' + (staged ? '1' : '0') + '|' + String(rev === undefined ? '' : rev) + '|' + String(ui.version);
      const state = useAsync(true, key, () => ui.api('diff', { path, staged: staged ? true : undefined, rev, context: 3 }));
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const files = Array.isArray(value.files) ? value.files : [];
      const text = typeof value.text === 'string' ? value.text : '';
      const rows = classifyDiffLines(text);
      const shown = rows.slice(0, DIFF_LINE_LIMIT);
      const clipped = rows.length > DIFF_LINE_LIMIT;
      const first = files.length > 0 && files[0] !== null && typeof files[0] === 'object' ? files[0] : {};
      const binary = files.some((file) => file !== null && typeof file === 'object' && file.binary === true);
      const stat = Number.isFinite(first.added) || Number.isFinite(first.removed) ? formatDiffStat(first.added, first.removed) : '';
      const runStage = () => {
        void ui
          .runAction(staged ? t('action.unstage') : t('action.stage'), () =>
            ui.api(staged ? 'unstage' : 'stage', { paths: [path] }),
          )
          .catch(noop);
      };
      const resolve = (side) => {
        void ui
          .runAction(t('action.resolve'), () => ui.api('conflict.resolve', { path, side }))
          .then(() => {
            props.onBack();
          })
          .catch(noop);
      };
      return h(
        'div',
        { className: 'dg-diff' },
        h(
          'div',
          { className: 'dg-diff-head' },
          h(IconButton, { label: t('common.back'), onClick: props.onBack }, h(BackIcon, { size: 13 })),
          h('span', { className: 'dg-diff-path' }, path === '' ? t('diff.title') : h(FilePathLabel, { path })),
          stat !== '' ? h('span', { className: 'dg-meta-item dg-name-dim' }, stat) : null,
          rev === undefined && path !== ''
            ? h(TextButton, { onClick: runStage }, staged ? t('diff.unstageFile') : t('diff.stageFile'))
            : null,
        ),
        h(
          'div',
          { className: 'dg-diff-body' },
          state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
          conflict
            ? h(
                'div',
                { className: 'dg-btnrow' },
                h(TextButton, { onClick: () => resolve('ours') }, t('action.resolveOurs')),
                h(TextButton, { onClick: () => resolve('theirs') }, t('action.resolveTheirs')),
              )
            : null,
          state.status === 'loading' && rows.length === 0 ? h('div', { className: 'dg-hint' }, t('common.loading')) : null,
          binary ? h('div', { className: 'dg-note' }, t('diff.binary')) : null,
          state.status === 'ready' && binary !== true && rows.length === 0
            ? h('div', { className: 'dg-hint' }, t('diff.empty'))
            : null,
          shown.map((line, index) =>
            h('span', { key: index, className: 'dg-line dg-line-' + line.kind }, line.text === '' ? ' ' : line.text),
          ),
          value.truncated === true ? h('div', { className: 'dg-note' }, t('diff.truncated')) : null,
          clipped ? h('div', { className: 'dg-note' }, t('diff.limit', { n: DIFF_LINE_LIMIT })) : null,
        ),
      );
    }

    /** Commit detail: metadata, full message and the changed files. */
    function CommitView(props) {
      const ui = props.ui;
      const t = ui.t;
      const hash = typeof props.hash === 'string' ? props.hash : '';
      const state = useAsync(true, ui.repo + '|show|' + hash, () => ui.api('show', { rev: hash }));
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const commit = value.commit !== null && typeof value.commit === 'object' ? value.commit : {};
      const body = typeof value.body === 'string' ? value.body : '';
      const files = Array.isArray(value.files) ? value.files : [];
      const parents = Array.isArray(commit.parents) ? commit.parents : [];
      const author = typeof commit.author === 'string' ? commit.author : '';
      const email = typeof commit.authorEmail === 'string' ? commit.authorEmail : '';
      const authorText = email !== '' && author !== '' ? author + ' <' + email + '>' : author !== '' ? author : email;
      return h(
        'div',
        { className: 'dg-diff' },
        h(
          'div',
          { className: 'dg-diff-head' },
          h(IconButton, { label: t('common.back'), onClick: props.onBack }, h(BackIcon, { size: 13 })),
          h('span', { className: 'dg-diff-path' }, t('history.detail')),
          h('span', { className: 'dg-meta-item dg-name-dim' }, shortHash(typeof commit.hash === 'string' ? commit.hash : hash)),
        ),
        h(
          'div',
          { className: 'dg-diff-body' },
          state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
          state.status === 'loading' && state.value === null
            ? h('div', { className: 'dg-hint' }, t('history.loading'))
            : null,
          h(
            'div',
            { className: 'dg-commit-card' },
            h('p', { className: 'dg-commit-subject' }, typeof commit.subject === 'string' ? commit.subject : hash),
            h(
              'div',
              { className: 'dg-kv' },
              ...kvRows([
                [t('history.hash'), typeof commit.hash === 'string' ? commit.hash : hash],
                [t('history.author'), authorText],
                [t('history.date'), formatDate(commit.date)],
                [t('history.parents'), parents.map((parent) => shortHash(parent)).join(' ')],
              ]),
            ),
            body !== '' ? h('pre', { className: 'dg-pre' }, body) : null,
            files.length > 0 ? h('div', { className: 'dg-hint' }, t('history.files')) : null,
            files.map((file, index) => {
              const entry = file !== null && typeof file === 'object' ? file : {};
              const filePath = typeof entry.path === 'string' ? entry.path : '';
              const letter = statusLetter(entry);
              const open = () => ui.openDiff({ path: filePath, rev: hash, back: { kind: 'commit', hash } });
              return h(
                'div',
                {
                  key: String(index) + ':' + filePath,
                  className: 'dg-listrow',
                  role: 'button',
                  tabIndex: 0,
                  title: filePath,
                  onClick: open,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      open();
                    }
                  },
                },
                h('span', { className: 'dg-letter dg-tone-' + statusTone(letter) }, letter),
                h(
                  'span',
                  { className: 'dg-listmain' },
                  h('span', { className: 'dg-listtitle dg-listtitle-path' }, h(FilePathLabel, { path: filePath })),
                ),
                Number.isFinite(entry.added) || Number.isFinite(entry.removed)
                  ? h('span', { className: 'dg-meta-item dg-name-dim' }, formatDiffStat(entry.added, entry.removed))
                  : null,
              );
            }),
            files.length > 0
              ? h(
                  'div',
                  { className: 'dg-btnrow' },
                  h(
                    TextButton,
                    { onClick: () => ui.openDiff({ rev: hash, back: { kind: 'commit', hash } }) },
                    t('history.viewAll'),
                  ),
                )
              : null,
            value.truncated === true ? h('div', { className: 'dg-note' }, t('diff.truncated')) : null,
          ),
        ),
      );
    }

    /** Banner shown while a merge / rebase / cherry-pick / revert / bisect runs. */
    function OperationBanner(props) {
      const t = props.t;
      const operation = props.operation !== null && typeof props.operation === 'object' ? props.operation : null;
      if (operation === null) return null;
      const kind = typeof operation.kind === 'string' ? operation.kind : '';
      const keys = {
        merge: 'operation.merge',
        rebase: 'operation.rebase',
        'cherry-pick': 'operation.cherryPick',
        revert: 'operation.revert',
        bisect: 'operation.bisect',
      };
      const label = t(keys[kind] === undefined ? 'operation.merge' : keys[kind]);
      const detail = typeof operation.detail === 'string' ? operation.detail.trim() : '';
      const canSkip = kind === 'rebase' || kind === 'cherry-pick';
      const run = (action) => {
        void props
          .runAction(label, () => props.api('operation.' + action))
          .catch(noop);
      };
      return h(
        'div',
        { className: 'dg-banner' },
        h('span', { className: 'dg-banner-text' }, detail === '' ? label : label + ' · ' + detail),
        h(TextButton, { onClick: () => run('continue'), disabled: props.busy === true }, t('operation.continue')),
        canSkip ? h(TextButton, { onClick: () => run('skip'), disabled: props.busy === true }, t('operation.skip')) : null,
        h(TextButton, { onClick: () => run('abort'), disabled: props.busy === true, danger: true }, t('operation.abort')),
      );
    }

    /** Message box, primary commit button and the extra commit actions. */
    function CommitBox(props) {
      const t = props.t;
      const message = typeof props.message === 'string' ? props.message : '';
      const textEmpty = message.trim() === '';
      const mainDisabled = textEmpty || props.stagedCount === 0 || props.busy === true;
      const onKeyDown = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          if (!mainDisabled) props.onCommit('commit');
        }
      };
      const items = [
        { key: 'commitPush', label: t('action.commitPush'), disabled: textEmpty || props.busy === true, onSelect: () => props.onCommit('commitPush') },
        { key: 'commitSync', label: t('action.commitSync'), disabled: textEmpty || props.busy === true, onSelect: () => props.onCommit('commitSync') },
        { key: 'amend', label: t('action.amend'), disabled: textEmpty || props.busy === true, onSelect: () => props.onCommit('amend') },
        { key: 'stageAllCommit', label: t('action.stageAllCommit'), disabled: textEmpty || props.busy === true, onSelect: () => props.onCommit('stageAll') },
      ];
      return h(
        'div',
        { className: 'dg-commit' },
        h('textarea', {
          className: 'dg-textarea',
          value: message,
          rows: 3,
          spellCheck: false,
          placeholder: t('action.commitPlaceholder'),
          'aria-label': t('action.commit'),
          onChange: (event) => props.onMessage(event.target.value),
          onKeyDown,
        }),
        h(
          'div',
          { className: 'dg-commit-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'dg-primary',
              disabled: mainDisabled,
              onClick: () => props.onCommit('commit'),
            },
            t('action.commit'),
          ),
          h(
            PopoverMenu,
            { label: t('action.commitMenu'), disabled: props.busy === true, items },
            h(ChevronIcon, { size: 13 }),
          ),
        ),
        h(
          'div',
          { className: 'dg-hint' },
          props.stagedCount > 0
            ? t('commit.stagedCount', { n: props.stagedCount })
            : t('commit.emptyHint'),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 10. Collapsible sections
    // ---------------------------------------------------------------------

    /**
     * One row of a section list: title, optional subtitle, optional trailing
     * badge and a compact action cluster.
     */
    function ListRow(props) {
      const clickable = typeof props.onClick === 'function';
      const interactive = clickable
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: props.onClick,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                props.onClick();
              }
            },
          }
        : {};
      return h(
        'div',
        Object.assign({ className: 'dg-listrow' }, interactive),
        h(
          'span',
          { className: 'dg-listmain' },
          h('span', { className: 'dg-listtitle', title: props.title }, props.title),
          typeof props.subtitle === 'string' && props.subtitle !== ''
            ? h('span', { className: 'dg-listsub' }, props.subtitle)
            : null,
        ),
        props.trailing || null,
        Array.isArray(props.actions) && props.actions.length > 0
          ? h('span', { className: 'dg-listactions' }, props.actions)
          : null,
      );
    }

    function branchMeta(branch) {
      const parts = [];
      if (typeof branch.upstream === 'string' && branch.upstream !== '') parts.push(branch.upstream);
      if (typeof branch.ahead === 'number' && branch.ahead > 0) parts.push('↑' + branch.ahead);
      if (typeof branch.behind === 'number' && branch.behind > 0) parts.push('↓' + branch.behind);
      return parts.join(' · ');
    }

    function BranchesSection(props) {
      const ui = props.ui;
      const t = ui.t;
      const open = props.open === true;
      const repo = ui.repo;
      const state = useAsync(open, repo + '|branches|' + ui.version, () =>
        ui.api('branches.list', { includeRemote: false }),
      );
      const [query, setQuery] = React.useState('');
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const current = typeof value.current === 'string' ? value.current : '';
      const branches = Array.isArray(value.branches) ? value.branches : [];
      const needle = query.trim().toLowerCase();
      const visible =
        needle === ''
          ? branches
          : branches.filter((branch) => {
              const name = branch !== null && typeof branch === 'object' && typeof branch.name === 'string' ? branch.name : '';
              return name.toLowerCase().indexOf(needle) >= 0;
            });

      const createBranch = () => {
        ui.askForm({
          title: t('branch.create'),
          submitLabel: t('branch.create'),
          fields: [
            { name: 'name', label: t('branch.name'), required: true, placeholder: t('branch.namePlaceholder') },
            { name: 'startPoint', label: t('branch.startPoint'), placeholder: t('branch.startPointPlaceholder') },
            { name: 'checkout', label: t('branch.checkoutAfter'), type: 'checkbox' },
          ],
          onSubmit: (values) =>
            ui.runAction(t('branch.create'), () =>
              ui.api('branch.create', {
                name: values.name,
                startPoint: values.startPoint === '' ? undefined : values.startPoint,
                checkout: values.checkout === true,
              }),
            ),
        });
      };

      const renameBranch = (branch) => {
        ui.askForm({
          title: t('branch.rename'),
          submitLabel: t('branch.rename'),
          fields: [{ name: 'to', label: t('branch.newName'), required: true, value: branch.name }],
          onSubmit: (values) =>
            ui.runAction(t('branch.rename'), () =>
              ui.api('branch.rename', { from: branch.name, to: values.to }),
            ),
        });
      };

      const deleteBranch = (branch) => {
        const remove = (force) =>
          ui.runAction(t('branch.delete'), () =>
            ui.api('branch.delete', {
              name: branch.name,
              force: force === true ? true : undefined,
              confirm: true,
            }),
          );
        ui.askConfirm({
          title: t('branch.delete'),
          body: t('confirm.deleteBranch', { name: branch.name }),
          submitLabel: t('branch.delete'),
          danger: true,
          onSubmit: () =>
            remove(false).catch((failure) => {
              const code =
                failure !== null && typeof failure === 'object' && typeof failure.code === 'string'
                  ? failure.code
                  : '';
              if (code !== 'E_BRANCH_NOT_MERGED') throw failure;
              // Not a dead end: git refused because commits would be lost, so
              // offer the force path with the reason in front of the reader.
              ui.dismissError();
              ui.askConfirm({
                title: t('branch.deleteForce'),
                body: t('confirm.forceDeleteBranch', { name: branch.name }),
                submitLabel: t('branch.deleteForce'),
                danger: true,
                onSubmit: () => remove(true),
              });
            }),
        });
      };

      const checkoutBranch = (branch) => {
        if (branch.current === true) return;
        void ui
          .runAction(t('branch.checkout'), () => ui.api('branch.checkout', { name: branch.name }))
          .catch(noop);
      };

      const setUpstream = (branch) => {
        ui.askForm({
          title: t('branch.upstream'),
          submitLabel: t('common.confirm'),
          fields: [
            {
              name: 'upstream',
              label: t('branch.upstreamName'),
              required: true,
              placeholder: t('branch.upstreamPlaceholder'),
              value: typeof branch.upstream === 'string' ? branch.upstream : '',
            },
          ],
          onSubmit: (values) =>
            ui.runAction(t('branch.upstream'), () =>
              ui.api('branch.setUpstream', { branch: branch.name, upstream: values.upstream }),
            ),
        });
      };

      const rows = visible.map((branch) => {
        const name = typeof branch.name === 'string' ? branch.name : '';
        return h(ListRow, {
          key: name,
          title: name,
          subtitle: branchMeta(branch),
          onClick: () => checkoutBranch(branch),
          trailing:
            branch.current === true ? h('span', { className: 'dg-current' }, t('branch.current')) : null,
          actions: [
            h(MiniButton, { key: 'up', label: t('branch.upstream'), onClick: () => setUpstream(branch) }, '⇡'),
            h(MiniButton, { key: 'rename', label: t('branch.rename'), onClick: () => renameBranch(branch) }, '✎'),
            h(
              MiniButton,
              { key: 'delete', label: t('branch.delete'), onClick: () => deleteBranch(branch) },
              h(CloseIcon, { size: 11 }),
            ),
          ],
        });
      });

      const actions = [
        h(IconButton, { key: 'create', label: t('branch.create'), onClick: createBranch }, h(PlusIcon, { size: 13 })),
        h(IconButton, { key: 'reload', label: t('repo.refresh'), onClick: state.reload }, h(RefreshIcon, { size: 13 })),
      ];

      return h(
        SectionShell,
        { title: t('branch.title'), count: branches.length, open, onToggle: props.onToggle, actions },
        branches.length > 6
          ? h('input', {
              className: 'dg-input',
              value: query,
              placeholder: t('branch.search'),
              'aria-label': t('branch.search'),
              onChange: (event) => setQuery(event.target.value),
            })
          : null,
        state.status === 'loading' && branches.length === 0
          ? h('div', { className: 'dg-hint' }, t('common.loading'))
          : null,
        state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
        state.status === 'ready' && branches.length === 0
          ? h('div', { className: 'dg-hint' }, t('branch.empty'))
          : null,
        rows.length > 0 ? h('div', null, rows) : null,
        current !== '' && needle !== '' && rows.length === 0
          ? h('div', { className: 'dg-hint' }, t('branch.noMatch'))
          : null,
      );
    }

    function HistorySection(props) {
      const ui = props.ui;
      const t = ui.t;
      const open = props.open === true;
      const repo = ui.repo;
      const version = ui.version;
      const uiRef = useLatest(ui);
      const [items, setItems] = React.useState([]);
      const [hasMore, setHasMore] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        setLoading(true);
        setError(null);
        uiRef.current
          .api('log', { limit: LOG_PAGE, skip: 0 })
          .then((value) => {
            if (cancelled) return;
            setItems(Array.isArray(value && value.commits) ? value.commits : []);
            setHasMore(value !== null && typeof value === 'object' && value.hasMore === true);
            setLoading(false);
          })
          .catch((cause) => {
            if (cancelled) return;
            setItems([]);
            setHasMore(false);
            setError(cause);
            setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [open, repo, version, uiRef]);

      const loadMore = () => {
        if (loading) return;
        setLoading(true);
        uiRef.current
          .api('log', { limit: LOG_PAGE, skip: items.length })
          .then((value) => {
            setItems((previous) => previous.concat(Array.isArray(value && value.commits) ? value.commits : []));
            setHasMore(value !== null && typeof value === 'object' && value.hasMore === true);
            setLoading(false);
          })
          .catch((cause) => {
            setError(cause);
            setLoading(false);
          });
      };

      const rows = items.map((commit) => {
        const hash = typeof commit.hash === 'string' ? commit.hash : '';
        const subject = typeof commit.subject === 'string' ? commit.subject : hash;
        const parts = [];
        if (typeof commit.author === 'string' && commit.author !== '') parts.push(commit.author);
        if (commit.date !== undefined && commit.date !== null) parts.push(formatDate(commit.date));
        if (hash !== '') parts.push(shortHash(hash));
        return h(ListRow, {
          key: hash,
          title: subject,
          subtitle: parts.join(' · '),
          onClick: () => ui.openCommit(hash),
          trailing:
            typeof commit.refs === 'string' && commit.refs !== ''
              ? h('span', { className: 'dg-current', title: commit.refs }, commit.refs)
              : null,
        });
      });

      const actions = [
        h(IconButton, { key: 'reload', label: t('repo.refresh'), onClick: () => setItems([]) || loadMore() }, h(RefreshIcon, { size: 13 })),
      ];

      return h(
        SectionShell,
        { title: t('history.title'), count: items.length, open, onToggle: props.onToggle, actions },
        state_loading_hint(loading, items.length, t),
        error !== null ? h(ErrorBar, { error, t, onRetry: loadMore }) : null,
        !loading && items.length === 0 && error === null
          ? h('div', { className: 'dg-hint' }, t('history.empty'))
          : null,
        rows.length > 0 ? h('div', null, rows) : null,
        hasMore
          ? h(
              'div',
              { className: 'dg-btnrow' },
              h(TextButton, { onClick: loadMore, disabled: loading }, t('history.loadMore')),
            )
          : null,
      );
    }

    /**
     * Small shared "loading" hint used by section bodies.
     */
    function state_loading_hint(loading, count, t) {
      return loading && count === 0 ? h('div', { className: 'dg-hint' }, t('common.loading')) : null;
    }

    function StashSection(props) {
      const ui = props.ui;
      const t = ui.t;
      const open = props.open === true;
      const repo = ui.repo;
      const state = useAsync(open, repo + '|stash|' + ui.version, () => ui.api('stash.list'));
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const entries = Array.isArray(value.entries) ? value.entries : [];

      const pushStash = () => {
        ui.askForm({
          title: t('stash.push'),
          submitLabel: t('stash.push'),
          fields: [
            { name: 'message', label: t('stash.message'), placeholder: t('stash.messagePlaceholder') },
            { name: 'includeUntracked', label: t('stash.includeUntracked'), type: 'checkbox' },
          ],
          onSubmit: (values) =>
            ui.runAction(t('stash.push'), () =>
              ui.api('stash.push', {
                message: values.message === '' ? undefined : values.message,
                includeUntracked: values.includeUntracked === true,
              }),
            ),
        });
      };

      const applyStash = (entry, pop) => {
        void ui
          .runAction(t(pop ? 'stash.pop' : 'stash.apply'), () =>
            ui.api(pop ? 'stash.pop' : 'stash.apply', { index: entry.index }),
          )
          .catch(noop);
      };

      const dropStash = (entry) => {
        ui.askConfirm({
          title: t('stash.drop'),
          body: t('confirm.dropStash'),
          submitLabel: t('stash.drop'),
          danger: true,
          onSubmit: () =>
            ui.runAction(t('stash.drop'), () => ui.api('stash.drop', { index: entry.index })),
        });
      };

      const rows = entries.map((entry) => {
        const message =
          typeof entry.message === 'string' && entry.message !== ''
            ? entry.message
            : typeof entry.ref === 'string'
              ? entry.ref
              : String(entry.index);
        return h(ListRow, {
          key: String(entry.index) + ':' + message,
          title: message,
          subtitle: entry.date === undefined || entry.date === null ? '' : formatDate(entry.date),
          actions: [
            h(MiniButton, { key: 'apply', label: t('stash.apply'), onClick: () => applyStash(entry, false) }, '↧'),
            h(MiniButton, { key: 'pop', label: t('stash.pop'), onClick: () => applyStash(entry, true) }, '↥'),
            h(MiniButton, { key: 'drop', label: t('stash.drop'), onClick: () => dropStash(entry) }, h(TrashIcon, { size: 11 })),
          ],
        });
      });

      const actions = [
        h(IconButton, { key: 'push', label: t('stash.push'), onClick: pushStash }, h(PlusIcon, { size: 13 })),
        h(IconButton, { key: 'reload', label: t('repo.refresh'), onClick: state.reload }, h(RefreshIcon, { size: 13 })),
      ];

      return h(
        SectionShell,
        { title: t('stash.title'), count: entries.length, open, onToggle: props.onToggle, actions },
        state_loading_hint(state.status === 'loading', entries.length, t),
        state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
        state.status === 'ready' && entries.length === 0
          ? h('div', { className: 'dg-hint' }, t('stash.empty'))
          : null,
        rows.length > 0 ? h('div', null, rows) : null,
      );
    }

    function TagsSection(props) {
      const ui = props.ui;
      const t = ui.t;
      const open = props.open === true;
      const repo = ui.repo;
      const state = useAsync(open, repo + '|tags|' + ui.version, () => ui.api('tag.list'));
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const tags = Array.isArray(value.tags) ? value.tags : [];

      const createTag = () => {
        ui.askForm({
          title: t('tag.create'),
          submitLabel: t('tag.create'),
          fields: [
            { name: 'name', label: t('tag.name'), required: true, placeholder: t('tag.namePlaceholder') },
            { name: 'message', label: t('tag.message'), placeholder: t('tag.messagePlaceholder') },
            { name: 'rev', label: t('tag.rev'), placeholder: t('tag.revPlaceholder') },
          ],
          onSubmit: (values) =>
            ui.runAction(t('tag.create'), () =>
              ui.api('tag.create', {
                name: values.name,
                message: values.message === '' ? undefined : values.message,
                rev: values.rev === '' ? undefined : values.rev,
              }),
            ),
        });
      };

      const deleteTag = (tag) => {
        ui.askConfirm({
          title: t('tag.delete'),
          body: t('confirm.deleteTag', { name: tag.name }),
          submitLabel: t('tag.delete'),
          danger: true,
          onSubmit: () => ui.runAction(t('tag.delete'), () => ui.api('tag.delete', { name: tag.name })),
        });
      };

      const pushTag = (tag) => {
        void ui
          .runAction(t('tag.push'), () => ui.api('tag.push', { name: tag.name }))
          .catch(noop);
      };

      const rows = tags.map((tag) => {
        const name = typeof tag.name === 'string' ? tag.name : '';
        const parts = [];
        if (tag.date !== undefined && tag.date !== null) parts.push(formatDate(tag.date));
        if (typeof tag.message === 'string' && tag.message !== '') parts.push(tag.message);
        return h(ListRow, {
          key: name,
          title: name,
          subtitle: parts.join(' · '),
          actions: [
            h(MiniButton, { key: 'push', label: t('tag.push'), onClick: () => pushTag(tag) }, '⇡'),
            h(MiniButton, { key: 'delete', label: t('tag.delete'), onClick: () => deleteTag(tag) }, h(CloseIcon, { size: 11 })),
          ],
        });
      });

      const actions = [
        h(IconButton, { key: 'create', label: t('tag.create'), onClick: createTag }, h(PlusIcon, { size: 13 })),
        h(IconButton, { key: 'reload', label: t('repo.refresh'), onClick: state.reload }, h(RefreshIcon, { size: 13 })),
      ];

      return h(
        SectionShell,
        { title: t('tag.title'), count: tags.length, open, onToggle: props.onToggle, actions },
        state_loading_hint(state.status === 'loading', tags.length, t),
        state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
        state.status === 'ready' && tags.length === 0 ? h('div', { className: 'dg-hint' }, t('tag.empty')) : null,
        rows.length > 0 ? h('div', null, rows) : null,
      );
    }

    function RemotesSection(props) {
      const ui = props.ui;
      const t = ui.t;
      const open = props.open === true;
      const repo = ui.repo;
      const state = useAsync(open, repo + '|remotes|' + ui.version, () => ui.api('remote.list'));
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const remotes = Array.isArray(value.remotes) ? value.remotes : [];

      const addRemote = () => {
        ui.askForm({
          title: t('remote.add'),
          submitLabel: t('remote.add'),
          fields: [
            { name: 'name', label: t('remote.name'), required: true, placeholder: t('remote.namePlaceholder') },
            { name: 'url', label: t('remote.url'), required: true, placeholder: t('remote.urlPlaceholder') },
          ],
          onSubmit: (values) =>
            ui.runAction(t('remote.add'), () =>
              ui.api('remote.add', { name: values.name, url: values.url }),
            ),
        });
      };

      const setUrl = (remote) => {
        ui.askForm({
          title: t('remote.setUrl'),
          submitLabel: t('common.confirm'),
          fields: [
            {
              name: 'url',
              label: t('remote.url'),
              required: true,
              value: typeof remote.fetchUrl === 'string' ? remote.fetchUrl : typeof remote.url === 'string' ? remote.url : '',
            },
          ],
          onSubmit: (values) =>
            ui.runAction(t('remote.setUrl'), () =>
              ui.api('remote.setUrl', { name: remote.name, url: values.url }),
            ),
        });
      };

      const removeRemote = (remote) => {
        ui.askConfirm({
          title: t('remote.remove'),
          body: t('confirm.removeRemote', { name: remote.name }),
          submitLabel: t('remote.remove'),
          danger: true,
          onSubmit: () =>
            ui.runAction(t('remote.remove'), () => ui.api('remote.remove', { name: remote.name })),
        });
      };

      const rows = remotes.map((remote) => {
        const name = typeof remote.name === 'string' ? remote.name : '';
        const url =
          typeof remote.fetchUrl === 'string' && remote.fetchUrl !== ''
            ? remote.fetchUrl
            : typeof remote.url === 'string'
              ? remote.url
              : '';
        return h(ListRow, {
          key: name,
          title: name,
          subtitle: url,
          actions: [
            h(MiniButton, { key: 'url', label: t('remote.setUrl'), onClick: () => setUrl(remote) }, '✎'),
            h(MiniButton, { key: 'remove', label: t('remote.remove'), onClick: () => removeRemote(remote) }, h(CloseIcon, { size: 11 })),
          ],
        });
      });

      const actions = [
        h(IconButton, { key: 'add', label: t('remote.add'), onClick: addRemote }, h(PlusIcon, { size: 13 })),
        h(IconButton, { key: 'reload', label: t('repo.refresh'), onClick: state.reload }, h(RefreshIcon, { size: 13 })),
      ];

      return h(
        SectionShell,
        { title: t('remote.title'), count: remotes.length, open, onToggle: props.onToggle, actions },
        state_loading_hint(state.status === 'loading', remotes.length, t),
        state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
        state.status === 'ready' && remotes.length === 0
          ? h('div', { className: 'dg-hint' }, t('remote.empty'))
          : null,
        rows.length > 0 ? h('div', null, rows) : null,
      );
    }

    function SubmodulesSection(props) {
      const ui = props.ui;
      const t = ui.t;
      const open = props.open === true;
      const repo = ui.repo;
      const state = useAsync(open, repo + '|submodules|' + ui.version, () => ui.api('submodule.list'));
      const value = state.value !== null && typeof state.value === 'object' ? state.value : {};
      const submodules = Array.isArray(value.submodules) ? value.submodules : [];

      const updateAll = () => {
        void ui
          .runAction(t('submodule.update'), async () => {
            const result = await ui.api('submodule.update');
            const output = result !== null && typeof result === 'object' && typeof result.output === 'string' ? result.output.trim() : '';
            if (output !== '') ui.notify(output.slice(0, 400));
            return result;
          })
          .catch(noop);
      };

      const rows = submodules.map((submodule) => {
        const path = typeof submodule.path === 'string' ? submodule.path : '';
        const parts = [];
        if (typeof submodule.state === 'string' && submodule.state !== '') parts.push(submodule.state);
        if (typeof submodule.sha === 'string' && submodule.sha !== '') parts.push(shortHash(submodule.sha));
        if (typeof submodule.url === 'string' && submodule.url !== '') parts.push(submodule.url);
        return h(ListRow, { key: path, title: path, subtitle: parts.join(' · ') });
      });

      const actions = [
        h(IconButton, { key: 'update', label: t('submodule.update'), onClick: updateAll }, h(RefreshIcon, { size: 13 })),
        h(IconButton, { key: 'reload', label: t('repo.refresh'), onClick: state.reload }, h(RefreshIcon, { size: 13 })),
      ];

      return h(
        SectionShell,
        { title: t('submodule.title'), count: submodules.length, open, onToggle: props.onToggle, actions },
        state_loading_hint(state.status === 'loading', submodules.length, t),
        state.error !== null ? h(ErrorBar, { error: state.error, t, onRetry: state.reload }) : null,
        state.status === 'ready' && submodules.length === 0
          ? h('div', { className: 'dg-hint' }, t('submodule.empty'))
          : null,
        rows.length > 0 ? h('div', null, rows) : null,
      );
    }

    function RawSection(props) {
      const ui = props.ui;
      const t = ui.t;
      const [command, setCommand] = React.useState('');
      const [result, setResult] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [running, setRunning] = React.useState(false);

      const execute = (text) => {
        setRunning(true);
        setError(null);
        ui.api('raw', { command: text, confirm: true })
          .then((value) => {
            setResult(value !== null && typeof value === 'object' ? value : {});
            setRunning(false);
          })
          .catch((cause) => {
            setError(cause);
            setResult(null);
            setRunning(false);
          });
      };

      const run = () => {
        const text = command.trim();
        if (text === '' || running) return;
        if (isDestructiveRawCommand(text)) {
          ui.askConfirm({
            title: t('raw.title'),
            body: t('confirm.rawDanger', { command: text }),
            submitLabel: t('raw.run'),
            danger: true,
            onSubmit: () => execute(text),
          });
          return;
        }
        execute(text);
      };

      const output = result !== null && typeof result === 'object' ? result : {};
      const stdout = typeof output.stdout === 'string' ? output.stdout : '';
      const stderr = typeof output.stderr === 'string' ? output.stderr : '';
      const exitCode = typeof output.exitCode === 'number' ? output.exitCode : null;

      return h(
        SectionShell,
        { title: t('raw.title'), open: props.open === true, onToggle: props.onToggle },
        h('textarea', {
          className: 'dg-textarea',
          rows: 2,
          value: command,
          placeholder: t('raw.placeholder'),
          'aria-label': t('raw.title'),
          spellCheck: false,
          onChange: (event) => setCommand(event.target.value),
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              run();
            }
          },
        }),
        h(
          'div',
          { className: 'dg-btnrow' },
          h(TextButton, { onClick: run, disabled: running || command.trim() === '' }, t('raw.run')),
        ),
        error !== null ? h(ErrorBar, { error, t, onRetry: run }) : null,
        result !== null
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dg-hint' },
                t('raw.exitCode', { code: exitCode === null ? '-' : String(exitCode) }),
              ),
              stdout !== '' ? h('pre', { className: 'dg-pre' }, stdout) : null,
              stderr !== '' ? h('pre', { className: 'dg-pre dg-line-del' }, stderr) : null,
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // 11. Panel chrome: top bar, empty state, settings, dialogs
    // ---------------------------------------------------------------------

    function TopBar(props) {
      const t = props.t;
      const repos = Array.isArray(props.repos) ? props.repos : [];
      const status = props.status !== null && typeof props.status === 'object' ? props.status : null;
      const branch = status !== null && typeof status.branch === 'string' ? status.branch : '';
      const ahead = status !== null && typeof status.ahead === 'number' ? status.ahead : 0;
      const behind = status !== null && typeof status.behind === 'number' ? status.behind : 0;
      const changed = typeof props.changedCount === 'number' ? props.changedCount : 0;
      const branchLabel =
        status === null
          ? ''
          : status.detached === true
            ? t('repo.detached')
            : status.unborn === true
              ? t('repo.unborn')
              : branch;
      const stashCount = status !== null && typeof status.stashCount === 'number' ? status.stashCount : 0;

      return h(
        'div',
        { className: 'dg-top' },
        h(
          'select',
          {
            className: 'dg-select',
            value: props.repo,
            'aria-label': t('repo.select'),
            title: t('repo.select'),
            onChange: (event) => props.onSelect(event.target.value),
          },
          repos.length === 0 ? h('option', { value: '' }, t('repo.none')) : null,
          repos.map((repo) =>
            h('option', { key: repo.path, value: repo.path }, repoOptionLabel(repo, t)),
          ),
        ),
        h(
          'div',
          { className: 'dg-anchor' },
          h(
            IconButton,
            { label: t('repo.fetch'), title: t('repo.fetch'), disabled: props.busy, onClick: props.onFetch },
            h(FetchIcon, { size: 14 }),
          ),
        ),
        h(
          'div',
          { className: 'dg-anchor' },
          h(
            IconButton,
            { label: t('repo.pull'), title: t('repo.pull'), disabled: props.busy, onClick: props.onPull },
            behind > 0 ? h('span', { className: 'dg-syncbadge' }, String(behind)) : null,
            h(PullIcon, { size: 14 }),
          ),
        ),
        h(PopoverMenu, {
          label: t('repo.push'),
          title: t('repo.push'),
          direction: 'down',
          disabled: props.busy,
          items: [
            { key: 'push', label: t('repo.push'), onSelect: props.onPush },
            { key: 'force', label: t('repo.forcePush'), danger: true, onSelect: props.onForcePush },
          ],
          children: [
            ahead > 0 ? h('span', { key: 'badge', className: 'dg-syncbadge' }, String(ahead)) : null,
            h(PushIcon, { key: 'icon', size: 14 }),
          ],
        }),
        h(
          'div',
          { className: 'dg-anchor' },
          h(
            IconButton,
            { label: t('repo.refresh'), title: t('repo.refresh'), disabled: props.busy, onClick: props.onRefresh },
            h(RefreshIcon, { size: 14 }),
          ),
        ),
        h(
          'div',
          { className: 'dg-anchor' },
          h(
            IconButton,
            {
              label: t('repo.settings'),
              title: t('repo.settings'),
              active: props.settingsOpen === true,
              onClick: props.onSettings,
            },
            h(SettingsIcon, { size: 14 }),
          ),
        ),
        h(
          'div',
          { className: 'dg-meta' },
          branchLabel !== '' ? h('span', { className: 'dg-meta-branch', title: branchLabel }, branchLabel) : null,
          status !== null && (ahead > 0 || behind > 0)
            ? h(
                'span',
                { className: 'dg-meta-item' },
                t('repo.aheadBehind', { ahead: String(ahead), behind: String(behind) }),
              )
            : null,
          h('span', { className: 'dg-meta-spacer' }),
          changed > 0 ? h('span', { className: 'dg-meta-item-optional' }, t('repo.changed', { n: String(changed) })) : null,
          stashCount > 0
            ? h('span', { className: 'dg-meta-item' }, t('repo.stashCount', { n: String(stashCount) }))
            : null,
        ),
      );
    }

    function EmptyState(props) {
      const t = props.t;
      const roots = Array.isArray(props.roots) ? props.roots : [];
      const suggestions = Array.isArray(props.suggestedRoots) ? props.suggestedRoots : [];
      const root = roots.length > 0 && typeof roots[0] === 'string' ? roots[0] : '';
      const [path, setPath] = React.useState(root);
      React.useEffect(() => {
        setPath((previous) => (previous === '' ? root : previous));
      }, [root]);
      const trimmed = path.trim();
      return h(
        'div',
        { className: 'dg-empty' },
        h('span', { className: 'dg-empty-icon' }, h(GitIcon, { size: 40 })),
        h('p', { className: 'dg-empty-title' }, t('repo.none')),
        h(
          'p',
          { className: 'dg-empty-body' },
          props.scanning === true ? t('empty.scanning') : t('empty.body'),
        ),
        h('input', {
          className: 'dg-input',
          value: path,
          placeholder: t('empty.pathPlaceholder'),
          'aria-label': t('empty.path'),
          spellCheck: false,
          onChange: (event) => setPath(event.target.value),
        }),
        h(
          'div',
          { className: 'dg-empty-actions' },
          h(TextButton, { onClick: () => props.onInit(trimmed), disabled: trimmed === '' }, t('repo.init')),
          h(TextButton, { onClick: () => props.onAdd(trimmed), disabled: trimmed === '' }, t('repo.add')),
          h(TextButton, { onClick: props.onSettings }, t('repo.settings')),
        ),
        h('p', { className: 'dg-hint' }, t('empty.addHint')),
        suggestions.length > 0
          ? h(
              'div',
              { className: 'dg-empty-suggest' },
              h('p', { className: 'dg-hint' }, t('empty.suggestHint')),
              suggestions.map((item) =>
                h(
                  TextButton,
                  { key: item.path, onClick: () => props.onAddSuggestion(item.path) },
                  t('empty.suggest', { path: item.path, n: String(item.count) }),
                ),
              ),
            )
          : null,
        roots.length > 0 ? h('p', { className: 'dg-hint dg-empty-scanned' }, t('empty.scanned', { list: roots.join(' · ') })) : null,
        props.truncated === true ? h('p', { className: 'dg-hint' }, t('empty.truncated')) : null,
        props.error !== null && props.error !== undefined
          ? h(ErrorBar, { error: props.error, t })
          : null,
      );
    }

    function SettingsOverlay(props) {
      const t = props.t;
      const settings = props.settings;
      const [draft, setDraft] = React.useState(() => ({
        scanDepth: String(settings.scanDepth),
        roots: settings.roots.join('\n'),
        autoDetection: settings.autoDetection,
        pullStrategy: settings.pullStrategy,
        extraRoots: loadExtraRoots().join('\n'),
      }));
      const [notice, setNotice] = React.useState('');
      const set = (name, value) =>
        setDraft((previous) => Object.assign({}, previous, { [name]: value }));

      const save = () => {
        const next = normalizeSettings(draft);
        writeJson(STORE.settings, next);
        saveExtraRoots(splitPathList(draft.extraRoots));
        setNotice(t('settings.saved'));
        props.onSave(next);
      };

      const reset = () => {
        setDraft({
          scanDepth: String(DEFAULT_SETTINGS.scanDepth),
          roots: '',
          autoDetection: DEFAULT_SETTINGS.autoDetection,
          pullStrategy: DEFAULT_SETTINGS.pullStrategy,
          extraRoots: '',
        });
        setNotice('');
      };

      const select = (name, label, options) =>
        h(
          'label',
          { key: name, className: 'dg-field' },
          h('span', { className: 'dg-field-label' }, label),
          h(
            'select',
            {
              className: 'dg-small-select',
              value: draft[name],
              onChange: (event) => set(name, event.target.value),
            },
            options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
        );

      const area = (name, label, hint) =>
        h(
          'label',
          { key: name, className: 'dg-field' },
          h('span', { className: 'dg-field-label' }, label),
          h('textarea', {
            className: 'dg-textarea',
            rows: 2,
            value: draft[name],
            spellCheck: false,
            onChange: (event) => set(name, event.target.value),
          }),
          h('span', { className: 'dg-hint' }, hint),
        );

      return h(
        'div',
        {
          className: 'dg-scrim',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          'div',
          {
            className: 'dg-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('settings.title'),
            onKeyDown: (event) => {
              if (event.key === 'Escape') props.onClose();
            },
          },
          h('h2', { className: 'dg-card-title' }, t('settings.title')),
          h(
            'div',
            { className: 'dg-card-body' },
            h(
              'label',
              { className: 'dg-field' },
              h('span', { className: 'dg-field-label' }, t('settings.scanDepth')),
              h('input', {
                className: 'dg-input',
                type: 'number',
                min: 1,
                max: 10,
                value: draft.scanDepth,
                onChange: (event) => set('scanDepth', event.target.value),
              }),
              h('span', { className: 'dg-hint' }, t('settings.scanDepthHint')),
            ),
            area('roots', t('settings.roots'), t('settings.rootsHint')),
            select('autoDetection', t('settings.autoDetection'), [
              { value: 'true', label: t('settings.auto.true') },
              { value: 'false', label: t('settings.auto.false') },
              { value: 'subFolders', label: t('settings.auto.subFolders') },
            ]),
            select('pullStrategy', t('settings.pullStrategy'), [
              { value: 'merge', label: t('settings.pull.merge') },
              { value: 'rebase', label: t('settings.pull.rebase') },
              { value: 'ff-only', label: t('settings.pull.ffOnly') },
            ]),
            area('extraRoots', t('settings.extraRoots'), t('settings.extraRootsHint')),
            notice !== '' ? h('div', { className: 'dg-hint' }, notice) : null,
          ),
          h(
            'div',
            { className: 'dg-card-actions' },
            h(TextButton, { onClick: reset }, t('settings.reset')),
            h(TextButton, { onClick: props.onClose }, t('common.close')),
            h('button', { type: 'button', className: 'dg-primary', onClick: save }, t('settings.save')),
          ),
        ),
      );
    }

    /**
     * Build a client-side error object shaped like a Host business error so the
     * shared ErrorBar can render it.
     */
    function makeClientError(code, message, detail) {
      const error = new Error(message);
      error.code = code;
      error.detail = detail === undefined ? '' : detail;
      return error;
    }

    function TaskDialog(props) {
      const spec = props.spec !== null && typeof props.spec === 'object' ? props.spec : {};
      const t = props.t;
      const fields = Array.isArray(spec.fields) ? spec.fields : [];
      const [values, setValues] = React.useState(() => {
        const initial = {};
        for (const field of fields) {
          initial[field.name] = field.value !== undefined ? field.value : field.type === 'checkbox' ? false : '';
        }
        return initial;
      });
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const firstRef = React.useRef(null);

      React.useEffect(() => {
        const node = firstRef.current;
        if (node !== null && typeof node.focus === 'function') {
          node.focus();
          if (typeof node.select === 'function') node.select();
        }
      }, []);

      const submit = () => {
        if (busy) return;
        for (const field of fields) {
          const value = values[field.name];
          if (field.required === true && (typeof value !== 'string' || value.trim() === '')) {
            setError(makeClientError('E_INVALID_ARG', t('common.required', { name: field.label })));
            return;
          }
        }
        setBusy(true);
        setError(null);
        Promise.resolve()
          .then(() => spec.onSubmit(values))
          .then(
            () => {
              setBusy(false);
              props.onClose();
            },
            (cause) => {
              setError(cause);
              setBusy(false);
            },
          );
      };

      const renderField = (field, index) => {
        const value = values[field.name];
        const setValue = (next) =>
          setValues((previous) => Object.assign({}, previous, { [field.name]: next }));
        const inputRef = index === 0 ? firstRef : undefined;
        if (field.type === 'checkbox') {
          return h(
            'label',
            { key: field.name, className: 'dg-check' },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              onChange: (event) => setValue(event.target.checked),
            }),
            h('span', null, field.label),
          );
        }
        if (field.type === 'select') {
          const options = Array.isArray(field.options) ? field.options : [];
          return h(
            'label',
            { key: field.name, className: 'dg-field' },
            h('span', { className: 'dg-field-label' }, field.label),
            h(
              'select',
              {
                className: 'dg-small-select',
                value: String(value === undefined ? '' : value),
                onChange: (event) => setValue(event.target.value),
              },
              options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            ),
            typeof field.hint === 'string' && field.hint !== ''
              ? h('span', { className: 'dg-hint' }, field.hint)
              : null,
          );
        }
        const text = String(value === undefined || value === null ? '' : value);
        const placeholder = typeof field.placeholder === 'string' ? field.placeholder : '';
        return h(
          'label',
          { key: field.name, className: 'dg-field' },
          h(
            'span',
            { className: 'dg-field-label' },
            field.required === true ? field.label + ' *' : field.label,
          ),
          field.type === 'textarea'
            ? h('textarea', {
                ref: inputRef,
                className: 'dg-textarea',
                rows: 3,
                value: text,
                placeholder,
                spellCheck: false,
                onChange: (event) => setValue(event.target.value),
              })
            : h('input', {
                ref: inputRef,
                className: 'dg-input',
                type: 'text',
                value: text,
                placeholder,
                spellCheck: false,
                onChange: (event) => setValue(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                },
              }),
          typeof field.hint === 'string' && field.hint !== ''
            ? h('span', { className: 'dg-hint' }, field.hint)
            : null,
        );
      };

      return h(
        'div',
        {
          className: 'dg-scrim',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          'div',
          {
            className: 'dg-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': typeof spec.title === 'string' ? spec.title : '',
            onKeyDown: (event) => {
              if (event.key === 'Escape') props.onClose();
            },
          },
          h('h2', { className: 'dg-card-title' }, typeof spec.title === 'string' ? spec.title : ''),
          h(
            'div',
            { className: 'dg-card-body' },
            typeof spec.body === 'string' && spec.body !== ''
              ? h('p', { className: 'dg-note' }, spec.body)
              : null,
            fields.map(renderField),
            error !== null ? h(ErrorBar, { error, t }) : null,
          ),
          h(
            'div',
            { className: 'dg-card-actions' },
            h(TextButton, { onClick: props.onClose, disabled: busy }, t('common.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: spec.danger === true ? 'dg-primary dg-btn-danger' : 'dg-primary',
                disabled: busy,
                onClick: submit,
              },
              typeof spec.submitLabel === 'string' ? spec.submitLabel : t('common.confirm'),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 12. Panel, registration and module entry
    // ---------------------------------------------------------------------

    /** Merge and de-duplicate two root lists, keeping first-seen order. */
    function mergeRoots(extra, roots) {
      const out = [];
      const seen = {};
      for (const list of [extra, roots]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (typeof item !== 'string') continue;
          const value = item.trim();
          if (value === '' || seen[value] === true) continue;
          seen[value] = true;
          out.push(value);
        }
      }
      return out;
    }

    /**
     * Build the sidebar pane component. It closes over the plugin context and
     * the translator, so the registered component needs no props at all.
     * @param {any} ctx
     * @param {(key: string, params?: any) => string} t
     * @param {{ tabsAvailable?: boolean }} [options]
     */
    function makePanel(ctx, t, options) {
      const tabsAvailable = !(options !== null && typeof options === 'object' && options.tabsAvailable === false);

      return function GitPanel(props) {
        const sessionId =
          props !== null && typeof props === 'object' && typeof props.sessionId === 'string' && props.sessionId !== ''
            ? props.sessionId
            : undefined;

        const [settings, setSettings] = React.useState(loadSettings);
        const [collapsed, setCollapsed] = React.useState(loadCollapsed);
        const [extraRoots, setExtraRoots] = React.useState(loadExtraRoots);
        const [repo, setRepo] = React.useState(() => readString(STORE.repo));
        const [reposState, setReposState] = React.useState({ status: 'loading', value: null, error: null });
        const [statusState, setStatusState] = React.useState({ status: 'idle', value: null, error: null });
        const [busy, setBusy] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const [error, setError] = React.useState(null);
        const [view, setView] = React.useState({ kind: 'status' });
        const [dialog, setDialog] = React.useState(null);
        const [settingsOpen, setSettingsOpen] = React.useState(false);
        const [message, setMessage] = React.useState('');
        const [openSections, setOpenSections] = React.useState({});
        const [version, setVersion] = React.useState(0);
        const mountedRef = React.useRef(true);

        React.useEffect(() => {
          mountedRef.current = true;
          return () => {
            mountedRef.current = false;
          };
        }, []);

        const reposValue = reposState.value !== null && typeof reposState.value === 'object' ? reposState.value : {};
        const repos = Array.isArray(reposValue.repos) ? reposValue.repos : [];
        const roots = Array.isArray(reposValue.roots) ? reposValue.roots : [];
        const truncated = reposValue.truncated === true;
        const suggestedRoots = Array.isArray(reposValue.suggestedRoots) ? reposValue.suggestedRoots : [];
        const status = statusState.value !== null && typeof statusState.value === 'object' ? statusState.value : null;
        const stagedEntries = status !== null && Array.isArray(status.staged) ? status.staged : [];
        const changedEntries = status !== null && Array.isArray(status.changed) ? status.changed : [];
        const untrackedEntries = status !== null && Array.isArray(status.untracked) ? status.untracked : [];
        const conflictedEntries = status !== null && Array.isArray(status.conflicted) ? status.conflicted : [];
        const totalChanges =
          stagedEntries.length + changedEntries.length + untrackedEntries.length + conflictedEntries.length;

        const api = React.useCallback(
          (action, params) => {
            const merged = Object.assign({}, params === null || typeof params !== 'object' ? {} : params);
            if (sessionId !== undefined && merged.sessionId === undefined) merged.sessionId = sessionId;
            if (repo !== '' && merged.repo === undefined) merged.repo = repo;
            // The Host owns discovery and pull defaults, so every request carries
            // the user's settings; `repos.list` also needs the explicit roots.
            if (merged.settings === undefined) merged.settings = hostSettings(settings);
            return call(action, merged);
          },
          [sessionId, repo, settings],
        );

        const runAction = React.useCallback((label, task) => {
          setBusy(typeof label === 'string' ? label : '');
          setError(null);
          setNotice('');
          return Promise.resolve()
            .then(task)
            .then((value) => {
              if (mountedRef.current) setBusy('');
              if (mountedRef.current) setVersion((previous) => previous + 1);
              return value;
            })
            .catch((cause) => {
              if (mountedRef.current) {
                setBusy('');
                setError(cause);
              }
              throw cause;
            });
        }, []);

        const notify = React.useCallback((text) => {
          const value = typeof text === 'string' ? text : '';
          setNotice(value);
          if (value !== '') {
            window.setTimeout(() => {
              if (mountedRef.current) setNotice((previous) => (previous === value ? '' : previous));
            }, 6000);
          }
        }, []);

        const refreshRepos = React.useCallback(() => {
          setReposState((previous) => ({ status: 'loading', value: previous.value, error: null }));
          const merged = mergeRoots(extraRoots, settings.roots);
          const params = {};
          if (merged.length > 0) params.extraRoots = merged;
          api('repos.list', params)
            .then((value) => {
              if (!mountedRef.current) return;
              const info = value !== null && typeof value === 'object' ? value : {};
              const list = Array.isArray(info.repos) ? info.repos : [];
              const outRoots = Array.isArray(info.roots) ? info.roots : [];
              const suggestions = Array.isArray(info.suggestedRoots)
                ? info.suggestedRoots.filter((item) => item !== null && typeof item === 'object' && typeof item.path === 'string')
                : [];
              setReposState({
                status: 'ready',
                value: { repos: list, roots: outRoots, truncated: info.truncated === true, suggestedRoots: suggestions },
                error: null,
              });
              setRepo((previous) => {
                const next = pickRepo(previous, list, outRoots);
                if (next !== previous) writeString(STORE.repo, next);
                return next;
              });
            })
            .catch((cause) => {
              if (!mountedRef.current) return;
              setReposState({ status: 'error', value: null, error: cause });
            });
        }, [api, extraRoots, settings.roots]);

        const refreshStatus = React.useCallback(
          (target) => {
            const repoPath = typeof target === 'string' ? target : repo;
            if (repoPath === '') {
              setStatusState({ status: 'idle', value: null, error: null });
              return Promise.resolve(null);
            }
            return api('status', { repo: repoPath })
              .then((value) => {
                if (mountedRef.current) setStatusState({ status: 'ready', value, error: null });
                return value;
              })
              .catch((cause) => {
                if (mountedRef.current) setStatusState({ status: 'error', value: null, error: cause });
                return null;
              });
          },
          [api, repo],
        );

        const refreshReposRef = useLatest(refreshRepos);
        const rootsKey = settings.roots.join('\n');

        React.useEffect(() => {
          refreshReposRef.current();
        }, [extraRoots, rootsKey, refreshReposRef]);

        React.useEffect(() => {
          if (repo === '') {
            setStatusState({ status: 'idle', value: null, error: null });
            return undefined;
          }
          let cancelled = false;
          setStatusState((previous) => ({ status: 'loading', value: previous.value, error: null }));
          api('status', { repo })
            .then((value) => {
              if (!cancelled && mountedRef.current) setStatusState({ status: 'ready', value, error: null });
            })
            .catch((cause) => {
              if (!cancelled && mountedRef.current) setStatusState({ status: 'error', value: null, error: cause });
            });
          return () => {
            cancelled = true;
          };
        }, [api, repo, version]);

        React.useEffect(() => {
          if (repo === '') return undefined;
          const timer = window.setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            api('status', { repo })
              .then((value) => {
                if (mountedRef.current) setStatusState({ status: 'ready', value, error: null });
              })
              .catch(() => {
                // Polling failures stay silent; the next tick retries.
              });
          }, POLL_MS);
          return () => window.clearInterval(timer);
        }, [api, repo]);

        React.useEffect(() => {
          if (repo === '') return undefined;
          const onFocus = () => {
            void refreshStatus(repo);
          };
          const onVisibility = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refreshStatus(repo);
          };
          window.addEventListener('focus', onFocus);
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
          return () => {
            window.removeEventListener('focus', onFocus);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
          };
        }, [refreshStatus, repo]);

        const toggleGroup = (id) => {
          setCollapsed((previous) => {
            const next = Object.assign({}, previous);
            if (next[id] === true) delete next[id];
            else next[id] = true;
            saveCollapsed(next);
            return next;
          });
        };

        const toggleSection = (name) => {
          setOpenSections((previous) => Object.assign({}, previous, { [name]: previous[name] !== true }));
        };

        const selectRepo = (next) => {
          if (next === repo) return;
          setRepo(next);
          writeString(STORE.repo, next);
          setView({ kind: 'status' });
          setMessage('');
        };

        const initRepo = (path) => {
          if (path === '') return;
          void runAction(t('repo.init'), () => api('repo.init', { path }))
            .then((value) => {
              const created =
                value !== null && typeof value === 'object' && value.repo !== null && typeof value.repo === 'object'
                  ? value.repo
                  : null;
              if (created !== null && typeof created.path === 'string' && created.path !== '') {
                setRepo(created.path);
                writeString(STORE.repo, created.path);
              }
              refreshReposRef.current();
              notify(t('repo.initDone'));
            })
            .catch(noop);
        };

        const addRepo = (path) => {
          if (path === '') return;
          const next = mergeRoots(extraRoots, [path]);
          const changed = next.length !== extraRoots.length;
          setExtraRoots(next);
          saveExtraRoots(next);
          notify(t('repo.added', { path }));
          if (!changed) refreshReposRef.current();
        };

        const stagePaths = (paths) => {
          if (!Array.isArray(paths) || paths.length === 0) return;
          void runAction(t('action.stage'), () => api('stage', { paths })).catch(noop);
        };

        const unstagePaths = (paths) => {
          if (!Array.isArray(paths) || paths.length === 0) return;
          void runAction(t('action.unstage'), () => api('unstage', { paths })).catch(noop);
        };

        const discardPaths = (paths) => {
          if (!Array.isArray(paths) || paths.length === 0) return;
          askConfirm({
            title: t('action.discard'),
            body: t('confirm.discard'),
            submitLabel: t('common.discard'),
            danger: true,
            onSubmit: () => runAction(t('action.discard'), () => api('discard', { paths, confirm: true })),
          });
        };

        const stageAll = () => {
          void runAction(t('action.stageAll'), () => api('stageAll')).catch(noop);
        };

        const unstageAll = () => {
          void runAction(t('action.unstageAll'), () => api('unstageAll')).catch(noop);
        };

        const commit = (mode) => {
          const text = message.trim();
          if (text === '') {
            setError(makeClientError('E_INVALID_ARG', t('common.required', { name: t('commit.message') })));
            return;
          }
          if (mode !== 'amend' && stagedEntries.length === 0) {
            setError(makeClientError('E_INVALID_ARG', t('commit.emptyHint')));
            return;
          }
          const run = () => {
            switch (mode) {
              case 'commitPush':
                return api('commit', { message: text }).then(() => api('push', { setUpstream: true }));
              case 'commitSync':
                return api('commit', { message: text })
                  .then(() => api('pull', { strategy: settings.pullStrategy }))
                  .then(() => api('push', { setUpstream: true }));
              case 'amend':
                return api('commit', { message: text, amend: true });
              case 'stageAllCommit':
                return api('stageAll').then(() => api('commit', { message: text }));
              default:
                return api('commit', { message: text });
            }
          };
          void runAction(t('action.commit'), run)
            .then((value) => {
              setMessage('');
              const info = value !== null && typeof value === 'object' ? value : {};
              const subject =
                typeof info.subject === 'string' && info.subject !== ''
                  ? info.subject
                  : shortHash(typeof info.hash === 'string' ? info.hash : '');
              notify(t('commit.done', { subject }));
              void refreshStatus(repo);
            })
            .catch(noop);
        };

        const syncOutput = (value, fallback) => {
          const output = value !== null && typeof value === 'object' && typeof value.output === 'string' ? value.output.trim() : '';
          notify(output === '' ? fallback : output.slice(0, 400));
        };

        const fetchRemote = () => {
          void runAction(t('repo.fetch'), () => api('fetch').then((value) => {
            syncOutput(value, t('repo.fetchDone'));
            return value;
          })).catch(noop);
        };

        const pullRemote = () => {
          void runAction(t('repo.pull'), () => api('pull', { strategy: settings.pullStrategy }).then((value) => {
            syncOutput(value, t('repo.pullDone'));
            return value;
          })).catch(noop);
        };

        const doPush = (force, to, remote) =>
          runAction(t('repo.push'), () =>
            api('push', {
              force: force === true ? true : undefined,
              confirm: force === true ? true : undefined,
              to: to === 'same' || to === 'upstream' ? to : undefined,
              remote: typeof remote === 'string' && remote !== '' ? remote : undefined,
              setUpstream:
                status !== null && (status.upstream === null || status.upstream === '') ? true : undefined,
            }).then((value) => {
              syncOutput(value, t('repo.pushDone'));
              return value;
            }),
          );

        /**
         * Ask which branch a push should land on. `push.default=simple` refuses
         * when the upstream name differs from the branch name, and git's own
         * answer is a five-line lecture about config — so the choice is put in
         * front of the user with both names spelled out.
         */
        const pushChooser = (force) => {
          const localBranch = status !== null && typeof status.branch === 'string' ? status.branch : '';
          const upstream = status !== null && typeof status.upstream === 'string' ? status.upstream : '';
          const target = splitUpstream(upstream);
          askForm({
            title: t('push.mismatchTitle'),
            fields: [
              {
                name: 'to',
                type: 'select',
                label: t('push.mismatchField'),
                value: 'same',
                options: [
                  { value: 'same', label: t('push.toSame', { branch: localBranch }) },
                  { value: 'upstream', label: t('push.toUpstream', { branch: target.branch }) },
                ],
                hint: t('push.mismatchHint', { branch: localBranch, upstream }),
              },
            ],
            submitLabel: t('repo.push'),
            onSubmit: (values) =>
              doPush(force, values.to === 'upstream' ? 'upstream' : 'same', target.remote),
          });
        };

        const pushRemote = (force) => {
          const localBranch = status !== null && typeof status.branch === 'string' ? status.branch : '';
          const upstream = status !== null && typeof status.upstream === 'string' ? status.upstream : '';
          const mismatched =
            localBranch !== '' && upstream !== '' && splitUpstream(upstream).branch !== localBranch;
          const onFailure = (failure) => {
            const code =
              failure !== null && typeof failure === 'object' && typeof failure.code === 'string'
                ? failure.code
                : '';
            if (code !== 'E_UPSTREAM_MISMATCH') return;
            setError(null);
            pushChooser(force === true);
          };
          if (force === true) {
            askConfirm({
              title: t('repo.forcePush'),
              body: t('confirm.forcePush'),
              submitLabel: t('repo.forcePush'),
              danger: true,
              onSubmit: () => doPush(true).catch(onFailure),
            });
            return;
          }
          if (mismatched) {
            pushChooser(false);
            return;
          }
          void doPush(false).catch(onFailure);
        };

        const openDiff = React.useCallback((target) => {
          setView(Object.assign({ kind: 'diff' }, target === null || typeof target !== 'object' ? {} : target));
        }, []);

        const openCommit = React.useCallback((hash) => {
          setView({ kind: 'commit', hash: typeof hash === 'string' ? hash : '' });
        }, []);

        const goBack = React.useCallback(() => {
          setView((previous) => {
            const target = previous !== null && typeof previous === 'object' ? previous.back : null;
            if (target !== null && typeof target === 'object' && typeof target.kind === 'string') return target;
            return { kind: 'status' };
          });
        }, []);

        const askForm = React.useCallback((spec) => {
          setDialog(Object.assign({}, spec, { form: true }));
        }, []);

        const askConfirm = React.useCallback((spec) => {
          setDialog(Object.assign({}, spec, { form: false }));
        }, []);

        const closeDialog = React.useCallback(() => {
          setDialog(null);
        }, []);

        const saveSettings = React.useCallback((next) => {
          setSettings(normalizeSettings(next));
        }, []);

        /** Add one suggested directory to the scan roots and rescan. */
        const addScanRoot = React.useCallback(
          (path) => {
            const next = withScanRoot(settings, path);
            if (next.roots.length === settings.roots.length) return;
            writeJson(STORE.settings, next);
            setSettings(next);
          },
          [settings],
        );

        const onPanelKeyDown = (event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === 'r' || event.key === 'R')) {
            event.preventDefault();
            void refreshStatus(repo);
            refreshReposRef.current();
          }
        };

        const ui = {
          t,
          api,
          runAction,
          repo,
          version,
          settings,
          notify,
          askForm,
          askConfirm,
          openDiff,
          openCommit,
          dismissError: () => setError(null),
        };

        const openEntry = (entry, kind) => {
          const path = entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : '';
          if (path === '') return;
          const conflict =
            kind === 'conflicted' ||
            (entry !== null && typeof entry === 'object' && (entry.conflict === true || typeof entry.conflict === 'string'));
          openDiff({ path, staged: kind === 'staged', conflict, back: { kind: 'status' } });
        };

        const renderGroup = (id, title, entries, kind) => {
          if (entries.length === 0) return null;
          let action = null;
          if (kind === 'staged') action = { label: t('action.unstageAll'), onClick: unstageAll };
          else if (kind === 'changed' || kind === 'untracked') action = { label: t('action.stageAll'), onClick: stageAll };
          return h(
            ChangeGroup,
            {
              key: id,
              title,
              count: entries.length,
              collapsed: collapsed[id] === true,
              onToggle: () => toggleGroup(id),
              action,
            },
            entries.map((entry) => {
              const path = entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : '';
              return h(FileRow, {
                key: kind + ':' + path,
                entry,
                staged: kind === 'staged',
                conflicted: kind === 'conflicted',
                t,
                onOpen: () => openEntry(entry, kind),
                onStage: () => stagePaths([path]),
                onUnstage: () => unstagePaths([path]),
                onDiscard: () => discardPaths([path]),
              });
            }),
          );
        };

        const groups = h(
          React.Fragment,
          null,
          renderGroup('conflicts', t('status.conflicts'), conflictedEntries, 'conflicted'),
          renderGroup('staged', t('status.staged'), stagedEntries, 'staged'),
          renderGroup('changes', t('status.changes'), changedEntries, 'changed'),
          renderGroup('untracked', t('status.untracked'), untrackedEntries, 'untracked'),
        );

        const sections = h(
          React.Fragment,
          null,
          h(BranchesSection, { ui, open: openSections.branches === true, onToggle: () => toggleSection('branches') }),
          h(HistorySection, { ui, open: openSections.history === true, onToggle: () => toggleSection('history') }),
          h(StashSection, { ui, open: openSections.stash === true, onToggle: () => toggleSection('stash') }),
          h(TagsSection, { ui, open: openSections.tags === true, onToggle: () => toggleSection('tags') }),
          h(RemotesSection, { ui, open: openSections.remotes === true, onToggle: () => toggleSection('remotes') }),
          h(SubmodulesSection, {
            ui,
            open: openSections.submodules === true,
            onToggle: () => toggleSection('submodules'),
          }),
          h(RawSection, { ui, open: openSections.raw === true, onToggle: () => toggleSection('raw') }),
        );

        const statusView = h(
          'div',
          { className: 'dg-scroll' },
          statusState.error !== null ? h(ErrorBar, { error: statusState.error, t, onRetry: () => refreshStatus(repo) }) : null,
          statusState.status === 'loading' && status === null ? h('div', { className: 'dg-hint' }, t('common.loading')) : null,
          status !== null && totalChanges === 0 ? h('div', { className: 'dg-note' }, t('status.clean')) : null,
          groups,
          h(CommitBox, {
            t,
            message,
            onMessage: setMessage,
            onCommit: commit,
            stagedCount: stagedEntries.length,
            busy: busy !== '',
          }),
          sections,
        );

        const emptyView = h(EmptyState, {
          t,
          roots,
          suggestedRoots,
          onAddSuggestion: addScanRoot,
          scanning: reposState.status === 'loading',
          truncated,
          error: reposState.error,
          onInit: initRepo,
          onAdd: addRepo,
          onSettings: () => setSettingsOpen(true),
        });

        const unavailableView = h(
          'div',
          { className: 'dg-empty' },
          h('span', { className: 'dg-empty-icon' }, h(GitIcon, { size: 40 })),
          h('p', { className: 'dg-empty-title' }, t('error.unavailable')),
          h('p', { className: 'dg-empty-body' }, t('error.unavailableHint')),
        );

        let content;
        if (!tabsAvailable) content = unavailableView;
        else if (view.kind === 'diff') content = h(DiffView, { ui, target: view, onBack: goBack });
        else if (view.kind === 'commit') content = h(CommitView, { ui, hash: view.hash, onBack: goBack });
        else if (repos.length === 0) content = emptyView;
        else content = statusView;

        return h(
          'div',
          { className: 'dg-root', onKeyDown: onPanelKeyDown },
          h(TopBar, {
            t,
            repos,
            repo,
            onSelect: selectRepo,
            status,
            changedCount: totalChanges,
            busy: busy !== '',
            settingsOpen,
            onRefresh: () => {
              void refreshStatus(repo);
              refreshReposRef.current();
            },
            onSettings: () => setSettingsOpen((previous) => previous !== true),
            onFetch: fetchRemote,
            onPull: pullRemote,
            onPush: () => pushRemote(false),
            onForcePush: () => pushRemote(true),
          }),
          busy !== '' ? h('div', { className: 'dg-busy' }, busy) : null,
          notice !== '' ? h('div', { className: 'dg-banner' }, h('span', { className: 'dg-banner-text' }, notice)) : null,
          status !== null ? h(OperationBanner, { t, operation: status.operation, api, runAction, busy: busy !== '' }) : null,
          error !== null ? h(ErrorBar, { error, t, onDismiss: () => setError(null) }) : null,
          content,
          settingsOpen ? h(SettingsOverlay, { t, settings, onSave: saveSettings, onClose: () => setSettingsOpen(false) }) : null,
          dialog !== null
            ? h(TaskDialog, {
                spec: dialog,
                t,
                onClose: closeDialog,
              })
            : null,
        );
      };
    }

    return {
      name: '@local/dsh-git',
      inject: ['slots', 'locale'],

      apply(ctx) {
        const registerLocale = () => {
          try {
            if (ctx !== null && typeof ctx === 'object' && ctx.locale && typeof ctx.locale.register === 'function') {
              return ctx.locale.register(NS, dicts);
            }
          } catch {
            // A missing locale service only costs translations, never the panel.
          }
          return undefined;
        };

        if (typeof ctx.effect === 'function') {
          ctx.effect(registerLocale, 'dsh-git: locale dictionaries');
        } else {
          registerLocale();
        }

        const t = makeT(ctx);
        if (typeof document !== 'undefined') injectStyles();

        const openGit = () => {
          try {
            const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null;
            if (sidebar !== null && sidebar !== undefined && typeof sidebar.openTab === 'function') {
              sidebar.openTab(TAB_ID);
              return true;
            }
          } catch {
            // Fall through to the layout fallback.
          }
          try {
            const layout = typeof ctx.get === 'function' ? ctx.get('layout') : null;
            if (layout !== null && layout !== undefined && typeof layout.openRightbar === 'function') {
              layout.openRightbar();
              return true;
            }
          } catch {
            // Nothing else to try.
          }
          return false;
        };

        const GitHeaderButton = () =>
          h(
            'button',
            {
              type: 'button',
              className: 'dg-headerbtn',
              title: t('header.button'),
              'aria-label': t('header.button'),
              onClick: () => {
                openGit();
              },
            },
            h(GitIcon, { size: 16 }),
          );

        const GitTabTitle = () =>
          h(
            'span',
            { className: 'dg-tabtitle' },
            h(GitIcon, { size: 16 }),
            h('span', { className: 'dg-tabtitle-label' }, t('tab.title')),
          );

        if (ctx.slots !== null && ctx.slots !== undefined && typeof ctx.slots.register === 'function') {
          // `slots.inject` waits for the slot declaration, which is the pattern
          // the shipped plugins use: a direct `register` on an undeclared slot
          // is dropped by load-time validation.
          const registerHeader = () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: HEADER_ID,
                order: 10,
                label: () => t('header.button'),
              },
              GitHeaderButton,
            );
          try {
            if (typeof ctx.slots.inject === 'function') {
              ctx.slots.inject('conversation.session.header.utilities', registerHeader);
            } else {
              registerHeader();
            }
          } catch (error) {
            console.error('[dsh-git] header button registration failed', error);
          }
        }

        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs'], (scope) => {
            const disposers = [];
            const track = (disposer) => {
              if (typeof disposer === 'function') disposers.push(disposer);
            };
            let tabs = null;
            try {
              tabs = scope !== null && scope !== undefined ? scope.sidebarRightTabs : null;
            } catch {
              tabs = null;
            }
            const available = tabs !== null && tabs !== undefined && typeof tabs.register === 'function';
            const Panel = makePanel(ctx, t, { tabsAvailable: available });
            const register = (name, key, component, label) => {
              const registerOne = () => scope.slots.register({ name, key }, component);
              try {
                if (typeof scope.slots.inject === 'function') track(scope.slots.inject(name, registerOne));
                else track(scope.effect(registerOne, label));
              } catch (error) {
                console.error(`[dsh-git] ${name} registration failed`, error);
              }
            };
            try {
              if (available) {
                track(
                  scope.effect(
                    () =>
                      tabs.register({
                        id: TAB_ID,
                        kind: TAB_ID,
                        title: () => t('tab.title'),
                        guide: [
                          {
                            order: 30,
                            title: () => t('guide.title'),
                            description: () => t('guide.description'),
                            icon: GitIcon,
                          },
                        ],
                      }),
                    'dsh-git: sidebar tab',
                  ),
                );
                register('sidebar.right.pane.tab', TAB_ID, Panel, 'dsh-git: pane');
                register('sidebar.right.pane.tab.title', TAB_ID, GitTabTitle, 'dsh-git: pane title');
              } else {
                register('sidebar.right.pane.tab', TAB_ID, Panel, 'dsh-git: pane (unavailable)');
              }
            } catch {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  // Ignore a failing cleanup.
                }
              }
              return undefined;
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  // Ignore a failing cleanup.
                }
              }
            };
          });
        }
      },
    };
  },
});
