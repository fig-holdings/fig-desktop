# Fig Desktop

[English](README.md) | 简体中文

> 本文译自英文版 README，两者如有出入，以英文版为准。

Fig Desktop 是一款在自己电脑上使用 AI 智能体的 macOS 桌面应用。它以 [DeepSeek Harness（DSH）](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为智能体运行时，在此基础上提供原生窗口、桌面集成和一组 DSH 插件：ChatGPT 与 Grok 订阅登录、跨工作区的任务动态、侧边聊天、研发工作台等。

> **当前状态：0.x 源码预览版。** Fig Desktop 在 Apple Silicon 芯片的 macOS 上构建和测试。目前还没有签名或公证过的安装包，需要从源码构建。功能尚不完善，版本之间可能有不兼容的改动。

Fig Desktop 是独立项目，与 DeepSeek、OpenAI、xAI 均无隶属关系，也未获得它们的认可或背书。

## 在 DSH 之上增加了什么

DSH 负责智能体本身：会话、模型、工具、权限以及它的网页工作台。Fig 把这个工作台作为主窗口，并在它周围补齐以下能力：

- **桌面应用。** 原生 macOS 窗口，接入 Dock、菜单和系统通知。关闭窗口时 DSH 继续运行；退出 Fig 时只停止它自己启动的 DSH，不影响其他进程。
- **只运行一个验证过的 DSH，并锁定全部依赖。** 每个 Fig 版本只运行一个经测试验证的 DSH 版本，DSH 的完整依赖树也一并锁定（`code/dsh-runtime/package-lock.json`）。Fig 在首次启动时用 `npm ci` 安装，因此每台 Mac 运行的都是测试时用的同一组软件包。
- **更多模型。** 在 DSH 自带的 DeepSeek 之外，支持 ChatGPT 和 Grok 订阅，并能识别 OpenAI、xAI API Key 可用的模型。
- **随 Fig 提供的插件。** 每个都是标准 DSH 插件，可以在 DSH 的「插件」页单独关闭：

| 插件 | 作用 |
| --- | --- |
| ChatGPT 订阅 | 用 ChatGPT 账号登录后使用订阅模型，附账号页和用量额度 |
| Grok 订阅 | 借助本机 Grok CLI 的登录使用订阅模型，附账号页和用量 |
| 联网搜索 | 通过当前模型自带的搜索，或你自己的 Brave Search Key 联网搜索 |
| 任务动态 | 汇总各工作区里需要你处理的会话、失败和新结果，附用量热力图和任务提醒 |
| 侧边聊天 | 主会话旁的只读对话，可读取主会话进度，经你确认后向主会话发消息 |
| 研发工作台 | 在对话旁显示当前仓库、分支、改动和合并请求 |
| 会话交接 | 根据交接摘要另开一个会话，让它独立运行 |
| 委派审核 | 把只读审核或提问交给本机的 Codex 或 Claude Code CLI |
| 页面预览 | 以用户视角打开本地页面，报告加载错误、内容溢出和失效图片，并附截图 |
| 输入框增强 | 用 ↑／↓ 找回之前发过的消息，每轮结束后提示下一步 |
| 规则来源 | 列出当前会话用到的 `AGENTS.md` 文件，以及它们之后是否改动过 |
| 上级目录规则 | 补上启动目录与项目 Git 根目录之间的 `AGENTS.md` |
| 额外技能目录 | 为所有会话和模型额外指定一个技能目录 |
| 项目导航 | 项目图标与颜色、会话状态点，以及侧栏收起时的最近会话 |

## 环境要求

- Apple Silicon 芯片的 macOS。Intel Mac 未经测试，不支持 Windows 和 Linux。
- Node.js 22.x 中 22.19 及以上，或 Node.js 24 及以上，并且 `npm` 在 `PATH` 中。如果还没装，从 [nodejs.org](https://nodejs.org/) 下载当前 LTS 版的 macOS 安装包安装，然后新开一个终端窗口，确认 `node --version` 显示 `v22.19` 或更高版本。
- 首次构建和首次启动需要联网，用来安装 npm 依赖、Electron 和 DSH；另需约 3 GB 可用磁盘空间。

## 从源码运行

```sh
git clone https://github.com/fig-holdings/fig-desktop.git
cd fig-desktop/code
npm ci
npm run licenses:prepare
npm run dev
```

本文所有 `npm` 命令都要在 `fig-desktop/code` 目录下执行。新开终端窗口时先 `cd` 进这个目录，否则 npm 会报错说找不到 `package.json`。

`npm ci` 还会从 GitHub 下载 Electron 程序（约 100 MB）。这一步下载失败时，npm 仍会正常结束、不报错，问题要到启动 Fig 或运行测试时才出现。安装后先确认 Electron 已经下载：

```sh
ls node_modules/electron/dist
```

如果显示 `No such file or directory`，需要重新下载 Electron。使用代理时，把示例地址 `http://127.0.0.1:7890` 换成你的代理地址（两个变量都要设，Node 才会走代理）：

```sh
HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js
```

也可以改用镜像，例如在中国大陆：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

`npm run licenses:prepare` 会按锁文件安装一次 DSH 的依赖树（不执行安装脚本），让构建能从 `work/license-npm-cache/` 收集每个软件包的许可证文本；不执行这一步，构建会失败。DSH 锁文件更新后需要重新执行。

首次启动时，Fig 会请你选择一个存放工作区的启动目录（例如 `~/Fig`），然后下载并启动 DSH。窗口会显示进度；如果出错，会显示诊断信息。

如果想运行生产构建而不是开发服务器：

```sh
npm run build
npm start
```

## 在自己的 Mac 上构建应用

目前还没有可直接下载的安装包。如果想从「应用程序」或 Dock 打开 Fig，而不是每次运行 `npm run dev`，可以在自己的 Mac 上构建应用，同样在 `fig-desktop/code` 目录下执行：

```sh
npm run package:mac -- --dsh=keep
```

这条命令会先跑检查，再在仓库根目录（`code/` 的上一级）生成 `outputs/Fig Desktop.app`，做仅对本机有效的临时签名（ad hoc），并在临时的测试环境里启动一次，确认应用能正常运行，大约需要几分钟。`--dsh=keep` 表示用这一版验证过的 DSH 版本构建；不加的话，脚本可能会询问是否试用更新的 DSH。

然后把应用复制到「应用程序」：

```sh
cp -R "../outputs/Fig Desktop.app" /Applications/
```

自己构建的应用不带「从互联网下载」的标记，macOS 打开时不会弹出安全警告。它仍然用你本机安装的 Node.js 运行 DSH（从 `/usr/local/bin`、`/opt/homebrew/bin` 或 `~/.local/node/bin` 查找），所以请保留 Node。签名只在本机有效，不要把应用复制到其他 Mac 使用。

以后更新时，拉取源码重新构建，再替换「应用程序」里的那一份：

```sh
git pull
npm ci
npm run licenses:prepare
npm run package:mac -- --dsh=keep --rebuild
```

如果版本号和上次构建时相同，需要加 `--rebuild`。

## 登录模型

在新会话里打开模型选择菜单；账号相关设置在 **Fig Desktop › 设置…**（`⌘,`）。

- **DeepSeek：** 在 DSH 自带的账号设置中登录，或添加 API Key。
- **ChatGPT 订阅：** 在设置的 **ChatGPT 账号** 页面通过浏览器登录，然后在 **ChatGPT 订阅** 分组中选择模型。如果本机装了已登录的 Codex CLI，用量额度从它读取。
- **Grok 订阅：** 安装官方 Grok CLI，在终端运行 `grok login`，然后在 **Grok 订阅** 分组中选择模型。Fig 使用 CLI 的登录状态，并交给 CLI 自己续期。
- **OpenAI 或 xAI API Key：** 在 DSH 的账号设置中添加 Key，Fig 会列出该 Key 能用的模型。

你的提示词从本机直接发送给你选择的模型服务商。Fig 本身不运行任何服务器，也不发送遥测数据；DSH 和各模型服务商遵循各自的政策。

## 数据存放位置

| 位置 | 内容 |
| --- | --- |
| `~/.fig` | DSH 的数据目录：会话、凭据、插件和设置。可在 设置 › 运行环境 中迁移 |
| `~/Library/Application Support/Fig Desktop/` | 窗口状态和目录设置 |
| `~/Library/Caches/fig-desktop/dsh/` | Fig 运行的 DSH 安装（当前版本和上一个版本） |
| `~/Library/Caches/fig-desktop/npm/` | Fig 安装 DSH 时使用的 npm 缓存 |
| 你的启动目录 | 你的工作区；Fig 不会移动或改写它们 |

## 已知限制

- **订阅接入不是官方提供的。** ChatGPT、Grok 订阅及其用量读取，依赖这些服务没有公开文档的接口。对方一旦调整，相关功能可能失效，直到 Fig 更新。使用前请确认各服务商的条款。
- **每个版本只配一个 DSH 版本。** Fig 不会自动跟随 DSH 或其依赖的新版本，新版本要通过 Fig 的检查后才会采用。
- **只支持 macOS，没有签名。** 暂无 Developer ID 签名、公证和自动更新。
- **语音、摄像头和菜单栏托盘** 尚未实现。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `code/app/` | Electron 主进程、预加载脚本，以及 Fig 自己的启动页和错误页 |
| `code/harness/` | Fig 提供的 DSH 插件（每个一个目录）及它们共用的代码（`shared/`） |
| `code/scripts/` | 开发、验证和打包脚本 |
| `code/tests/` | 单元测试和隔离环境下的桌面冒烟测试 |
| `code/third-party-licenses/` | 应用内第三方许可证的配置和文本 |
| `assets/brand/` | 应用使用的图标、字标和字体（已生成好的文件） |

在 `code/` 中运行 `npm run check`，会依次执行类型检查、单元测试和生产构建。其余贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。欢迎用中文提 issue。

## 许可证与商标

Fig Desktop 以 [Apache License 2.0](LICENSE) 授权。第三方软件和素材沿用各自的许可证，详见 [NOTICE](NOTICE)，或在应用中打开 **关于 Fig Desktop › 查看第三方许可证…**。

该许可证不授予 Fig Desktop 名称、图标和字标的使用权（Apache License 2.0 第 6 条）。`assets/brand/` 中的文件由未公开的设计原稿生成，请勿用它们把其他产品呈现为 Fig Desktop。派生项目请使用自己的名称和图标。

## 安全

发现安全漏洞时，请按 [SECURITY.md](SECURITY.md)（英文）中的方式私下报告，不要提交到公开 issue。
