// The container runner's files, read as text: the Dockerfile, the compose and Fly examples,
// the entrypoint, the image workflow and the guide. Building the image needs Docker; these
// checks catch what a build would not.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_VERSION } from '../plugin/lib/cloud/versions.mjs';
import { missing, pins } from '../runner/check-sf-plugins.mjs';
import { MIN_VERSIONS, atLeast } from '../plugin/packs/salesforce/doctor-salesforce.mjs';
import { SGD_LINE } from '../plugin/packs/salesforce/steps/sf-delta.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dockerfile = read('runner/Dockerfile');
const instructions = dockerfile.split('\n').filter((l) => /^[A-Z]+\s/.test(l));
// A Dockerfile ARG's default value.
const arg = (name) => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
const TOKENISH = /\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_|sk-ant-|sk_live_|AKIA[0-9A-Z]{8,})/;

describe('runner/Dockerfile', () => {
  it('starts from a pinned Node 22 slim image', () => {
    expect(instructions[0]).toMatch(/^FROM node:22\.\d+-bookworm-slim$/);
    expect(dockerfile).not.toMatch(/:latest\b/);
  });

  it('pins Claude Code to the version cloud runs use', () => {
    expect(dockerfile).toContain(`ARG CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`);
    expect(dockerfile).toContain('CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}');
  });

  it('does not hold Claude Code, which is Anthropic\'s: a stand-in fetches it into the volume', () => {
    expect(dockerfile).not.toContain('@anthropic-ai/claude-code');
    expect(dockerfile).toContain('COPY runner/claude.sh /usr/local/bin/claude');
    expect(dockerfile).toMatch(/FOREMAN_TOOLS=\/work\/\.foreman-tools/);
    expect(dockerfile).toMatch(/DISABLE_AUTOUPDATER=1/);
  });

  it('installs git, gh from the GitHub apt repository, certificates and ssh', () => {
    expect(dockerfile).toContain('https://cli.github.com/packages');
    for (const pkg of ['ca-certificates', 'git', 'openssh-client', 'gh']) expect(dockerfile).toMatch(new RegExp(`install[^\\n]*\\b${pkg}\\b`));
  });

  it('installs procps, so the check slots can read processes', () => {
    expect(dockerfile).toMatch(/install[^\n]*\bprocps\b/);
    expect(dockerfile.split('\n').filter((l) => /apt-get purge/.test(l)).join('\n')).not.toMatch(/procps/);
  });

  it('copies only the plugin, and points the sessions at it', () => {
    const copies = instructions.filter((l) => /^(COPY|ADD) /.test(l));
    expect(copies).toEqual(['COPY plugin /opt/foreman/plugin', 'COPY runner/entrypoint.sh /usr/local/bin/foreman-entrypoint', 'COPY runner/claude.sh /usr/local/bin/claude', 'COPY runner/THIRD-PARTY.md /opt/foreman/THIRD-PARTY.md']);
    expect(dockerfile).toMatch(/FOREMAN_PLUGIN_DIR=\/opt\/foreman\/plugin/);
    expect(dockerfile).toMatch(/PATH=\/opt\/foreman\/plugin\/bin:\$PATH/);
  });

  it('runs as the non-root foreman user, with HOME and the work folder on the /work volume', () => {
    const user = instructions.findIndex((l) => l === 'USER foreman');
    expect(user).toBeGreaterThan(-1);
    expect(instructions.slice(user).some((l) => l.startsWith('RUN '))).toBe(false);
    expect(dockerfile).toMatch(/HOME=\/work/);
    expect(dockerfile).toMatch(/FOREMAN_WORK=\/work/);
    expect(instructions).toContain('VOLUME /work');
  });

  it('starts `foreman cloud run`, with the dashboard listening beyond the container', () => {
    expect(instructions.at(-1)).toBe('ENTRYPOINT ["foreman-entrypoint"]');
    expect(read('runner/entrypoint.sh')).toMatch(/exec foreman cloud run "\$@"/);
    expect(dockerfile).toMatch(/FOREMAN_DASHBOARD_HOST=0\.0\.0\.0/);
    expect(instructions).toContain('EXPOSE 4317');
  });

  it('holds no secret', () => {
    expect(dockerfile).not.toMatch(TOKENISH);
    for (const l of instructions.filter((x) => /^(ENV|ARG) /.test(x))) {
      expect(l).not.toMatch(/(KEY|TOKEN|SECRET|PASSWORD)\w*=\S/);
    }
  });

  // The Salesforce layer: the RUN that reads SALESFORCE.
  const salesforceRun = dockerfile.indexOf('if [ "$SALESFORCE" = 1 ]');

  it('adds the Salesforce tools only with SALESFORCE=1, at exact pins', () => {
    expect(dockerfile).toContain('ARG SALESFORCE=0');
    for (const name of ['SF_CLI_VERSION', 'SF_PLUGIN_AGENT_VERSION', 'CODE_ANALYZER_VERSION', 'SGD_VERSION']) {
      expect(`${name}=${arg(name)}`).toMatch(new RegExp(`^${name}=\\d+\\.\\d+\\.\\d+$`));
    }
    expect(salesforceRun).toBeGreaterThan(-1);
    const run = dockerfile.slice(salesforceRun);
    expect(run).toContain('npm install --global "@salesforce/cli@${SF_CLI_VERSION}"');
    expect(run).toContain('sf plugins install "@salesforce/plugin-agent@${SF_PLUGIN_AGENT_VERSION}"');
    expect(run).toContain('sf plugins install "@salesforce/plugin-code-analyzer@${CODE_ANALYZER_VERSION}"');
    expect(run).toContain('sfdx-git-delta@${SGD_VERSION}');
    expect(run).toMatch(/apt-get install[^\n]*\bpython3\b[^\n]*\bopenjdk-17-jre-headless\b/);
    // Any other value stops the build rather than giving a plain image under the wrong name.
    expect(run).toMatch(/elif \[ "\$SALESFORCE" != 0 \]; then[^\n]*exit 1/);
  });

  it('pins sfdx-git-delta on the line the sf-delta ship step needs', () => {
    expect(arg('SGD_VERSION').startsWith(`${SGD_LINE}.`)).toBe(true);
  });

  it('pins at or above the versions the pack doctor needs', () => {
    expect(atLeast(arg('SF_CLI_VERSION'), MIN_VERSIONS['@salesforce/cli'])).toBe(true);
    expect(atLeast(arg('SGD_VERSION'), MIN_VERSIONS['sfdx-git-delta'])).toBe(true);
    expect(atLeast(arg('CODE_ANALYZER_VERSION'), MIN_VERSIONS['@salesforce/plugin-code-analyzer'])).toBe(true);
  });

  it('puts sf plugins where the foreman user finds them', () => {
    // HOME is /root while building and /work when running, so the plugins need a fixed data dir.
    const env = dockerfile.search(/^ENV SF_DATA_DIR=\/opt\/sf\/data\b/m);
    expect(env).toBeGreaterThan(-1);
    expect(env).toBeLessThan(salesforceRun);
    const envLine = dockerfile.slice(env).split('\n')[0];
    expect(envLine).toMatch(/\bSF_DISABLE_TELEMETRY=true\b/);
    expect(envLine).toMatch(/\bSF_AUTOUPDATE_DISABLE=true\b/);
    expect(dockerfile.slice(salesforceRun)).toContain('chown -R 10001');
    expect(dockerfile).toMatch(/useradd --uid 10001 /);
    expect(salesforceRun).toBeLessThan(dockerfile.indexOf('COPY plugin'));
  });
});

describe('runner/check-sf-plugins.mjs', () => {
  const AGENT = arg('SF_PLUGIN_AGENT_VERSION');
  const ANALYZER = arg('CODE_ANALYZER_VERSION');
  const SGD = arg('SGD_VERSION');
  // sf's own agent plugin ships inside the CLI under the same name, at an older version.
  const core = [
    { name: '@salesforce/cli', version: '2.155.7', type: 'core' },
    { name: '@salesforce/plugin-agent', version: '2.2.2', type: 'core' },
  ];
  const user = [
    { name: '@salesforce/plugin-agent', version: AGENT, type: 'user' },
    { name: '@salesforce/plugin-code-analyzer', version: ANALYZER, type: 'user' },
    { name: 'sfdx-git-delta', version: SGD, type: 'user' },
  ];
  const good = [...core, ...user];
  const coreAgentOnly = good.filter((p) => !(p.name === '@salesforce/plugin-agent' && p.type === 'user'));

  it('reads the pins from the Dockerfile, and stops when one is missing', () => {
    expect(pins(dockerfile)).toEqual({ '@salesforce/plugin-agent': AGENT, '@salesforce/plugin-code-analyzer': ANALYZER, 'sfdx-git-delta': SGD });
    expect(() => pins(dockerfile.replace(/^ARG SGD_VERSION=.*$/m, ''))).toThrow(/SGD_VERSION/);
  });

  it('passes a list holding every pinned plugin at its pin, bare, after warnings or in an envelope', () => {
    const wanted = pins(dockerfile);
    expect(missing(JSON.stringify(good), wanted)).toEqual([]);
    expect(missing(` ›   Warning: @salesforce/cli update available\n ›   Warning: another\n${JSON.stringify(good, null, 2)}`, wanted)).toEqual([]);
    expect(missing(JSON.stringify({ status: 0, result: good }), wanted)).toEqual([]);
  });

  it('does not count the core agent plugin at another version as the pinned one', () => {
    expect(missing(JSON.stringify(coreAgentOnly), pins(dockerfile))).toEqual([`@salesforce/plugin-agent@${AGENT}`]);
  });

  it('reports an absent plugin, and a reply with no list', () => {
    const wanted = pins(dockerfile);
    expect(missing(JSON.stringify(good.filter((p) => p.name !== 'sfdx-git-delta')), wanted)).toEqual([`sfdx-git-delta@${SGD}`]);
    expect(missing('Error: something went wrong', wanted)).toEqual(['sf printed no plugin list']);
    expect(missing('', wanted)).toEqual(['sf printed no plugin list']);
    expect(missing(JSON.stringify({ status: 0, result: { name: 'x' } }), wanted)).toEqual(['sf printed no plugin list']);
  });

  it('exits 0 for a good list and 1, naming the missing pin, for the core agent only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-sf-plugins-'));
    const script = fileURLToPath(new URL('../runner/check-sf-plugins.mjs', import.meta.url));
    const run = (list) => {
      const file = join(dir, 'plugins.json');
      writeFileSync(file, JSON.stringify(list));
      return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    };
    try {
      expect(run(good).status).toBe(0);
      const r = run(coreAgentOnly);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`not in sf plugins: @salesforce/plugin-agent@${AGENT.replace(/\./g, '\\.')}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with one line, no stack, when the file argument is missing or unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-sf-plugins-'));
    const script = fileURLToPath(new URL('../runner/check-sf-plugins.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    try {
      const none = run();
      expect(none.status).toBe(1);
      expect(none.stderr).toBe('usage: node runner/check-sf-plugins.mjs <plugins.json>\n');

      const nope = join(dir, 'nope.json');
      const absent = run(nope);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toBe(`cannot read ${nope}\n`);
      expect(absent.stderr).not.toMatch(/ERR_|ENOENT|\n\s+at /);

      const folder = run(dir);
      expect(folder.status).toBe(1);
      expect(folder.stderr).toBe(`cannot read ${dir}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runner/entrypoint.sh', () => {
  const text = read('runner/entrypoint.sh');
  it('as root, gives /work to foreman and drops to it; otherwise runs as it is', () => {
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toMatch(/if \[ "\$\(id -u\)" = 0 \]; then/);
    expect(text).toContain('chown foreman:foreman /work');
    expect(text).toMatch(/exec setpriv --reuid=foreman --regid=foreman --init-groups "\$0" "\$@"/);
  });

  // Runs the script with fake id, chown, setpriv and foreman that log what they were asked.
  const runAs = (uid) => {
    const bin = mkdtempSync(join(tmpdir(), 'foreman-entrypoint-'));
    const log = join(bin, 'log');
    const fake = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    fake('id', `echo ${uid}`);
    for (const name of ['chown', 'setpriv', 'foreman', 'claude']) fake(name, `echo "${name} $*" >> "${log}"`);
    const script = fileURLToPath(new URL('../runner/entrypoint.sh', import.meta.url));
    const r = spawnSync('sh', [script, '--extra'], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    const lines = r.status === 0 ? readFileSync(log, 'utf8').trim().split('\n').map((l) => l.replace(script, 'ENTRYPOINT')) : [r.stderr];
    rmSync(bin, { recursive: true, force: true });
    return lines;
  };

  it('behaves so when run', () => {
    expect(runAs(0)).toEqual(['chown foreman:foreman /work', 'setpriv --reuid=foreman --regid=foreman --init-groups ENTRYPOINT --extra']);
  });

  it('as foreman, fetches Claude Code before the run starts, so story sessions never race to fetch it', () => {
    expect(runAs(10001)).toEqual(['claude --version', 'foreman cloud run --extra']);
  });
});

describe('runner/claude.sh', () => {
  // Runs the stand-in with a fake npm that logs its arguments and writes a claude that echoes its own.
  const setUp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-claude-'));
    const bin = join(dir, 'bin');
    const tools = join(dir, 'tools');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "${join(dir, 'log')}"\n[ -n "$NPM_FAILS" ] && { echo 'npm ERR! network' >&2; exit 1; }\necho 'added 1 package'\nmkdir -p "${tools}/bin"\nprintf '#!/bin/sh\\necho "real claude $*"\\n' > "${tools}/bin/claude"\nchmod 755 "${tools}/bin/claude"\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const run = (version, args, more = {}) => spawnSync('sh', [fileURLToPath(new URL('../runner/claude.sh', import.meta.url)), ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, FOREMAN_TOOLS: tools, CLAUDE_CODE_VERSION: version, ...more }, encoding: 'utf8' });
    const npmCalls = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);
    return { dir, tools, run, npmCalls };
  };

  it('fetches the pinned version on first use, into the tools folder, and passes the arguments on', () => {
    const { dir, tools, run, npmCalls } = setUp();
    const r = run('1.2.3', ['-p', 'hello world']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('real claude -p hello world\n');
    expect(r.stderr).toContain('fetching Claude Code 1.2.3');
    expect(npmCalls()).toEqual([`npm install --global --prefix ${tools} --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code@1.2.3`]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fetches once, and again only when the pinned version changes', () => {
    const { dir, run, npmCalls } = setUp();
    run('1.2.3', ['--version']);
    const again = run('1.2.3', ['--version']);
    expect(again.stdout).toBe('real claude --version\n');
    expect(again.stderr).toBe('');
    expect(npmCalls()).toHaveLength(1);
    run('1.2.4', ['--version']);
    expect(npmCalls()).toHaveLength(2);
    expect(npmCalls()[1]).toContain('@anthropic-ai/claude-code@1.2.4');
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops with a plain reason when the fetch fails, and tries again next time', () => {
    const { dir, run, npmCalls } = setUp();
    const r = run('1.2.3', ['--version'], { NPM_FAILS: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('could not fetch Claude Code 1.2.3');
    expect(r.stderr).toContain('registry.npmjs.org');
    expect(run('1.2.3', ['--version']).stdout).toBe('real claude --version\n');
    expect(npmCalls()).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('runner/compose.yaml', () => {
  const text = read('runner/compose.yaml');
  it('keeps /work on a volume, takes the settings from an env file, and restarts only on failure', () => {
    expect(text).toMatch(/- foreman-work:\/work/);
    expect(text).toMatch(/env_file: foreman\.env/);
    expect(text).toMatch(/restart: on-failure/);
    expect(text).toMatch(/stop_grace_period: \d+m/);
  });

  it('publishes the dashboard on this machine only', () => {
    expect(text).toMatch(/- "127\.0\.0\.1:4317:4317"/);
  });

  it('holds no secret', () => {
    expect(text).not.toMatch(TOKENISH);
  });

  it('copies the file Set up writes rather than one filled in by hand', () => {
    expect(text).not.toMatch(/fill it in/);
    expect(text).toContain('cp .env.runner runner/foreman.env');
  });
});

describe('runner/foreman.env.example', () => {
  const text = read('runner/foreman.env.example');
  it('names every setting and holds no value for a secret', () => {
    for (const name of ['FOREMAN_REPO', 'FOREMAN_BRANCH', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'FOREMAN_DASHBOARD_TOKEN', 'FOREMAN_WORKERS', 'FOREMAN_MAX']) {
      expect(text).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
    }
    for (const line of text.split('\n').filter((l) => /^(GH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|FOREMAN_DASHBOARD_TOKEN)=/.test(l))) expect(line).toMatch(/=$/);
  });

  it('is kept out of git once filled in', () => {
    expect(read('.gitignore')).toMatch(/^runner\/foreman\.env$/m);
  });
});

describe('runner/fly.toml', () => {
  const text = read('runner/fly.toml');
  it('mounts a volume at /work, waits for stories in progress on a stop, and keeps one machine running', () => {
    expect(text).toMatch(/\[mounts\]\n\s+source = "\w+"\n\s+destination = "\/work"/);
    expect(text).toMatch(/kill_timeout = \d+/);
    expect(text).toMatch(/auto_stop_machines = "off"/);
    expect(text).toMatch(/internal_port = 4317/);
    expect(text).toMatch(/dockerfile = "fly\.Dockerfile"/);
  });

  it('starts as root only to hand the volume to foreman', () => {
    const fly = read('runner/fly.Dockerfile').split('\n').filter((l) => /^[A-Z]+\s/.test(l));
    expect(fly).toEqual([expect.stringMatching(/^FROM ghcr\.io\/finefactory-ai\/foreman-runner:\d+\.\d+\.\d+$/), 'USER root']);
  });
});

describe('.github/workflows/runner-image.yml', () => {
  const text = read('.github/workflows/runner-image.yml');
  it('builds the image on each release tag from runner/Dockerfile, with the repository as context', () => {
    expect(text).toMatch(/tags:\s*\['v\*'\]/);
    expect(text).toMatch(/file: runner\/Dockerfile/);
    expect(text).toMatch(/context: \./);
  });

  it('builds only in the FineFactory copy, not in the workshop', () => {
    expect(text).toMatch(/^\s+if: github\.repository == 'Finefactory-ai\/foreman'$/m);
  });

  it('names the image after the owner in lower case, as GHCR requires', () => {
    // The owner is Finefactory-ai; a capital letter in an image name fails the build.
    expect(text).toContain('${GITHUB_REPOSITORY_OWNER,,}');
    expect(text).not.toContain('ghcr.io/${{ github.repository_owner }}');
  });

  it('checks the tag is the plugin version, tries the image, then pushes it to GHCR', () => {
    expect(text).toMatch(/plugin\.json/);
    expect(text).toMatch(/foreman --help/);
    expect(text).toMatch(/claude --version/);
    expect(text).toMatch(/command -v setpriv/);
    expect(text).toMatch(/docker push "\$IMAGE"/);
    expect(text).toMatch(/packages: write/);
    expect(text.indexOf('claude --version')).toBeLessThan(text.indexOf('docker push'));
  });

  it('also builds, tries and pushes a -salesforce image', () => {
    expect(text).toContain("suffix: '-salesforce'");
    expect(text).toContain("salesforce: '1'");
    expect(text).toContain('build-args: SALESFORCE=${{ matrix.salesforce }}');
    expect(text).toContain('fail-fast: false');
    expect(text).toMatch(/foreman-runner:\$VERSION\$SUFFIX"/);
    expect(text).toContain('sf plugins --core');
    expect(text).toContain('python3 --version');
    expect(text).toContain('java -version');
    expect(text.indexOf('java -version')).toBeLessThan(text.indexOf('docker push'));
  });

  // The text of each `if [ "$SALESFORCE" = 1 ]; then` ... `fi` block in the workflow.
  const guarded = () => {
    const blocks = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*if \[ "\$SALESFORCE" = 1 \]; then/.test(lines[i])) continue;
      if (/;\s*fi\b/.test(lines[i])) {
        blocks.push(lines[i]);
        continue;
      }
      const end = lines.findIndex((l, j) => j > i && /^\s*fi\s*$/.test(l));
      blocks.push(lines.slice(i, end + 1).join('\n'));
      i = end;
    }
    return blocks;
  };
  const SF_TRIES = ['sf --version', 'sf plugins --core --json', 'node runner/check-sf-plugins.mjs', 'python3 --version', 'java -version'];

  it('tries the Salesforce tools only inside the SALESFORCE guard of the try step', () => {
    const step = text.slice(text.indexOf('- name: Try the image'), text.indexOf('- name: Record the resolved packages'));
    const start = step.indexOf('if [ "$SALESFORCE" = 1 ]; then');
    expect(start).toBeGreaterThan(-1);
    const block = step.slice(start, step.slice(start).search(/^\s*fi\s*$/m) + start);
    for (const s of SF_TRIES) expect(`${s}: ${block.includes(s)}`).toBe(`${s}: true`);
    let outside = text;
    for (const b of guarded()) outside = outside.replace(b, '');
    for (const s of SF_TRIES) expect(`${s}: ${outside.includes(s)}`).toBe(`${s}: false`);
    expect(step.indexOf('foreman --help')).toBeLessThan(start);
    expect(step.indexOf('claude --version')).toBeLessThan(start);
  });

  it('proves each pinned plugin version, not just its name', () => {
    expect(text).not.toContain('grep -Eq "\\"name\\"');
    const check = text.indexOf('node runner/check-sf-plugins.mjs "$RUNNER_TEMP/sf-plugins.json"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(text.indexOf('docker push'));
  });

  it('records the resolved package trees before the push', () => {
    const global = text.indexOf('npm ls --global --all');
    const sf = text.indexOf('npm ls --all --prefix "$SF_DATA_DIR"');
    expect(global).toBeGreaterThan(-1);
    expect(sf).toBeGreaterThan(-1);
    expect(guarded().some((b) => b.includes('npm ls --all --prefix "$SF_DATA_DIR"'))).toBe(true);
    expect(global).toBeLessThan(text.indexOf('docker push'));
    expect(sf).toBeLessThan(text.indexOf('docker push'));
  });
});

describe('the GitHub token the guides ask for', () => {
  // One line per sentence, whatever the wrapping (and a .env file's comment marks).
  const flat = (text) => text.replace(/\n#?[ \t]*/g, ' ');

  it('is a classic token with the repo scope, or a fine-grained one with the permissions the ci step can use', () => {
    for (const path of ['runner/README.md', 'runner/foreman.env.example']) {
      const text = flat(read(path));
      const has = (re) => expect(`${path}: ${re.test(text)}`).toBe(`${path}: true`);
      has(/classic token with the `?repo`? scope/);
      has(/fine-grained token for the (project|repository) with Contents and Pull requests read and write, and Actions and Commit statuses read/);
      has(/Deployments read/);
      // What a fine-grained token gives up: checks that other apps post.
      has(/a check that other apps post is not seen/);
      // Fine-grained tokens have no Checks permission, and they work now.
      expect(text).not.toMatch(/Checks and Commit statuses read/);
      expect(text).not.toMatch(/fine-grained token (cannot|can't) read a pull request's check runs/);
    }
  });
});

describe('the attribution note', () => {
  it('says a fresh machine has no Claude Code user settings, and how a project turns attribution off', () => {
    for (const path of ['runner/README.md']) {
      const text = read(path);
      expect(`${path}: ${/no Claude Code user settings/.test(text)}`).toBe(`${path}: true`);
      expect(text).toContain('"attribution": { "commit": "", "pr": "", "sessionUrl": false }');
    }
  });
});

describe('the release', () => {
  it('every image tag in the runner files and guides is this version', () => {
    const version = JSON.parse(read('plugin/.claude-plugin/plugin.json')).version;
    for (const path of ['runner/compose.yaml', 'runner/fly.Dockerfile', 'runner/README.md', 'README.md']) {
      const tags = [...read(path).matchAll(/foreman-runner:(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      for (const tag of tags) expect(`${path}: ${tag}`).toBe(`${path}: ${version}`);
    }
    // `#ref` is the form Claude Code's docs show for /plugin marketplace add.
    for (const path of ['README.md']) expect(read(path), path).toContain(`/plugin marketplace add finefactory-ai/foreman#v${version}`);
    expect(JSON.parse(read('package.json')).version).toBe(version);
  });
});

describe('the install line', () => {
  it('uses #vX.Y.Z, never @vX.Y.Z', () => {
    for (const path of ['README.md']) expect(read(path), path).not.toMatch(/[\w-]+\/foreman@v/);
  });
});

describe('one source for the user guide', () => {
  const OLD_GUIDE = ['plugin/docs', 'guide.md'].join('/');

  it('is the website: the README links it and keeps none of its sections', () => {
    const readme = read('README.md');
    expect(readme).toContain('https://finefactory.ai/apps/foreman/docs/');
    expect(readme).not.toContain(OLD_GUIDE);
    for (const heading of ['## Settings', '## Stories from Jira', '## How Foreman learns']) expect(readme).not.toMatch(new RegExp(`^${heading}$`, 'm'));
  });

  it('is what runner/README.md points to, not the main README', () => {
    const text = read('runner/README.md');
    expect(text).toContain('https://finefactory.ai/apps/foreman/docs/#in-github-actions');
    expect(text).not.toContain(OLD_GUIDE);
    expect(text).not.toContain('the main README');
  });
});

describe('runner/README.md', () => {
  const text = read('runner/README.md');
  it('covers docker run, compose, Fly, the dashboard token and Jira without a browser', () => {
    expect(text).toMatch(/docker run /);
    expect(text).toMatch(/docker compose -f runner\/compose\.yaml/);
    expect(text).toMatch(/fly secrets set /);
    expect(text).toMatch(/\?token=/);
    expect(text).toMatch(/foreman jira login --paste/);
  });

  it('takes the settings from the file Set up › Cloud runner writes, never a hand-filled one', () => {
    expect(text).toContain('--env-file .env.runner');
    expect(text).toContain('cp .env.runner runner/foreman.env');
    expect(text).not.toMatch(/then fill it in/);
    expect(text).not.toContain('--env-file runner/foreman.env');
  });

  it('documents every setting', () => {
    for (const name of ['FOREMAN_REPO', 'FOREMAN_REPO_URL', 'FOREMAN_BRANCH', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'FOREMAN_DASHBOARD_TOKEN', 'FOREMAN_WORKERS', 'FOREMAN_MAX', 'cloud.envVars', 'cloud.idleMinutes']) {
      expect(text).toContain(name);
    }
  });

  it('documents the Salesforce image', () => {
    expect(text).toContain('foreman-runner:<version>-salesforce');
    expect(text).toContain('--build-arg SALESFORCE=1');
    expect(text).toMatch(/foreman cloud doctor/);
  });
});

describe("Foreman's home", () => {
  it('is finefactory-ai/foreman for the Actions template', () => {
    expect(read('plugin/lib/cloud/versions.mjs')).toContain("FOREMAN_SOURCE = 'finefactory-ai/foreman'");
  });

  it('names the organisation, not a person, as the marketplace owner', () => {
    expect(JSON.parse(read('.claude-plugin/marketplace.json')).owner).toEqual({ name: 'finefactory.ai' });
  });
});
