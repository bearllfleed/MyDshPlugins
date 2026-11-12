# MyDshPlugins

[DeepSeekRuntime](https://github.com/deepseek-ai)（DSH）的插件集合。**一个插件一个文件夹**，彼此独立，可以单独安装、单独升级。

每个文件夹都是一个完整的 npm 包：自己带 `package.json`、`cordis.patch.yml`、Host 半、Client 半、本地化词表、图标、测试和文档，不依赖仓库里别的东西。

## 插件

| 插件 | 目录 | 版本 | 说明 |
| --- | --- | --- | --- |
| 源代码管理 | [`local-dsh-git/`](local-dsh-git/) | 0.1.7 | VSCode 式 Git 面板：多仓库发现、提交/分支/历史/diff、同步、贮藏、标签、远程、子模块 |

### 源代码管理（`@local/dsh-git`）

装好后出现三个入口：会话标题行右上角的 Git 图标（带未提交变更数角标）、右侧栏「Git」标签、右侧栏「开始」页的「源代码管理」卡片。

- 多仓库：以当前打开的工作区为准递归扫描，工作区下面嵌着十几个仓库也能全部列出（穿过仓库继续下钻）；空目录会话回退到已打开的 DSH 工作区、同级目录和自定义扫描根
- 变更分四组（冲突 / 已暂存 / 更改 / 未跟踪），逐文件暂存、丢弃、看 diff
- 提交、amend、全部暂存并提交、提交并推送 / 提交并同步
- 分支（切换/新建/重命名/删除/设上游）、分页历史与提交详情、fetch/pull/push
- 贮藏、标签、远程、子模块、冲突取 ours/theirs、合并/变基/拣选的继续与中止
- 「运行 Git 命令」逃生口（argv 直传，破坏性命令需确认）
- 报错说人话：23 个错误码各配中文建议，git 的原始输出折叠在后面

细节见 [`local-dsh-git/README.md`](local-dsh-git/README.md)，Host↔Client 接口契约见 [`local-dsh-git/CONTRACT.md`](local-dsh-git/CONTRACT.md)。

## 安装

插件以本地目录（`link:`）方式装进当前 DSH profile，改源码后重载 Host 或刷新页面即可生效：

```bash
git clone git@github.com:bearllfleed/MyDshPlugins.git
```

然后在 DSH 里让 agent 执行（`target` 用插件文件夹的绝对路径）：

```
plugin_manager install_bundle target=<克隆路径>/MyDshPlugins/local-dsh-git
```

装完**刷新页面**。卸载：

```
plugin_manager remove_bundle target="@local/dsh-git"
```

也可以直接装打包好的 tgz（不需要克隆，`npm pack` 产物在 Releases 或本地 `dist/`）：

```
plugin_manager install_bundle target=<绝对路径>/local-dsh-git-0.1.7.tgz
```

## 二次开发

```bash
cd local-dsh-git
node --test                     # 全部单元测试，无需 npm install
node test/smoke.mjs <某个真实仓库>   # 对真实仓库跑 15 个只读探测
```

改完源码：

- 改 `client.js`（Client 半）→ 刷新页面
- 改 `index.js` 或 `git/*.js`（Host 半）→ 重载插件：

```
plugin_manager set_plugin target="include:dsh-git" enabled=false
plugin_manager set_plugin target="include:dsh-git" enabled=true
```

重新打包分发：

```bash
npm pack    # 生成 local-dsh-git-<version>.tgz，含源码、测试、契约文档
```

### 加一个新插件时的约定

1. 新建 `插件名/` 文件夹，`package.json` 里 `name` 用 `@local/<名字>`，与文件夹名一致
2. 导出四件套：`exports` 指向 `./index.js` 和 `./client.js`，`dsh.bundle.patch` 指向 `cordis.patch.yml`
3. `cordis.patch.yml` 只写一条 `insert`，`id` 与插件名一致
4. 本地化词表放 `locale/zh.json` 和 `locale/en.json`，Client 内嵌字典要和它们逐键一致（有测试守着）
5. 带上 `README.md`（怎么用）和 `CONTRACT.md`（Host↔Client 接口）
6. 测试用 `node:test`，不要引入构建步骤

## 目录

```
MyDshPlugins/
├── local-dsh-git/        源代码管理插件
│   ├── index.js          Host 半：注册 /api/dsh-git 路由
│   ├── client.js         Client 半：三个入口 + 面板 UI
│   ├── git/              执行、状态解析、仓库发现、diff、历史、动作、错误分类
│   ├── locale/           zh / en 词表
│   ├── test/             node:test 单元测试 + 真实仓库 smoke
│   ├── CONTRACT.md       Host↔Client 接口契约
│   └── cordis.patch.yml  装进 profile 的 patch
└── README.md             本文件
```

## 许可

MIT，见 [LICENSE](LICENSE)。
