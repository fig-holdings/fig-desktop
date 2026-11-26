# Contributing to Fig Desktop

Fig Desktop is in a 0.x source preview. Bug reports, reproductions and focused fixes help most right now. For a larger change, open an issue first so the approach can be agreed before you write it.

Issues and pull requests are handled on a best-effort basis; during 0.x there is no guaranteed response time. Issues in Chinese or English are both welcome.

## Before you start

- Read the [README](README.md) to build and run Fig from source.
- Fig runs one verified DSH version (`code/harness/dsh-versions.json`) with its dependency tree locked (`code/dsh-runtime/`). Report problems against that version; changes that need a newer DSH or newer dependencies are handled when Fig adopts them through `npm run dsh:verify`. Do not edit the lockfile by hand.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

```sh
cd code
npm ci
npm run licenses:prepare
npm run check
```

`npm run check` runs the type checks (main process, plugins and scripts), the unit tests and a production build. Every pull request must pass it.

Keep your own Fig data out of development with `npm run dev:isolated`. It runs Fig against a development profile in `work/dev-profile/` (its own window state, DSH data and sign-ins, a synthetic workspace, and separate Grok and Codex folders) and keeps it between runs. It starts with no model signed in; sign in with a test account if you need one.

This separates data, not the system: the instance still uses your `HOME`, `PATH`, proxies, npm cache and any other CLIs it calls.

## Tests

- **Unit tests** (`npm test`) need no network, accounts or window.
- **Desktop smoke tests** (`code/tests/*-smoke.mjs`) start Fig in a temporary, isolated profile with synthetic data. Run the ones related to your change, for example `node tests/run-smokes.mjs desktop settings`, or `npm run test:desktop:baseline` for the common set. Build first with `npm run build`.
- **Real-account tests** take `--real` and use your own model sign-ins and quota. They are never required for a pull request; say in the pull request if you ran any.

A test that fails once and passes on a rerun is still worth mentioning.

## Code guidelines

- **Plugins stay independent.** Each folder in `code/harness/` is a DSH plugin package. Packages do not import each other; shared code goes in `code/harness/shared/`. `npm run test:packages` loads each package alone in official DSH.
- **Settings come from plugin config,** written by the main process at each start (`code/app/main/plugin-config.ts`), not from environment variables.
- **Prefer DSH's public interfaces.** When Fig must depend on DSH markup or internals, keep the adaptation in one place, say in a comment what it depends on and when it can be removed, and cover it with a smoke test that `npm run dsh:verify` runs.
- **Interface text is bilingual.** Fig follows DSH's language in Chinese and English; add new strings to the plugin's locale dictionary in both.
- **Keep changes focused.** A pull request should do one thing; avoid unrelated reformatting.

## Pull requests

- Describe what changed, why, and how you tested it.
- Include screenshots in light and dark themes for visible changes.
- Do not change `assets/brand/` or the product name and icons; see the trademark note in the README.

### How accepted changes land

Fig is developed in the maintainers' own repository and published here as snapshots. A pull request that is accepted is applied there by a maintainer and reaches this repository with the next snapshot, with you credited as a co-author (`Co-authored-by:`) in the commit. The pull request is then closed with a link to that commit rather than merged with GitHub's button. Keep your branch based on the latest `main` so the change applies cleanly.

## License

Fig Desktop is licensed under the Apache License 2.0. Unless you state otherwise, any contribution you submit is licensed under the same terms (Apache License 2.0, section 5). You keep the copyright to your contribution. Make sure you have the right to submit it, and do not include code under a license incompatible with Apache 2.0.
