import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SESSION_SETTINGS,
  SF_PLUGIN,
  activeScratchQuery,
  aliasStray,
  allowList,
  binDir,
  dataDir,
  findRealSf,
  homeVerdict,
  isolatedEnv,
  keyRoot,
  listedEntry,
  setUp,
  sfHome,
  wrapperScript,
} from './isolation.mjs';
import { SF_PROD_CHECK } from './prod-block.mjs';
import { writeScratchOrg } from './scratch-orgs.mjs';
import { ACME_DEV1_ID, ACME_PROD_ID, ACME_QA_ID, ACME_UAT_ID, ORG_LIST, acmeOrg, fakeSfShell, orgList, orgRecord, orgRoute, sfError, sfOk } from '../../../test/fake-sf.mjs';

const STRAY_ID = '00D000000000009AAA';
const entry = acmeOrg;
const DEV1 = entry('acme-dev1', ACME_DEV1_ID);
const QA = entry('acme-qa', ACME_QA_ID);
const MAIN = entry('acme-main', ACME_PROD_ID);

// The Acme block: one build sandbox and a QA sandbox.
const block = () => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
});
// The same, with the Acme production org listed and marked "production": true.
const withMain = () => {
  const b = block();
  b.orgs['acme-main'] = { orgId: ACME_PROD_ID, production: true };
  return b;
};
const NOT_SANDBOX = (name) => `${name} in the isolated sf home is not a sandbox and salesforce.orgs does not mark it "production": true; deployments to production are blocked`;

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfiso-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const exe = (file, text = '#!/bin/sh\nexit 0\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
  return file;
};

describe('sfHome, binDir and dataDir', () => {
  it('takes FOREMAN_SF_HOME, and falls back to ~/.config/foreman/sf-home when it is empty or unset', () => {
    expect(sfHome({ FOREMAN_SF_HOME: '/srv/acme/sf-home' }, '/home/acme')).toBe('/srv/acme/sf-home');
    expect(sfHome({ FOREMAN_SF_HOME: '' }, '/home/acme')).toBe('/home/acme/.config/foreman/sf-home');
    expect(sfHome({}, '/home/acme')).toBe('/home/acme/.config/foreman/sf-home');
  });
  it('keeps the key folder at ~/.config/foreman/sf, beside the default home', () => {
    expect(keyRoot('/home/acme')).toBe(path.join('/home/acme', '.config', 'foreman', 'sf'));
  });
  it('puts the wrappers in <home>/.foreman/bin', () => {
    expect(binDir('/srv/acme/sf-home')).toBe('/srv/acme/sf-home/.foreman/bin');
  });
  it('finds the data dir from SF_DATA_DIR, then XDG_DATA_HOME/sf, then ~/.local/share/sf', () => {
    expect(dataDir({ SF_DATA_DIR: '/d/sf', XDG_DATA_HOME: '/x' }, '/home/acme')).toBe('/d/sf');
    expect(dataDir({ XDG_DATA_HOME: '/x' }, '/home/acme')).toBe('/x/sf');
    expect(dataDir({}, '/home/acme')).toBe('/home/acme/.local/share/sf');
  });
  it('builds the isolated environment over the caller one', () => {
    expect(isolatedEnv({ PATH: '/bin', HOME: '/home/acme' }, '/h', '/home/acme')).toEqual({
      PATH: '/bin',
      HOME: '/h',
      SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
      SF_DISABLE_TELEMETRY: 'true',
      SF_DATA_DIR: '/home/acme/.local/share/sf',
    });
  });
});

describe('findRealSf', () => {
  it('returns the first executable sf on PATH', () => {
    const a = exe(path.join(tmp, 'a', 'sf'));
    exe(path.join(tmp, 'b', 'sf'));
    expect(findRealSf({ PATH: [path.join(tmp, 'a'), path.join(tmp, 'b')].join(path.delimiter) }, fs, path.join(tmp, 'skip'))).toBe(a);
  });
  it('skips the wrapper folder, a Foreman wrapper elsewhere, and files that are not executable', () => {
    const skip = path.join(tmp, 'skip');
    exe(path.join(skip, 'sf'));
    fs.mkdirSync(path.join(tmp, 'plain'));
    fs.writeFileSync(path.join(tmp, 'plain', 'sf'), '#!/bin/sh\n');
    fs.chmodSync(path.join(tmp, 'plain', 'sf'), 0o644);
    exe(path.join(tmp, 'other', 'sf'), wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d' }));
    fs.mkdirSync(path.join(tmp, 'folder', 'sf'), { recursive: true });
    const real = exe(path.join(tmp, 'real', 'sf'));
    const PATH = ['skip', 'plain', 'other', 'folder', 'real'].map((d) => path.join(tmp, d)).join(path.delimiter);
    expect(findRealSf({ PATH }, fs, skip)).toBe(real);
  });
  it('returns null when there is none', () => {
    expect(findRealSf({ PATH: path.join(tmp, 'none') }, fs, path.join(tmp, 'skip'))).toBeNull();
    expect(findRealSf({}, fs, path.join(tmp, 'skip'))).toBeNull();
  });
});

describe('the wrapper, run for real', { timeout: 30_000 }, () => {
  let realSf;
  let wrapper;
  let home;
  let marker;
  let data;
  beforeEach(() => {
    const odd = path.join(tmp, "it's a dir");
    realSf = exe(path.join(odd, 'sf'), [
      '#!/bin/sh',
      'touch "$FAKE_MARKER"',
      'printf "HOME=%s\\n" "$HOME"',
      'printf "KEYCHAIN=%s\\n" "$SF_USE_GENERIC_UNIX_KEYCHAIN"',
      'printf "TELEMETRY=%s\\n" "$SF_DISABLE_TELEMETRY"',
      'printf "DATA=%s\\n" "$SF_DATA_DIR"',
      'for a in "$@"; do printf "ARG=%s\\n" "$a"; done',
      '',
    ].join('\n'));
    data = path.join(tmp, "real data's dir", 'sf');
    home = path.join(tmp, 'sf-home');
    wrapper = exe(path.join(binDir(home), 'sf'), wrapperScript({ realSf, dataDir: data }));
    marker = path.join(tmp, 'ran');
  });
  const run = (env) => spawnSync(wrapper, ['org', 'list', '--target-org', 'acme dev 1'], { env: { PATH: '/usr/bin:/bin', FAKE_MARKER: marker, ...env }, encoding: 'utf8' });

  it('runs the real sf in the isolated home, with the keychain, telemetry and data dir set, and the args intact', () => {
    const r = run({ HOME: path.join(tmp, 'real-home'), FOREMAN_SF_HOME: home, SF_DISABLE_TELEMETRY: 'false' });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      `HOME=${home}`,
      'KEYCHAIN=true',
      'TELEMETRY=true',
      `DATA=${data}`,
      'ARG=org',
      'ARG=list',
      'ARG=--target-org',
      'ARG=acme dev 1',
      '',
    ]);
  });
  it('refuses to run sf when FOREMAN_SF_HOME is not set', () => {
    for (const env of [{ HOME: path.join(tmp, 'real-home') }, { HOME: path.join(tmp, 'real-home'), FOREMAN_SF_HOME: '' }]) {
      const r = run(env);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('FOREMAN_SF_HOME is not set');
      expect(fs.existsSync(marker)).toBe(false);
    }
  });
});

// Once a production org is signed in to the home, the Bash guard cannot be the only thing
// between a session and a production deploy: launchers, scripts and a default org written to
// .sf/config.json all get past it. The wrapper checks every sf call itself.
describe('the wrapper with a production org marked, run for real', { timeout: 30_000 }, () => {
  const PROD_USER = 'ops@acme.example';
  const DEV1_USER = 'dev1@acme.example';
  const production = [{ alias: 'acme-main', orgId: ACME_PROD_ID }];
  let home;
  let work;
  let marker;
  let bin;
  let realSf;
  beforeEach(() => {
    realSf = exe(path.join(tmp, 'real', 'sf'), ['#!/bin/sh', 'touch "$FAKE_MARKER"', 'for a in "$@"; do printf "ARG=%s\\n" "$a"; done', ''].join('\n'));
    home = path.join(tmp, 'sf-home');
    bin = binDir(home);
    for (const name of ['sf', 'sfdx']) exe(path.join(bin, name), wrapperScript({ realSf, dataDir: path.join(tmp, 'data'), production }));
    const sfdx = path.join(home, '.sfdx');
    fs.mkdirSync(sfdx, { recursive: true });
    fs.writeFileSync(path.join(sfdx, 'alias.json'), JSON.stringify({ orgs: { 'acme-main': PROD_USER, 'acme-dev1': DEV1_USER } }));
    fs.writeFileSync(path.join(sfdx, `${PROD_USER}.json`), JSON.stringify({ orgId: ACME_PROD_ID }));
    fs.writeFileSync(path.join(sfdx, `${DEV1_USER}.json`), JSON.stringify({ orgId: ACME_DEV1_ID }));
    work = path.join(tmp, 'worktree');
    fs.mkdirSync(path.join(work, '.sf'), { recursive: true });
    fs.writeFileSync(path.join(work, 'sfdx-project.json'), '{}');
    fs.writeFileSync(path.join(work, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'acme-dev1' }));
    marker = path.join(tmp, 'ran');
  });
  const PATH = () => [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  const run = (command, env = {}) => {
    fs.rmSync(marker, { force: true });
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: work, env: { PATH: PATH(), FOREMAN_SF_HOME: home, FAKE_MARKER: marker, ...env }, encoding: 'utf8' });
    return { ...r, ran: fs.existsSync(marker) };
  };
  // Refused for a deploy, for a command that prints credentials or calls the API directly, or for
  // any other command off the allow-list.
  const refused = (command) => {
    const r = run(command);
    expect(r.ran, command).toBe(false);
    expect(r.status, command).not.toBe(0);
    expect(r.stderr, command).toMatch(/Foreman never deploys to production|prints or hands out the credentials of acme-main|this command is not one Foreman allows against production|changes metadata in acme-main|--flags-dir/);
    expect(r.stderr, command).not.toContain(PROD_USER);
  };

  it('refuses a production deploy behind a launcher with flags', () => {
    refused('nice -n 5 sf project deploy start -o acme-main');
    refused('env -u FAKE sf project deploy start -o acme-main');
    refused('echo acme-main | xargs sf project deploy start -o');
    refused(`sfdx force:source:deploy -p force-app -u ${ACME_PROD_ID}`);
  });
  it('refuses a raw deploy call and a credential command behind a launcher or in a script', () => {
    refused('nice -n 5 sf api request rest /services/data/v62.0/metadata/deployRequest --method POST -o acme-main');
    refused('nice -n 5 sf org display --verbose -o acme-main');
    refused('nice -n 5 sf devops promote -t 1Fa000000000001 -o acme-main');
    refused('nice -n 5 sf devops promotion complete -a -t 1Fa000000000001 -o acme-main');
    fs.writeFileSync(path.join(work, 'x.sh'), 'sf api request rest /services/data/v62.0/limits -o acme-main\n');
    refused('sh x.sh');
  });
  it('refuses every spelling of production, and every command off the allow-list, behind a launcher or in a script', () => {
    refused('nice -n 5 sf package install -p 04t000000000001 --u acme-main');
    refused('nice -n 5 sf org display --u=acme-main');
    refused('nice -n 5 sf org display --u acme-main');
    refused('sf package install -p 04t000000000001 --u=acme-main');
    refused('nice -n 5 sf project deploy pipeline validate -p P -b main --devops-center-username acme-main');
    refused('nice -n 5 sf project deploy pipeline resume --devops-center-username=acme-main');
    refused('nice -n 5 sf apex run -f x.apex -o acme-main');
    refused(`nice -n 5 sf project deploy pipeline start --branch-name main -c acme-main`);
    fs.writeFileSync(path.join(work, 'apex.sh'), 'sf apex run -f x.apex --targetusername=acme-main\n');
    refused('sh apex.sh');
  });
  it('refuses a record change through the Tooling API, or with --flags-dir, behind a launcher or in a script', () => {
    refused('nice -n 5 sf data delete record -t --sobject CustomField --record-id 00N000000000001 -o acme-main');
    refused('nice -n 5 sf data update record --use-tooling-api --sobject Flow --record-id 301000000000001 --values "Status=Obsolete" -o acme-main');
    refused('nice -n 5 sf data update record --usetoolingapi -s Flow -i 301000000000001 -v Status=Obsolete -o acme-main');
    refused('nice -n 5 sf data create record --usetoolingapi=true --sobject CustomField --values "DeveloperName=X" -o acme-main');
    refused('nice -n 5 sf data create record --flags-dir flags -o acme-main');
    fs.writeFileSync(path.join(work, 'drop.sh'), 'sf data delete record --use-tooling-api=true --sobject CustomField --record-id 00N000000000001 -o acme-main\n');
    refused('sh drop.sh');
    expect(run('nice -n 5 sf data delete record --sobject Account --record-id 001000000000001 -o acme-main')).toMatchObject({ status: 0, ran: true });
  });
  it('refuses a DevOps Center pipeline deploy that gives no DevOps Center org', () => {
    fs.mkdirSync(path.join(work, '.sf'), { recursive: true });
    fs.writeFileSync(path.join(work, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'acme-dev1' }));
    const r = run('nice -n 5 sf project deploy pipeline start -p P -b main');
    expect(r).toMatchObject({ ran: false, status: 1 });
    expect(r.stderr).toMatch(/could not tell which org this runs against/);
  });
  it('runs the commands on the allow-list against production with their args intact', () => {
    const query = run('nice -n 5 sf data query --query "SELECT Id FROM Account" --u acme-main');
    expect(query).toMatchObject({ status: 0, ran: true });
    expect(query.stdout.split('\n')).toEqual(['ARG=data', 'ARG=query', 'ARG=--query', 'ARG=SELECT Id FROM Account', 'ARG=--u', 'ARG=acme-main', '']);
    expect(run('sf org list limits -o acme-main')).toMatchObject({ status: 0, ran: true });
    expect(run('sf apex get log -o acme-main')).toMatchObject({ status: 0, ran: true });
  });
  it('runs sf with SF_TEMP_SHOW_SECRETS unset, so no listing un-redacts a token', () => {
    exe(realSf, ['#!/bin/sh', 'touch "$FAKE_MARKER"', 'printf "SECRETS=%s\\n" "${SF_TEMP_SHOW_SECRETS-unset}"', ''].join('\n'));
    const r = run('sf org list', { SF_TEMP_SHOW_SECRETS: 'true' });
    expect(r).toMatchObject({ status: 0, ran: true });
    expect(r.stdout).toBe('SECRETS=unset\n');
  });
  it('refuses a production deploy from a script and from an npm script', () => {
    fs.writeFileSync(path.join(work, 'deploy.sh'), 'sf project deploy start -o acme-main\n');
    refused('sh deploy.sh');
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'acme', private: true, scripts: { deploy: 'sf project deploy start -o acme-main' } }));
    refused('npm run --silent deploy');
  });
  it('refuses a deploy with no target once the worktree default points at production', () => {
    refused(`echo '{"target-org":"acme-main"}' > .sf/config.json && sf project deploy start`);
    refused('sf project deploy start');
    fs.writeFileSync(path.join(work, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'acme-dev1' }));
    refused('SF_TARGET_ORG=acme-main sf project deploy start');
  });
  it('still runs deploys to the slot sandbox and reads against production, with the args intact', () => {
    const deploy = run('nice -n 5 sf project deploy start --source-dir "force app"');
    expect(deploy).toMatchObject({ status: 0, ran: true });
    expect(deploy.stdout.split('\n')).toEqual(['ARG=project', 'ARG=deploy', 'ARG=start', 'ARG=--source-dir', 'ARG=force app', '']);
    expect(run('sf project deploy start -o acme-dev1')).toMatchObject({ status: 0, ran: true });
    expect(run('sf data query --query "SELECT Id FROM Account" -o acme-main')).toMatchObject({ status: 0, ran: true });
    expect(run('sf project retrieve start -m ApexClass:X -o acme-main')).toMatchObject({ status: 0, ran: true });
    expect(run('sf org list users -o acme-main')).toMatchObject({ status: 0, ran: true });
    expect(run('sf org create user -o acme-main')).toMatchObject({ status: 0, ran: true });
  });
  it('adds no check to the wrapper when no production org is marked', () => {
    expect(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d' })).not.toContain(SF_PROD_CHECK);
    expect(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d', production: [] })).toBe(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d' }));
    expect(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d', production: [] })).not.toContain(SF_PROD_CHECK);
    expect(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d', production: [] })).not.toContain('unset SF_TEMP_SHOW_SECRETS');
    expect(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d', production })).toContain(SF_PROD_CHECK);
    expect(wrapperScript({ realSf: '/usr/bin/sf', dataDir: '/d', production })).toContain('unset SF_TEMP_SHOW_SECRETS');
  });
});

describe('allowList', () => {
  it('lists every org in salesforce.orgs, once each', () => {
    const b = block();
    b.orgs['acme-uat'] = { orgId: ACME_UAT_ID };
    b.stages.push({ name: 'uat', org: 'acme-uat', branch: 'uat' });
    expect(allowList(b)).toEqual([
      { alias: 'acme-dev1', orgId: ACME_DEV1_ID },
      { alias: 'acme-qa', orgId: ACME_QA_ID },
      { alias: 'acme-uat', orgId: ACME_UAT_ID },
    ]);
  });
  it('includes the Dev Hub in scratch mode, since it is in orgs', () => {
    const b = { ...block(), orgs: { 'acme-hub': { orgId: ACME_UAT_ID }, 'acme-qa': { orgId: ACME_QA_ID } }, build: { scratch: { devHub: 'acme-hub', definition: 'd.json' } } };
    expect(allowList(b)).toEqual([
      { alias: 'acme-hub', orgId: ACME_UAT_ID },
      { alias: 'acme-qa', orgId: ACME_QA_ID },
    ]);
  });
  it('marks a production org, and only that one', () => {
    expect(allowList(withMain())).toEqual([
      { alias: 'acme-dev1', orgId: ACME_DEV1_ID },
      { alias: 'acme-qa', orgId: ACME_QA_ID },
      { alias: 'acme-main', orgId: ACME_PROD_ID, production: true },
    ]);
  });
  it('skips entries without an org ID, and never throws', () => {
    expect(allowList({ orgs: { 'acme-dev1': {}, 'acme-qa': null, 'acme-uat': { orgId: ACME_UAT_ID } } })).toEqual([{ alias: 'acme-uat', orgId: ACME_UAT_ID }]);
    expect(allowList(undefined)).toEqual([]);
    expect(allowList({ orgs: 'x' })).toEqual([]);
  });
});

describe('homeVerdict', () => {
  const HOME = '/srv/acme/sf-home';
  const listOf = (...entries) => ({ ok: true, result: { nonScratchOrgs: entries, sandboxes: entries, scratchOrgs: [], devHubs: [], other: [] }, error: null });
  const ok = (id, isSandbox = true) => ({ ok: true, result: { records: [{ Id: id, IsSandbox: isSandbox }] }, error: null });
  const spy = (answers = {}) => {
    const q = (target) => {
      q.calls.push(target);
      return answers[target] ?? { ok: false, result: null, error: { name: 'NoRoute', message: `no answer for ${target}` } };
    };
    q.calls = [];
    return q;
  };
  const healthy = () => spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-qa': ok(ACME_QA_ID) });
  const noUsernames = (reason) => {
    for (const e of [DEV1, QA]) expect(reason).not.toContain(e.username);
    expect(reason).not.toContain('@');
  };

  it('is ok for an empty home', () => {
    const query = spy();
    expect(homeVerdict({ home: HOME, block: block(), list: listOf(), query })).toEqual({ ok: true, detail: 'no orgs signed in yet' });
    expect(query.calls).toEqual([]);
  });
  it('is ok when the home holds only allow-listed sandboxes, querying each once', () => {
    const query = healthy();
    expect(homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, QA), query })).toEqual({ ok: true, detail: '2 orgs, all allow-listed sandboxes' });
    expect(query.calls).toEqual(['acme-dev1', 'acme-qa']);
  });
  it('refuses a stray org without querying it', () => {
    const query = healthy();
    const stray = entry('acme-prod', STRAY_ID);
    const r = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, stray), query });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`acme-prod (${STRAY_ID})`);
    expect(r.reason).toContain('salesforce.orgs');
    expect(r.reason).toContain(`HOME=${HOME} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org logout --target-org acme-prod --no-prompt`);
    expect(query.calls).not.toContain('acme-prod');
    expect(query.calls).not.toContain(stray.username);
    expect(r.reason).not.toContain(stray.username);
  });
  it('names a stray org by its org ID when it has no usable alias, and lists several', () => {
    const query = spy();
    const r = homeVerdict({ home: HOME, block: block(), list: listOf({ username: 'x@acme.example', orgId: STRAY_ID }, entry('acme-old', '00D000000000008AAA')), query });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`${STRAY_ID} (${STRAY_ID})`);
    expect(r.reason).toContain('acme-old (00D000000000008AAA)');
    expect(r.reason).not.toContain('x@acme.example');
    expect(query.calls).toEqual([]);
  });
  it('gives a stray with no usable alias a logout hint that never prints its username', () => {
    const query = spy();
    const r = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, { alias: 'not an alias!', username: 'x@acme.example', orgId: STRAY_ID }), query });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`HOME=${HOME} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org logout --target-org <the username of ${STRAY_ID}> --no-prompt`);
    expect(r.reason).toContain(`; find each username with HOME=${HOME} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org list`);
    expect(r.reason).not.toContain('x@acme.example');
    expect(query.calls).toEqual([]);
  });
  it('takes the usernames out of a list error', () => {
    const list = { ok: false, result: null, error: { name: 'SfError', message: 'No authorization info for x@acme.example in /home/acme/.sfdx/x@acme.example.json' } };
    const r = homeVerdict({ home: HOME, block: block(), list, query: spy() });
    expect(r.ok).toBe(false);
    expect(r.reason.startsWith(`could not list the orgs in the isolated sf home ${HOME}: `)).toBe(true);
    expect(r.reason).toContain('an org');
    expect(r.reason).not.toContain('@');
  });
  it('refuses an allow-listed org that is not a sandbox and is not marked production', () => {
    const query = spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-qa': ok(ACME_QA_ID, false) });
    const r = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, QA), query });
    expect(r).toEqual({ ok: false, reason: NOT_SANDBOX('acme-qa') });
    expect(r.reason).toContain('"production": true');
  });
  it('accepts a marked production org whose server says IsSandbox false, with its configured org ID', () => {
    const query = spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-qa': ok(ACME_QA_ID), 'acme-main': ok(ACME_PROD_ID, false) });
    const r = homeVerdict({ home: HOME, block: withMain(), list: listOf(DEV1, QA, MAIN), query });
    expect(r).toEqual({ ok: true, detail: '3 orgs: 2 allow-listed sandboxes, 1 production (connected; deployments blocked)' });
    expect(query.calls).toEqual(['acme-dev1', 'acme-qa', 'acme-main']);
    const alone = homeVerdict({ home: HOME, block: withMain(), list: listOf(DEV1, MAIN), query: spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-main': ok(ACME_PROD_ID, false) }) });
    expect(alone).toEqual({ ok: true, detail: '2 orgs: 1 allow-listed sandbox, 1 production (connected; deployments blocked)' });
  });
  it('still refuses a production org that is listed but not marked', () => {
    const b = withMain();
    delete b.orgs['acme-main'].production;
    const r = homeVerdict({ home: HOME, block: b, list: listOf(DEV1, MAIN), query: spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-main': ok(ACME_PROD_ID, false) }) });
    expect(r).toEqual({ ok: false, reason: NOT_SANDBOX('acme-main') });
  });
  it('refuses a marked production org whose server says it is a sandbox', () => {
    const r = homeVerdict({ home: HOME, block: withMain(), list: listOf(DEV1, MAIN), query: spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-main': ok(ACME_PROD_ID) }) });
    expect(r).toEqual({ ok: false, reason: 'acme-main is marked "production": true in salesforce.orgs, but its server says it is a sandbox' });
  });
  it('refuses a marked production org whose server gives no record or no IsSandbox', () => {
    const none = { ok: true, result: { records: [] }, error: null };
    const blank = { ok: true, result: { records: [{ Id: ACME_PROD_ID }] }, error: null };
    for (const answer of [none, blank]) {
      const r = homeVerdict({ home: HOME, block: withMain(), list: listOf(MAIN), query: spy({ 'acme-main': answer }) });
      expect(r).toEqual({ ok: false, reason: NOT_SANDBOX('acme-main') });
    }
  });
  it('refuses a marked production org whose server gives another org ID', () => {
    const r = homeVerdict({ home: HOME, block: withMain(), list: listOf(DEV1, MAIN), query: spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-main': ok(STRAY_ID, false) }) });
    expect(r).toEqual({ ok: false, reason: `acme-main is org 00D000000000009, not ${ACME_PROD_ID}` });
  });
  it('refuses an org whose server gives another org ID', () => {
    const query = spy({ 'acme-dev1': ok(STRAY_ID), 'acme-qa': ok(ACME_QA_ID) });
    const r = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, QA), query });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('acme-dev1 is org 00D000000000009, not');
  });
  it('refuses when a query fails, or the list fails', () => {
    const query = spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'acme-qa': { ok: false, result: null, error: { name: 'SfError', message: 'Request timed out' } } });
    const r = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, QA), query });
    expect(r).toEqual({ ok: false, reason: 'could not check acme-qa in the isolated sf home: Request timed out' });
    const listed = homeVerdict({ home: HOME, block: block(), list: { ok: false, result: null, error: { name: 'SfNotFound', message: 'sf printed no JSON (exit 1)' } }, query: spy() });
    expect(listed).toEqual({ ok: false, reason: `could not list the orgs in the isolated sf home ${HOME}: sf printed no JSON (exit 1)` });
  });
  it('matches 15- and 18-character org IDs', () => {
    const b = block();
    b.orgs['acme-qa'].orgId = ACME_QA_ID.slice(0, 15);
    const query = spy({ 'acme-dev1': ok(ACME_DEV1_ID.slice(0, 15)), 'acme-qa': ok(ACME_QA_ID) });
    expect(homeVerdict({ home: HOME, block: b, list: listOf(DEV1, QA), query }).ok).toBe(true);
  });
  it('queries by username when the entry has no alias', () => {
    const query = spy({ [DEV1.username]: ok(ACME_DEV1_ID) });
    const r = homeVerdict({ home: HOME, block: block(), list: listOf({ username: DEV1.username, orgId: ACME_DEV1_ID }), query });
    expect(r).toEqual({ ok: true, detail: '1 org, all allow-listed sandboxes' });
    expect(query.calls).toEqual([DEV1.username]);
  });
  it('never puts a username in a reason', () => {
    const cases = [
      spy({ 'acme-dev1': ok(ACME_DEV1_ID, false), 'acme-qa': ok(ACME_QA_ID) }),
      spy({ 'acme-dev1': ok(STRAY_ID), 'acme-qa': ok(ACME_QA_ID) }),
      spy(),
    ];
    for (const query of cases) {
      const noAlias = [{ username: DEV1.username, orgId: ACME_DEV1_ID }, { username: QA.username, orgId: ACME_QA_ID }];
      const r = homeVerdict({ home: HOME, block: block(), list: listOf(...noAlias), query });
      expect(r.ok).toBe(false);
      noUsernames(r.reason);
    }
  });
});

describe('homeVerdict with story scratch orgs', () => {
  const HOME = '/srv/acme/sf-home';
  const SCRATCH_ID = '00D000000000101AAA';
  const HUB = entry('acme-hub', ACME_PROD_ID);
  const SCRATCH = { alias: 'foreman-acme-1', username: 'test-acme-1@scratch.acme.example', orgId: SCRATCH_ID, isScratch: true };
  const listOf = (...entries) => ({ ok: true, result: { nonScratchOrgs: entries.filter((e) => !e.isScratch), sandboxes: [], scratchOrgs: entries.filter((e) => e.isScratch), devHubs: [], other: [] }, error: null });
  const ok = (id, isSandbox = true) => ({ ok: true, result: { records: [{ Id: id, IsSandbox: isSandbox }] }, error: null });
  const spy = (answers = {}) => {
    const q = (target) => {
      q.calls.push(target);
      return answers[target] ?? { ok: false, result: null, error: { name: 'NoRoute', message: `no answer for ${target}` } };
    };
    q.calls = [];
    return q;
  };
  const scratchBlock = () => ({
    orgs: { 'acme-hub': { orgId: ACME_PROD_ID, production: true } },
    build: { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } },
    stages: [],
  });
  const ready = (over = {}) => ({ story: 'ACME-1', slot: 'w1', alias: 'foreman-acme-1', devHub: 'acme-hub', state: 'ready', jobId: '2SR000000000101AAA', username: SCRATCH.username, orgId: SCRATCH_ID, createdAt: '2026-10-25T10:00:00.000Z', ...over });
  const creating = (over = {}) => ready({ state: 'creating', orgId: null, ...over });
  const healthy = (isSandbox = true, id = SCRATCH_ID) => spy({ 'acme-hub': ok(ACME_PROD_ID, false), 'foreman-acme-1': ok(id, isSandbox) });
  const SCRATCH_NOT_SANDBOX = "foreman-acme-1 in the isolated sf home is a story's scratch org, but its server says it is not a sandbox";
  // The Dev Hub's ActiveScratchOrg query, as runSf answers it: `active` lists 15-character org IDs.
  const hubSpy = (active = ['00D000000000101'], answer) => {
    const h = (ids) => {
      h.calls.push(ids);
      return answer ?? { ok: true, result: { records: active.map((id) => ({ ScratchOrg: id })) }, error: null };
    };
    h.calls = [];
    return h;
  };

  it("accepts a story's scratch org next to a production Dev Hub, querying each once", () => {
    const query = healthy();
    const hub = hubSpy();
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query, scratch: [ready()], hub });
    expect(r).toEqual({ ok: true, detail: '2 orgs: 0 allow-listed sandboxes, 1 story scratch org, 1 production (connected; deployments blocked)' });
    expect(query.calls).toEqual(['acme-hub', 'foreman-acme-1']);
    expect(hub.calls).toEqual([['00D000000000101']]);
  });
  it('counts several, and leaves production out of the detail when there is none', () => {
    const two = { alias: 'foreman-acme-2', username: 'test-acme-2@scratch.acme.example', orgId: '00D000000000102AAA', isScratch: true };
    const query = spy({ 'foreman-acme-1': ok(SCRATCH_ID), 'foreman-acme-2': ok(two.orgId) });
    const hub = hubSpy(['00D000000000101', '00D000000000102']);
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(SCRATCH, two), query, scratch: [ready(), ready({ story: 'ACME-2', alias: 'foreman-acme-2', username: two.username, orgId: two.orgId })], hub });
    expect(r).toEqual({ ok: true, detail: '2 orgs: 0 allow-listed sandboxes, 2 story scratch orgs' });
    expect(query.calls).toEqual(['foreman-acme-1', 'foreman-acme-2']);
    expect(hub.calls).toEqual([['00D000000000101', '00D000000000102']]);
  });
  it('refuses a scratch org the Dev Hub does not list as active, such as a sandbox a record names', () => {
    const query = healthy();
    const hub = hubSpy([]);
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query, scratch: [ready()], hub });
    expect(r).toEqual({ ok: false, reason: "foreman-acme-1 in the isolated sf home is a story's scratch org, but acme-hub has no active scratch org 00D000000000101" });
    expect(hub.calls).toEqual([['00D000000000101']]);
    const one = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [ready()], hub: hubSpy(['00D000000000999']) });
    expect(one.ok).toBe(false);
    const creatingToo = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [creating()], hub: hubSpy([]) });
    expect(creatingToo).toEqual(r);
  });
  it('refuses when the Dev Hub cannot be asked, with no username in the reason', () => {
    const PREFIX = 'could not check the story scratch orgs on the Dev Hub acme-hub: ';
    const failed = hubSpy([], { ok: false, result: null, error: { name: 'NamedOrgNotFoundError', message: 'No authorization information found for admin@acme-hub.acme.example and test-acme-1@scratch.acme.example.' } });
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [ready()], hub: failed });
    expect(r.ok).toBe(false);
    expect(r.reason.startsWith(PREFIX)).toBe(true);
    expect(r.reason).not.toContain('@');
    const missing = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [ready()] });
    expect(missing).toEqual({ ok: false, reason: `${PREFIX}no answer` });
    const blank = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [ready()], hub: () => undefined });
    expect(blank).toEqual({ ok: false, reason: `${PREFIX}no answer` });
  });
  it('gives no allowance to a record that names another Dev Hub', () => {
    const query = healthy();
    const hub = hubSpy();
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query, scratch: [ready({ devHub: 'acme-other' })], hub });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`foreman-acme-1 (${SCRATCH_ID})`);
    expect(r.reason).toContain('not in salesforce.orgs');
    expect(query.calls).toEqual([]);
    expect(hub.calls).toEqual([]);
    const byUser = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [creating({ devHub: 'acme-other' })], hub });
    expect(byUser.ok).toBe(false);
    expect(byUser.reason).toContain('not in salesforce.orgs');
    const none = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [ready({ devHub: undefined })], hub });
    expect(none.ok).toBe(false);
    expect(hub.calls).toEqual([]);
  });
  it('makes no Dev Hub call in pool mode, or in scratch mode with no story scratch org', () => {
    const hub = hubSpy();
    const pool = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1), query: spy({ 'acme-dev1': ok(ACME_DEV1_ID) }), scratch: [ready()], hub });
    expect(pool).toEqual({ ok: true, detail: '1 org, all allow-listed sandboxes' });
    const hubOnly = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB), query: spy({ 'acme-hub': ok(ACME_PROD_ID, false) }), scratch: [ready()], hub });
    expect(hubOnly.ok).toBe(true);
    expect(hub.calls).toEqual([]);
  });
  it('refuses a story scratch org whose server gives no org ID, with no Dev Hub call', () => {
    const REASON = "foreman-acme-1 in the isolated sf home is a story's scratch org, but its server gave no org ID";
    const noId = spy({ 'acme-hub': ok(ACME_PROD_ID, false), 'foreman-acme-1': { ok: true, result: { records: [{ IsSandbox: true }] }, error: null } });
    const hub = hubSpy();
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: noId, scratch: [creating()], hub })).toEqual({ ok: false, reason: REASON });
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: noId, scratch: [ready()], hub })).toEqual({ ok: false, reason: REASON });
    const odd = spy({ 'acme-hub': ok(ACME_PROD_ID, false), 'foreman-acme-1': ok("00D0000') OR (1", true) });
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: odd, scratch: [creating()], hub })).toEqual({ ok: false, reason: REASON });
    expect(hub.calls).toEqual([]);
  });
  it('refuses the same org as a stray when no record names it', () => {
    const query = healthy();
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`foreman-acme-1 (${SCRATCH_ID})`);
    expect(r.reason).toContain('not in salesforce.orgs');
    expect(query.calls).not.toContain('foreman-acme-1');
    const other = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [ready({ orgId: '00D000000000999AAA', username: 'test-other@scratch.acme.example' })] });
    expect(other.ok).toBe(false);
    expect(other.reason).toContain(`foreman-acme-1 (${SCRATCH_ID})`);
  });
  it('matches a creating record by its username, and accepts it only as a sandbox', () => {
    const hub = hubSpy();
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [creating()], hub });
    expect(r).toEqual({ ok: true, detail: '2 orgs: 0 allow-listed sandboxes, 1 story scratch org, 1 production (connected; deployments blocked)' });
    expect(hub.calls).toEqual([['00D000000000101']]);
    const refused = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(false), scratch: [creating()] });
    expect(refused).toEqual({ ok: false, reason: SCRATCH_NOT_SANDBOX });
    expect(refused.reason).not.toContain('@');
    const otherUser = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [creating({ username: 'test-other@scratch.acme.example' })] });
    expect(otherUser.ok).toBe(false);
    expect(otherUser.reason).toContain('not in salesforce.orgs');
  });
  it("refuses a recorded scratch org whose server says it is not a sandbox, or gives another ID", () => {
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(false), scratch: [ready()] })).toEqual({ ok: false, reason: SCRATCH_NOT_SANDBOX });
    const blank = spy({ 'acme-hub': ok(ACME_PROD_ID, false), 'foreman-acme-1': { ok: true, result: { records: [] }, error: null } });
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: blank, scratch: [ready()] })).toEqual({ ok: false, reason: SCRATCH_NOT_SANDBOX });
    const moved = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(true, '00D000000000999AAA'), scratch: [ready()] });
    expect(moved).toEqual({ ok: false, reason: `foreman-acme-1 is org 00D000000000999, not ${SCRATCH_ID}` });
  });
  it('never lets a record override a configured org', () => {
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB), query: spy({ 'acme-hub': ok(ACME_PROD_ID, false) }), scratch: [ready({ alias: 'acme-hub', orgId: ACME_PROD_ID })] });
    expect(r).toEqual({ ok: true, detail: '1 org: 0 allow-listed sandboxes, 1 production (connected; deployments blocked)' });
  });
  it('ignores records outside scratch mode, so a pool home never widens', () => {
    const query = spy({ 'acme-dev1': ok(ACME_DEV1_ID), 'foreman-acme-1': ok(SCRATCH_ID) });
    const r = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, SCRATCH), query, scratch: [ready()] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`foreman-acme-1 (${SCRATCH_ID})`);
    const byUser = homeVerdict({ home: HOME, block: block(), list: listOf(DEV1, SCRATCH), query, scratch: [creating()] });
    expect(byUser.ok).toBe(false);
  });
  it('keeps the details as they were in scratch mode with no records', () => {
    const hub = hubSpy();
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB), query: spy({ 'acme-hub': ok(ACME_PROD_ID, false) }), scratch: [], hub })).toEqual({ ok: true, detail: '1 org: 0 allow-listed sandboxes, 1 production (connected; deployments blocked)' });
    expect(homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(), query: spy(), scratch: [ready()], hub })).toEqual({ ok: true, detail: 'no orgs signed in yet' });
    expect(hub.calls).toEqual([]);
  });
  it('skips records that are not objects', () => {
    const r = homeVerdict({ home: HOME, block: scratchBlock(), list: listOf(HUB, SCRATCH), query: healthy(), scratch: [null, 5, 'x', ready()], hub: hubSpy() });
    expect(r.ok).toBe(true);
  });

  describe('through setUp', () => {
    let homedir;
    let home;
    let realDir;
    let state;
    beforeEach(() => {
      homedir = path.join(tmp, 'me');
      fs.mkdirSync(homedir);
      home = path.join(tmp, 'sf-home');
      realDir = path.join(tmp, 'real');
      exe(path.join(realDir, 'sf'));
      state = path.join(tmp, 'state');
    });
    const ACTIVE = 'FROM ActiveScratchOrg';
    const routes = (active = ['00D000000000101']) => ({
      [ORG_LIST]: orgList([HUB, SCRATCH]),
      [orgRoute('acme-hub')]: orgRecord(ACME_PROD_ID, false),
      [orgRoute('foreman-acme-1')]: orgRecord(SCRATCH_ID),
      [ACTIVE]: sfOk({ records: active.map((id) => ({ attributes: { type: 'ActiveScratchOrg' }, ScratchOrg: id })), totalSize: active.length, done: true }),
    });
    const env = () => ({ HOME: homedir, PATH: `${realDir}${path.delimiter}/bin`, FOREMAN_SF_HOME: home, FOREMAN_STATE_DIR: state });
    const config = () => ({ pack: 'salesforce', salesforce: scratchBlock() });

    it("accepts the org a record in FOREMAN_STATE_DIR names", () => {
      writeScratchOrg(state, ready());
      const r = setUp({ config: config(), env: env(), fs, sh: fakeSfShell(routes()), homedir });
      expect(r).toMatchObject({ ok: true, session: { pathPrefix: [binDir(home)] } });
    });
    it('refuses it when the Dev Hub lists no such active scratch org, asking the configured Dev Hub', () => {
      writeScratchOrg(state, ready());
      const sh = fakeSfShell(routes([]));
      const r = setUp({ config: config(), env: env(), fs, sh, homedir });
      expect(r).toEqual({ ok: false, reason: "foreman-acme-1 in the isolated sf home is a story's scratch org, but acme-hub has no active scratch org 00D000000000101" });
      const asked = sh.sfLines().filter((l) => l.includes('FROM ActiveScratchOrg'));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('--target-org acme-hub');
    });
    it('refuses it as a stray with no record', () => {
      const r = setUp({ config: config(), env: env(), fs, sh: fakeSfShell(routes()), homedir });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(`foreman-acme-1 (${SCRATCH_ID})`);
    });
  });
});

describe('activeScratchQuery', () => {
  it('asks the Dev Hub which of the org IDs are active scratch orgs', () => {
    const sh = fakeSfShell({ 'FROM ActiveScratchOrg': sfOk({ records: [] }) });
    expect(activeScratchQuery(sh, 'acme-hub', ['00D000000000101', '00D000000000102'])).toMatchObject({ ok: true, result: { records: [] } });
    expect(sh.sfLines()).toEqual(["data query --query SELECT ScratchOrg FROM ActiveScratchOrg WHERE ScratchOrg IN ('00D000000000101', '00D000000000102') --target-org acme-hub --json"]);
  });
});

describe('aliasStray', () => {
  const HOME = '/srv/acme/sf-home';
  const listOf = (...entries) => ({ ok: true, result: { nonScratchOrgs: entries, sandboxes: entries, scratchOrgs: [], devHubs: [], other: [] }, error: null });

  it('names an alias whose listed org ID is not allow-listed', () => {
    const r = aliasStray({ home: HOME, block: block(), list: listOf(DEV1, entry('acme-qa', STRAY_ID)), alias: 'acme-qa' });
    expect(r).toContain(`acme-qa (${STRAY_ID})`);
    expect(r).toContain('salesforce.orgs');
    expect(r).toContain(`HOME=${HOME} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org logout --target-org acme-qa --no-prompt`);
    expect(r).not.toContain('@');
  });
  it('is null for an allow-listed alias, and for an alias not in the list', () => {
    expect(aliasStray({ home: HOME, block: block(), list: listOf(DEV1, QA), alias: 'acme-qa' })).toBeNull();
    expect(aliasStray({ home: HOME, block: block(), list: listOf(DEV1), alias: 'acme-qa' })).toBeNull();
  });
  it('fails closed when the list failed, with the usernames taken out', () => {
    const list = { ok: false, result: null, error: { name: 'SfError', message: 'No authorization info for x@acme.example' } };
    const r = aliasStray({ home: HOME, block: block(), list, alias: 'acme-qa' });
    expect(r).toBe(`could not list the orgs in the isolated sf home ${HOME}: No authorization info for an org`);
  });
});

describe('listedEntry', () => {
  const listOf = (...entries) => ({ ok: true, result: { nonScratchOrgs: entries, sandboxes: entries, scratchOrgs: [], devHubs: [], other: [] }, error: null });

  it('returns the entry listed under an alias, including one listed only in devHubs', () => {
    expect(listedEntry(listOf(DEV1, QA), 'acme-qa')).toEqual(QA);
    const hubs = { ok: true, result: { nonScratchOrgs: [], sandboxes: [], scratchOrgs: [], devHubs: [QA], other: [] }, error: null };
    expect(listedEntry(hubs, 'acme-qa')).toEqual(QA);
  });
  it('is null for an alias not listed, a failed list, no list and groups that are not arrays', () => {
    expect(listedEntry(listOf(DEV1), 'acme-qa')).toBeNull();
    expect(listedEntry({ ok: false, result: null, error: { name: 'SfError', message: 'x' } }, 'acme-qa')).toBeNull();
    expect(listedEntry(undefined, 'acme-qa')).toBeNull();
    expect(listedEntry({ ok: true, result: { nonScratchOrgs: 'x', devHubs: 5 } }, 'acme-qa')).toBeNull();
  });
});

describe('setUp', () => {
  let homedir;
  let home;
  let realDir;
  const routes = (list = orgList([DEV1, QA])) => ({
    [ORG_LIST]: list,
    [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID),
    [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID),
  });
  beforeEach(() => {
    homedir = path.join(tmp, 'me');
    fs.mkdirSync(homedir);
    home = path.join(tmp, 'sf-home');
    realDir = path.join(tmp, 'real');
    exe(path.join(realDir, 'sf'));
  });
  const env = (over = {}) => ({ HOME: homedir, PATH: `${realDir}${path.delimiter}/bin`, FOREMAN_SF_HOME: home, ...over });
  const config = () => ({ pack: 'salesforce', salesforce: block() });

  it('creates the home (700) and both wrappers, and hands back the session', () => {
    const sh = fakeSfShell(routes());
    const r = setUp({ config: config(), env: env(), fs, sh, homedir });
    const bin = binDir(home);
    expect(r).toEqual({
      ok: true,
      session: {
        env: { FOREMAN_SF_HOME: home, SF_DISABLE_TELEMETRY: 'true' },
        pathPrefix: [bin],
        settings: {
          enabledPlugins: { 'salesforce-development@salesforce': false },
          permissions: { deny: [`Read(/${path.join(homedir, '.config', 'foreman', 'sf')}/**)`] },
        },
      },
    });
    const [rule] = r.session.settings.permissions.deny;
    // `//` is an absolute path in a permission rule; a single `/` would be relative to the settings file
    expect(rule.startsWith('Read(//')).toBe(true);
    expect(rule).not.toContain('sf-home');
    expect(SESSION_SETTINGS).toEqual({ enabledPlugins: { [SF_PLUGIN]: false } });
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    for (const name of ['sf', 'sfdx']) {
      const file = path.join(bin, name);
      expect(fs.statSync(file).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(wrapperScript({ realSf: path.join(realDir, 'sf'), dataDir: path.join(homedir, '.local', 'share', 'sf') }));
    }
  });
  it('tightens a home that already exists to 700', () => {
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    const r = setUp({ config: config(), env: env(), fs, sh: fakeSfShell(routes()), homedir });
    expect(r.ok).toBe(true);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
  it('runs org list in the isolated home, with the keychain and the real data dir', () => {
    const sh = fakeSfShell(routes());
    setUp({ config: config(), env: env({ XDG_DATA_HOME: path.join(tmp, 'xdg') }), fs, sh, homedir });
    const list = sh.calls.find((c) => c.cmd === 'sf' && c.args.join(' ').includes('org list'));
    expect(list.args).toEqual(['org', 'list', '--all', '--skip-connection-status', '--json']);
    expect(list.opts.env).toMatchObject({ HOME: home, SF_USE_GENERIC_UNIX_KEYCHAIN: 'true', SF_DISABLE_TELEMETRY: 'true', SF_DATA_DIR: path.join(tmp, 'xdg', 'sf') });
    for (const c of sh.calls) expect(c.opts.env.HOME).toBe(home);
  });
  it('rewrites a wrapper whose sf path changed', () => {
    setUp({ config: config(), env: env(), fs, sh: fakeSfShell(routes()), homedir });
    const other = path.join(tmp, 'other');
    exe(path.join(other, 'sf'));
    const r = setUp({ config: config(), env: env({ PATH: `${other}${path.delimiter}/bin` }), fs, sh: fakeSfShell(routes()), homedir });
    expect(r.ok).toBe(true);
    for (const name of ['sf', 'sfdx']) {
      const text = fs.readFileSync(path.join(binDir(home), name), 'utf8');
      expect(text).toContain(path.join(other, 'sf'));
      expect(text).not.toContain(path.join(realDir, 'sf'));
    }
  });
  it('refuses when there is no sf on PATH, and writes no wrapper', () => {
    const sh = fakeSfShell(routes());
    const r = setUp({ config: config(), env: env({ PATH: path.join(tmp, 'empty') }), fs, sh, homedir });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('PATH');
    expect(fs.existsSync(binDir(home))).toBe(false);
    expect(sh.calls).toEqual([]);
  });
  it('refuses when the home cannot be created', () => {
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    const r = setUp({ config: config(), env: env({ FOREMAN_SF_HOME: path.join(file, 'home') }), fs, sh: fakeSfShell(routes()), homedir });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^could not create the isolated sf home /);
  });
  it('refuses a FOREMAN_SF_HOME that is not absolute, and creates nothing', () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      for (const value of ['~/sf-home', 'sf-home', './sf-home']) {
        const sh = fakeSfShell(routes());
        const r = setUp({ config: config(), env: env({ FOREMAN_SF_HOME: value }), fs, sh, homedir });
        expect(r, value).toEqual({ ok: false, reason: `FOREMAN_SF_HOME must be an absolute path, not ${value}` });
        expect(sh.calls, value).toEqual([]);
      }
      expect(fs.readdirSync(tmp).sort()).toEqual(['me', 'real']);
    } finally {
      process.chdir(cwd);
    }
  });
  it('is ok with a marked production org in the home', () => {
    const sh = fakeSfShell({ ...routes(orgList([DEV1, QA, MAIN])), [orgRoute('acme-main')]: orgRecord(ACME_PROD_ID, false) });
    const r = setUp({ config: { pack: 'salesforce', salesforce: withMain() }, env: env(), fs, sh, homedir });
    expect(r).toMatchObject({ ok: true, session: { pathPrefix: [binDir(home)] } });
    const script = wrapperScript({ realSf: path.join(realDir, 'sf'), dataDir: path.join(homedir, '.local', 'share', 'sf'), production: [{ alias: 'acme-main', orgId: ACME_PROD_ID }] });
    for (const name of ['sf', 'sfdx']) expect(fs.readFileSync(path.join(binDir(home), name), 'utf8')).toBe(script);
    expect(script).toContain(SF_PROD_CHECK);
  });
  it('refuses a home holding a stray org', () => {
    const sh = fakeSfShell(routes(orgList([DEV1, entry('acme-prod', STRAY_ID)])));
    const r = setUp({ config: config(), env: env(), fs, sh, homedir });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('acme-prod');
    expect(sh.sfLines().some((l) => l.includes('acme-prod'))).toBe(false);
  });
  it('refuses when org list fails, and never throws', () => {
    const r = setUp({ config: config(), env: env(), fs, sh: fakeSfShell(routes(sfError('SfError', 'broken'))), homedir });
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toContain('could not list the orgs');
    const boom = () => {
      throw new Error('boom');
    };
    expect(setUp({ config: config(), env: env(), fs, sh: boom, homedir }).ok).toBe(false);
    expect(setUp({ config: null, env: env(), fs, sh: fakeSfShell(routes(sfOk({}))), homedir })).toMatchObject({ ok: true });
  });
});
