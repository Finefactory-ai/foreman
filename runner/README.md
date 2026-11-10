# Foreman's container runner

A container that runs Foreman on its own: it clones your project, builds stories until the
backlog is empty, waits, pulls, and picks again. The dashboard runs inside it, behind a token.
It is the main way to run Foreman in the cloud. For a lighter way with no machine of your own,
see "In GitHub Actions" in the user guide, <https://finefactory.ai/apps/foreman/docs/#in-github-actions>.

Until Foreman's own proof run (story C5), the image has been built only by its workflow. The
commands below are what that run will check.

## The image

Each release tag publishes `ghcr.io/finefactory-ai/foreman-runner:<version>`. While the
Foreman repository is private, so is the image: sign in first with
`docker login ghcr.io` (a GitHub token with `read:packages`). Or build it yourself from a
Foreman checkout:

```
docker build -f runner/Dockerfile -t foreman-runner .
```

It holds Node 22, git, gh and Foreman's plugin at `/opt/foreman/plugin`. Claude Code is
Anthropic's and is not in the image: the first time the container starts, it fetches the pinned
version from npm into `/work/.foreman-tools`, which takes a few seconds and needs to reach
`registry.npmjs.org`. It stays on the volume, so later starts are immediate. It runs as the user `foreman`, with `/work` as its volume and its home.
No secret is in the image.

For projects with `"pack": "salesforce"`, each release also publishes
`ghcr.io/finefactory-ai/foreman-runner:<version>-salesforce`. It adds `sf`, the pinned agent
plugin, sfdx-git-delta, Code Analyzer v5, Python 3 and Java, at pinned versions. To build it
yourself:

```
docker build -f runner/Dockerfile --build-arg SALESFORCE=1 -t foreman-runner-salesforce .
```

When the pack is on, `foreman cloud doctor` checks these tools, and stops a runner that lacks
them with the name of the image that has them.

The image also holds software made by others, under their own licences:
[THIRD-PARTY.md](THIRD-PARTY.md) lists it, and the same file is at `/opt/foreman/THIRD-PARTY.md`
inside the image.

## Settings

On your laptop, Set up › Cloud runner writes all of these into `.env.runner` (mode 600, kept
out of git), from the keys saved on its other steps. The table lists what that file holds.

All settings come from the environment. Pass secrets as secrets, never in the image.

| Variable | Needed | What |
|---|---|---|
| `FOREMAN_REPO` | yes | the project, as `owner/name` |
| `FOREMAN_REPO_URL` | no | where to clone from, if not `https://github.com/<FOREMAN_REPO>.git` |
| `FOREMAN_BRANCH` | no | the base branch, default `main` |
| `GH_TOKEN` | yes | a classic token with the `repo` scope (add `workflow` if a story may change `.github/workflows`), or a fine-grained token for the project with Contents and Pull requests read and write, and Actions and Commit statuses read (add Workflows read and write if a story may change `.github/workflows`, and Deployments read if `ship.steps` has `deploy-github`). A fine-grained token can't read check runs, so Foreman waits on GitHub Actions jobs and commit statuses instead: a check that other apps post is not seen. If your CI is such an app, use a classic token. Pushes made with it start CI. |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | one | a Console API key, or a subscription token from `claude setup-token` (your own projects only). The API key wins when both are set. |
| `FOREMAN_DASHBOARD_TOKEN` | yes | the dashboard listens beyond the container, so it needs a token |
| `FOREMAN_WORKERS` | no | how many slots build at once; default the `workers` setting |
| `FOREMAN_MAX` | no | stop after this many stories; default: run until stopped |
| the project's own keys | as needed | the names in `cloud.envVars` in `foreman.config.json`, and any an adapter needs. Foreman's own keys among them (such as `RESEND_API_KEY`, `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET`) are written to `.env.foreman` inside `/work/repo` (mode 600, kept out of git through the clone's `.git/info/exclude`, and never put in a story workspace); the rest go to the project's env file there, which git must ignore. None is ever logged. |

`runner/foreman.env.example` lists them. `cloud.idleMinutes` in the project's config (default
10) is how long the runner waits before it looks again once the backlog is empty.

## Run it

```
docker run -d --name foreman --restart on-failure --stop-timeout 900 \
  --env-file .env.runner -v foreman-work:/work -p 127.0.0.1:4317:4317 \
  ghcr.io/finefactory-ai/foreman-runner:0.11.0
```

At start it runs `foreman cloud doctor`, and stops with the reason if a check fails: the
tokens, that the GitHub token works, can push to the project and can read the checks of its
newest pull request (as the `ci` ship step reads them), that Claude answers, the
plugin's version, that `/work` can be written, the dashboard token, and, once the project is
cloned, the Docker socket and the state branch when the config needs them, and the Salesforce
tools when the pack is on. Run the checks on
their own with `docker run --rm --env-file .env.runner --entrypoint foreman <image> cloud doctor`.

With Docker Compose:

```
cp .env.runner runner/foreman.env
docker compose -f runner/compose.yaml up -d --build
docker compose -f runner/compose.yaml logs -f
```

## Stopping

`docker stop` sends SIGTERM: the run finishes the stories in progress, then stops. A story can
take a while, so give it time (`--stop-timeout 900`, or `stop_grace_period` in
`compose.yaml`); a second SIGTERM stops it at once (`docker kill -s TERM foreman`). A story cut
off midway is resumed at the next start. The container restarts only after a failure, so a
stop, from Docker or from the dashboard, stays stopped. `docker start foreman` starts it
again.

## The dashboard

Open `http://localhost:4317/?token=<FOREMAN_DASHBOARD_TOKEN>`. Every request needs the token,
as `Authorization: Bearer <token>` or, for a page in a browser, `?token=`. To reach it from
elsewhere, put it behind HTTPS (the Fly example below does) rather than publishing the port
on every address.

## Jira without a browser

The sign-in tokens live in `/work/.config/foreman`, on the volume, so they survive restarts.
Sign in once from inside the container:

```
docker exec -it -w /work/repo foreman foreman jira login --paste
```

It prints the consent address. Open it in any browser and approve. The browser then lands on
`http://localhost:8765/callback?code=…`, a page that does not load, which is expected. Paste
that whole address back into the command. First save the two keys, `JIRA_CLIENT_ID` and
`JIRA_CLIENT_SECRET`, on Set up › Jira app, and list them in `cloud.envVars`, before Set up ›
Cloud runner writes `.env.runner`.

## Claude Code settings in the container

A container or an Actions runner has no Claude Code user settings, so Claude Code's own
defaults apply there, whatever your laptop's settings say. One you may notice: the commits and
pull requests it makes get a "Co-Authored-By: Claude" line. To turn that off everywhere, put
this in the project's committed `.claude/settings.json`:

```json
"attribution": { "commit": "", "pr": "", "sessionUrl": false }
```

## Slot environments and other stacks

- `env.adapter: "none"` works as it is.
- `docker` and `supabase` need the host's Docker: mount `/var/run/docker.sock` (the line is in
  `compose.yaml`), and add the tools to the image: the Docker CLI with Compose, and for
  `supabase` the Supabase CLI. The foreman user also needs access to the socket
  (`--group-add <the socket's group id>`).
- A project in another language needs its toolchain. Build on this image:

  ```dockerfile
  FROM ghcr.io/finefactory-ai/foreman-runner:0.11.0
  USER root
  RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
  USER foreman
  ```

## Fly.io

`runner/fly.toml` and `runner/fly.Dockerfile` are a starting point. Fly mounts volumes owned
by root, so `fly.Dockerfile` starts the image as root; its entrypoint gives `/work` to
`foreman` and runs everything as `foreman`.

```
cd runner
# set app and FOREMAN_REPO in fly.toml first
fly apps create my-foreman
fly volumes create foreman_work --size 10 --region iad
fly secrets set GH_TOKEN=… CLAUDE_CODE_OAUTH_TOKEN=… FOREMAN_DASHBOARD_TOKEN=…
fly deploy --local-only
```

`--local-only` builds with your own Docker, which can pull the private image once you have
signed in to ghcr.io. The dashboard is then at `https://my-foreman.fly.dev/?token=…`.
