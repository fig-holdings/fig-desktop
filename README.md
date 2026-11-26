# Fig Desktop

English | [简体中文](README.zh-CN.md)

Fig Desktop is a macOS desktop app for working with AI agents on your own computer. It runs [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) as its agent runtime and adds a native window, desktop integration and a set of DSH plugins: subscription sign-in for ChatGPT and Grok, task activity across workspaces, a side chat, a development workbench and more.

> **Status: 0.x source preview.** Fig Desktop is built and tested on macOS with Apple Silicon. There are no signed or notarized downloads yet; you build it from source. Expect rough edges and breaking changes between versions.

Fig Desktop is an independent project. It is not affiliated with or endorsed by DeepSeek, OpenAI or xAI.

## What it adds to DSH

DSH provides the agent: sessions, models, tools, permissions and its web workbench. Fig keeps that workbench as the main window and builds around it:

- **A desktop app.** A native macOS window with Dock, menu and notification integration. Closing the window keeps DSH running; quitting Fig stops the DSH it started and nothing else.
- **One verified DSH, exactly.** Each Fig release runs one DSH version that its tests have verified, with DSH's whole dependency tree locked (`code/dsh-runtime/package-lock.json`). Fig installs it with `npm ci` on first launch, so every Mac runs the same packages that were tested.
- **More models.** ChatGPT and Grok subscriptions next to DSH's own DeepSeek support, plus model discovery for OpenAI and xAI API keys.
- **Plugins that ship with Fig.** Each is a standard DSH plugin and can be turned off on DSH's Plugins page:

| Plugin | What it does |
| --- | --- |
| ChatGPT Subscription | ChatGPT subscription models through a ChatGPT sign-in, with an account page and usage limits |
| Grok Subscription | Grok subscription models through the local Grok CLI sign-in, with an account page and usage |
| Web search | Search through the current model, or through your own Brave Search key |
| Task Activity | Sessions that need you, failures and new results across workspaces, with a usage heat map and task alerts |
| Side Chat | A read-only conversation beside the main session that reads it and, once you confirm, steers it |
| Development workbench | The current repository, branch, changes and pull requests beside the conversation |
| Session Handoff | Starts another session from a handoff summary and lets it run on its own |
| Delegate Review | Hands a read-only review or question to a local Codex or Claude Code CLI |
| Page Preview | Opens a local page as a user sees it and reports load errors, overflow and broken images, with screenshots |
| Composer Helpers | Recalls earlier messages with ↑/↓ and suggests a next step after each turn |
| Rule Sources | Lists the `AGENTS.md` files a session uses and whether they changed |
| Parent Folder Rules | Adds the `AGENTS.md` files between the startup folder and a project's Git root |
| Extra Skill Folder | One extra skill folder for every session and model |
| Project navigation | Project icons and colors, session status dots and recent sessions in the collapsed sidebar |

## Requirements

- macOS on Apple Silicon. Intel Macs are untested; Windows and Linux are not supported.
- Node.js 22.19 or later in the 22.x line, or Node.js 24 or later, with `npm` on your `PATH`. If you do not have it, install the current LTS release with the macOS installer from [nodejs.org](https://nodejs.org/), then open a new Terminal window and check that `node --version` prints `v22.19` or later.
- Internet access on first build and first launch, to install npm dependencies, Electron and DSH, and about 3 GB of free disk space.

## Run from source

```sh
git clone https://github.com/fig-holdings/fig-desktop.git
cd fig-desktop/code
npm ci
npm run licenses:prepare
npm run dev
```

Run every `npm` command in this README from the `fig-desktop/code` folder. In a new Terminal window, `cd` into it first; from anywhere else npm reports that it cannot find `package.json`.

`npm ci` also downloads the Electron app (about 100 MB) from GitHub. If that download fails, npm still finishes without an error, and Fig or the tests fail later. Check that it arrived:

```sh
ls node_modules/electron/dist
```

If this prints `No such file or directory`, download Electron again. Behind a proxy, give its address in place of the example `http://127.0.0.1:7890` (Node needs both variables):

```sh
HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js
```

Or use a mirror, for example in mainland China:

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

`npm run licenses:prepare` installs DSH's locked dependency tree once, without running install scripts, so the build can collect every package's license text from `work/license-npm-cache/`; the build fails without it. Run it again after the DSH lockfile changes.

On first launch Fig asks for a startup folder for your workspaces (for example `~/Fig`), then downloads and starts DSH. The window shows progress and a diagnostics panel if something fails.

To run the production build instead of the development server:

```sh
npm run build
npm start
```

## Build the app for your Mac

There is no downloadable app yet. To open Fig from Applications or the Dock instead of running `npm run dev` each time, build the app on your own Mac, still in `fig-desktop/code`:

```sh
npm run package:mac -- --dsh=keep
```

This runs the checks, builds `outputs/Fig Desktop.app` at the repository root (one level above `code/`), signs it ad hoc for this Mac and starts it once in a temporary test profile to confirm it works. It takes a few minutes. `--dsh=keep` builds with the DSH version this release was verified with; without it, the script may offer to try a newer DSH.

Then copy the app to Applications:

```sh
cp -R "../outputs/Fig Desktop.app" /Applications/
```

An app you build yourself is not marked as downloaded from the internet, so macOS opens it without a security warning. It still runs DSH with the Node.js installed on your Mac (from `/usr/local/bin`, `/opt/homebrew/bin` or `~/.local/node/bin`), so keep Node installed. The signature is valid on this Mac only; do not copy the app to other Macs.

To update later, pull the source and build again, then replace the copy in Applications:

```sh
git pull
npm ci
npm run licenses:prepare
npm run package:mac -- --dsh=keep --rebuild
```

`--rebuild` is needed when the version number has not changed since your last build.

## Sign in to a model

Open the model picker in a new session, or **Fig Desktop › Settings…** (`⌘,`) for account pages.

- **DeepSeek:** sign in or add an API key through DSH's own account settings.
- **ChatGPT subscription:** on the **ChatGPT account** settings page, sign in through your browser, then pick a model from the **ChatGPT Subscription** group. Usage limits are read from a signed-in local Codex CLI when one is installed.
- **Grok subscription:** install the official Grok CLI and run `grok login` in a terminal, then pick a model from the **Grok Subscription** group. Fig uses the CLI's sign-in and lets the CLI renew it.
- **OpenAI or xAI API keys:** add the key in DSH's account settings; Fig lists the models that key can use.

Prompts go from your Mac to the model provider you choose. Fig itself runs no server and sends no telemetry; DSH and each model provider follow their own policies.

## Where Fig keeps data

| Location | Contents |
| --- | --- |
| `~/.fig` | DSH's data directory: sessions, credentials, plugins and settings. Can be moved in Settings › Runtime |
| `~/Library/Application Support/Fig Desktop/` | Window state and directory preferences |
| `~/Library/Caches/fig-desktop/dsh/` | The installed DSH release Fig runs (the current and the previous one) |
| `~/Library/Caches/fig-desktop/npm/` | The npm cache Fig installs DSH from |
| Your startup folder | Your workspaces; Fig does not move or rewrite them |

## Known limitations

- **Subscription integrations are unofficial.** ChatGPT and Grok subscriptions, and their usage readings, rely on interfaces those services do not document. A change on their side can break them until Fig is updated. Check each provider's terms before use.
- **One DSH version per release.** Fig does not follow DSH's latest release, or newer releases of DSH's dependencies, automatically; they are adopted after they pass Fig's checks.
- **macOS only, unsigned.** No Developer ID signing, notarization or automatic updates yet.
- **Voice, camera and tray integrations** are not implemented.

## Repository layout

| Path | Contents |
| --- | --- |
| `code/app/` | The Electron main process, preload and Fig's own startup and error pages |
| `code/harness/` | The DSH plugins Fig ships (one folder each) and the code they share (`shared/`) |
| `code/scripts/` | Development, verification and packaging scripts |
| `code/tests/` | Unit tests and isolated desktop smoke tests |
| `code/third-party-licenses/` | License configuration and texts for the built app |
| `assets/brand/` | Generated icons, wordmarks and fonts used by the app |

`npm run check` in `code/` runs the type checks, unit tests and a production build. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest.

## License and trademarks

Fig Desktop is licensed under the [Apache License 2.0](LICENSE). Third-party software and assets keep their own licenses; see [NOTICE](NOTICE) and, in the app, **About Fig Desktop › View Third-Party Licenses**.

The license does not grant rights to the Fig Desktop name, icons or wordmarks (Apache License 2.0, section 6). The files in `assets/brand/` are generated from design sources that are not published; please do not use them to present another product as Fig Desktop. Forks should use their own name and icons.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
