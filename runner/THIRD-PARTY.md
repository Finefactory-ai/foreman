# Other software in the runner image

The runner image holds Foreman and the software Foreman needs to run. Foreman's licence, the
Functional Source License, covers only Foreman itself, which is in `/opt/foreman/plugin`.
Everything else in the image is made by others and comes under its own licence, not Foreman's.

## What is in it

- **Debian** (the `bookworm-slim` base) and the Debian packages added to it: `ca-certificates`,
  `curl`, `git`, `openssh-client`, `procps`, and what they depend on. Some are under the GNU
  General Public License.
- **Node.js** and npm, from the official Node image.
- **GitHub CLI** (`gh`).
- In the `-salesforce` image only: **Python 3**, **OpenJDK 17**, the **Salesforce CLI** (`sf`)
  with its agent and Code Analyzer plugins, and **sfdx-git-delta**.

## What is not in it

**Claude Code** (`@anthropic-ai/claude-code`) is Anthropic's and is not part of the image. The
first time the container needs it, it fetches the pinned version from npm into your `/work`
volume, where you use it under Anthropic's terms.

## Where each licence is

- Debian packages: `/usr/share/doc/<package>/copyright` inside the image.
- npm packages: the `LICENSE` file in each package's folder under `/usr/local/lib/node_modules`.
- Salesforce CLI plugins: each plugin's folder under `/opt/sf/data`.

## Source code

The source of every Debian package in the image is at
[snapshot.debian.org](https://snapshot.debian.org/) and through `apt-get source`. For three
years after a release of the image, we will also supply the source of any GPL-licensed part of
it on request to hello@finefactory.ai.
