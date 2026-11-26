# Security Policy

## Supported versions

Fig Desktop is in a 0.x source preview. Only the latest release receives security fixes.

## Reporting a vulnerability

Please do not report security problems in public issues or pull requests.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include what is affected, how to reproduce it, and the Fig Desktop and DSH versions (shown in **About Fig Desktop**).

You can expect an acknowledgement within 7 days. Please give a reasonable time to release a fix before you disclose the problem.

## Scope

In scope is the code in this repository, for example:

- handling of model sign-ins, API keys and other credentials;
- the local interfaces between Fig's main process, DSH and Fig's plugins;
- signature, hash and version checks on plugin packages and plugin updates;
- opening files, links and local pages from the app.

Out of scope, and best reported upstream:

- vulnerabilities in DSH itself, Electron or other dependencies, unless Fig's use of them creates the problem;
- the services of model providers such as DeepSeek, OpenAI or xAI.
