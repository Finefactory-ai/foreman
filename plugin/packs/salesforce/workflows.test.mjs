import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploysIn, parseWorkflow, pullRequestWorkflows, pushRunsOn, runsOnPullRequest, workflowsCheck } from './workflows.mjs';
import { layout } from './config.mjs';

const runsOn = (text, branch) => pushRunsOn(parseWorkflow(text).push, branch);

describe('parseWorkflow and pushRunsOn', () => {
  it('on: push and on: [push, pull_request] run on main and qa', () => {
    for (const text of ['on: push\n', 'on: [push, pull_request]\n']) {
      expect(runsOn(text, 'main'), text).toBe(true);
      expect(runsOn(text, 'qa'), text).toBe(true);
    }
  });
  it('push with no children runs on every branch: no branch filter counts as every branch', () => {
    const text = 'on:\n  push:\njobs:\n  a:\n    runs-on: x\n';
    expect(parseWorkflow(text).push).toEqual({ branches: null, ignore: null, tagsOnly: false });
    expect(runsOn(text, 'main')).toBe(true);
    expect(runsOn(text, 'release/x')).toBe(true);
  });
  it('pull_request and workflow_dispatch give push null, so the workflow never runs', () => {
    for (const text of ['on: pull_request\n', 'on: workflow_dispatch\n', 'on:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\n']) {
      expect(parseWorkflow(text).push, text).toBeNull();
      expect(runsOn(text, 'main'), text).toBe(false);
    }
    expect(parseWorkflow('name: x\njobs: {}\n').push).toBeNull();
  });
  it('block lists and flow lists run only on the branches they list', () => {
    const block = 'on:\n  push:\n    branches:\n      - main\n      - "qa" # the qa branch\n';
    const flow = "on:\n  push:\n    branches: [ main, 'qa' ]\n";
    const scalar = 'on:\n  push:\n    branches: qa\n';
    for (const text of [block, flow]) {
      expect(parseWorkflow(text).push).toEqual({ branches: ['main', 'qa'], ignore: null, tagsOnly: false });
      expect(runsOn(text, 'main')).toBe(true);
      expect(runsOn(text, 'qa')).toBe(true);
      expect(runsOn(text, 'uat')).toBe(false);
    }
    expect(runsOn(scalar, 'qa')).toBe(true);
    expect(runsOn(scalar, 'main')).toBe(false);
  });
  it('reads a block list written at the key\'s own indent', () => {
    const text = 'on:\n  push:\n    branches:\n    - qa\n    tags:\n    - v1\n';
    expect(parseWorkflow(text).push).toEqual({ branches: ['qa'], ignore: null, tagsOnly: false });
  });
  it("release/** with !release/old: last match wins", () => {
    const text = "on:\n  push:\n    branches: ['release/**', '!release/old']\n";
    expect(runsOn(text, 'release/a/b')).toBe(true);
    expect(runsOn(text, 'release/old')).toBe(false);
    expect(runsOn(text, 'main')).toBe(false);
  });
  it('* does not cross /', () => {
    const text = 'on:\n  push:\n    branches: [feature/*]\n';
    expect(runsOn(text, 'feature/x')).toBe(true);
    expect(runsOn(text, 'feature/x/y')).toBe(false);
  });
  it('branches-ignore skips what it lists and runs on the rest', () => {
    const text = 'on:\n  push:\n    branches-ignore: [main]\n';
    expect(parseWorkflow(text).push).toEqual({ branches: null, ignore: ['main'], tagsOnly: false });
    expect(runsOn(text, 'main')).toBe(false);
    expect(runsOn(text, 'qa')).toBe(true);
  });
  it('tags alone means tagsOnly, so it does not run on main', () => {
    const text = "on:\n  push:\n    tags: ['v*']\n";
    expect(parseWorkflow(text).push).toEqual({ branches: null, ignore: null, tagsOnly: true });
    expect(runsOn(text, 'main')).toBe(false);
    expect(runsOn('on:\n  push:\n    tags-ignore: [v1]\n', 'main')).toBe(false);
    expect(runsOn("on:\n  push:\n    tags: ['v*']\n    branches: [main]\n", 'main')).toBe(true);
  });
  it('reads on written as "on", \'on\' and true', () => {
    for (const key of ['"on"', "'on'", 'true']) {
      const text = `name: x\n${key}:\n  push:\n    branches: [qa]\n`;
      expect(runsOn(text, 'qa'), key).toBe(true);
      expect(runsOn(text, 'main'), key).toBe(false);
    }
  });
  it('an inline flow mapping that holds push counts as every branch (safe side)', () => {
    const text = 'on: {push: {branches: [qa]}}\n';
    expect(parseWorkflow(text).push).toEqual({ branches: null, ignore: null, tagsOnly: false });
    expect(runsOn(text, 'main')).toBe(true);
    expect(parseWorkflow('on: {pull_request: {}}\n').push).toBeNull();
    expect(runsOn('on:\n  push: {branches: [qa]}\n', 'main')).toBe(true);
  });
  it('parses 4-space indentation the same as 2-space', () => {
    const two = 'on:\n  # comment\n\n  push:\n    branches:\n      - main\n  pull_request:\n';
    const four = 'on:\n    # comment\n\n    push:\n        branches:\n            - main\n    pull_request:\n';
    expect(parseWorkflow(four).push).toEqual(parseWorkflow(two).push);
    expect(parseWorkflow(four).push).toEqual({ branches: ['main'], ignore: null, tagsOnly: false });
  });
  it('safe side on ?, + and [: matching in branches, not in branches-ignore, a negation skipped', () => {
    expect(runsOn('on:\n  push:\n    branches: [ "rel?ase" ]\n', 'main')).toBe(true);
    expect(runsOn('on:\n  push:\n    branches-ignore: [ "ma[i]n" ]\n', 'main')).toBe(true);
    expect(runsOn("on:\n  push:\n    branches: ['**', '!ma+n']\n", 'main')).toBe(true);
  });
  it('counts a branch filter it cannot read as every branch', () => {
    expect(runsOn('on:\n  push:\n    branches: [\n      qa ]\n', 'main')).toBe(true);
  });
  it('never throws', () => {
    for (const text of [undefined, null, 7, '', '::\n- -\n  [', 'on:\n  push:\n    branches: [\n', 'jobs:\n  :\n']) {
      expect(() => parseWorkflow(text)).not.toThrow();
    }
    expect(parseWorkflow(undefined)).toEqual({ push: null, pullRequest: [], jobs: [] });
    expect(pushRunsOn(null, 'main')).toBe(false);
  });
  it('reads a column-0 block sequence under on:', () => {
    for (const text of ['on:\n- push\n- pull_request\njobs:\n  a:\n    runs-on: x\n', 'on:\n- "push" # c\n']) {
      expect(parseWorkflow(text).push, text).toEqual({ branches: null, ignore: null, tagsOnly: false });
      expect(runsOn(text, 'main'), text).toBe(true);
      expect(runsOn(text, 'qa'), text).toBe(true);
    }
    expect(parseWorkflow('on:\n- pull_request\n- workflow_dispatch\njobs:\n').push).toBeNull();
  });
  it('an on: the reader cannot place counts as every branch', () => {
    for (const text of ['on:\njobs:\n  a:\n    runs-on: x\n', 'on:\n- push:\n']) {
      expect(parseWorkflow(text).push, text).toEqual({ branches: null, ignore: null, tagsOnly: false });
      expect(runsOn(text, 'main'), text).toBe(true);
    }
  });
  it('an empty filter counts as every branch', () => {
    for (const text of ['on:\n  push:\n    branches:\n    tags: [v1]\n', 'on:\n  push:\n    branches: []\n', 'on:\n  push:\n    branches:\n']) {
      expect(runsOn(text, 'main'), text).toBe(true);
    }
    expect(runsOn('on:\n  push:\n    branches-ignore: []\n', 'main')).toBe(true);
  });
});

describe('parseWorkflow jobs', () => {
  it("gathers a job's inline run: and - run: | block scalars, stopping at a dedent", () => {
    const text = [
      'on: push',
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: echo one # a note',
      '      - name: deploy',
      '        run: |',
      '          sf project deploy start \\',
      '',
      '            -o acme-dev1',
      '        env:',
      '          X: y',
      '      - run: "echo \'#two\'"',
      '  other:',
      '    steps:',
      '      - run: echo three',
      'concurrency: x',
      '  run: echo not a job',
    ].join('\n');
    const { jobs } = parseWorkflow(text);
    expect(jobs.map((j) => j.id)).toEqual(['deploy', 'other']);
    expect(jobs[0].script).toBe("echo one\nsf project deploy start \\\n\n  -o acme-dev1\necho '#two'");
    expect(jobs[1]).toEqual({ id: 'other', uses: null, script: 'echo three' });
  });
  it('folds run: >- content with spaces', () => {
    const text = 'jobs:\n  a:\n    steps:\n      - run: >-\n          sf project deploy start\n          -o acme-dev1\n      - run: echo done\n';
    expect(parseWorkflow(text).jobs[0].script).toBe('sf project deploy start -o acme-dev1\necho done');
  });
  it('captures a job-level uses:, and not a step - uses:', () => {
    const text = [
      'on: push',
      'jobs:',
      '  call:',
      '    uses: ./.github/workflows/deploy-reusable.yml',
      '    secrets: inherit',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n');
    const { jobs } = parseWorkflow(text);
    expect(jobs).toEqual([
      { id: 'call', uses: './.github/workflows/deploy-reusable.yml', script: '' },
      { id: 'build', uses: null, script: '' },
    ]);
  });
});

describe('deploysIn', () => {
  const target = (script, file) => deploysIn(script, file ?? script);
  it('reads --target-org', () => {
    expect(target('sf project deploy start --target-org acme-dev1')).toEqual([{ target: 'acme-dev1' }]);
  });
  it('reads -o, --target-org= and a quoted value', () => {
    for (const s of ['sf project deploy start -o acme-dev1', 'sf project deploy start --target-org=acme-dev1', 'sf project deploy start -o "acme-dev1"']) {
      expect(target(s), s).toEqual([{ target: 'acme-dev1' }]);
    }
  });
  it('takes the last target flag', () => {
    expect(target('sf project deploy start -o acme-qa --target-org acme-dev1')).toEqual([{ target: 'acme-dev1' }]);
  });
  it('detects validate, quick and sfdx commands', () => {
    for (const s of [
      'sf project deploy validate -o acme-dev1',
      'sf project deploy quick --job-id X -o acme-dev1',
      'sfdx force:source:deploy -u acme-dev1',
      'sfdx force:mdapi:deploy --targetusername acme-dev1',
    ]) {
      expect(target(s), s).toEqual([{ target: 'acme-dev1' }]);
    }
  });
  it('detects sf behind npx or a path', () => {
    expect(target('npx sf project deploy start -o acme-dev1')).toEqual([{ target: 'acme-dev1' }]);
    expect(target('./node_modules/.bin/sf project deploy start -o acme-dev1')).toEqual([{ target: 'acme-dev1' }]);
  });
  it('joins a command continued with \\ over lines', () => {
    expect(target('sf project deploy start \\\n  --source-dir force-app \\\n  -o acme-dev1\n')).toEqual([{ target: 'acme-dev1' }]);
  });
  it('splits commands on ;, &&, || and |', () => {
    expect(target('echo hi; sf project deploy start -o acme-dev1 && sf project deploy start -o acme-qa || true | cat')).toEqual([
      { target: 'acme-dev1' },
      { target: 'acme-qa' },
    ]);
  });
  it('gives null for a target from a secret or a variable, a missing value or a flag', () => {
    for (const s of [
      'sf project deploy start -o ${{ secrets.PROD_ALIAS }}',
      'sf project deploy start -o "${{ secrets.PROD_ALIAS }}"',
      'sf project deploy start -o $ORG',
      'sf project deploy start --target-org=$ORG',
      'sf project deploy start -o `cat org`',
      'sf project deploy start -o',
      'sf project deploy start -o --dry-run',
    ]) {
      expect(target(s), s).toEqual([{ target: null }]);
    }
  });
  it('takes the alias of the one login in the job when there is no target flag', () => {
    const s = 'sf org login jwt --alias acme-dev1 --username ${{ secrets.U }} --jwt-key-file k --client-id c\nsf project deploy start --source-dir force-app';
    expect(target(s)).toEqual([{ target: 'acme-dev1' }]);
    expect(target('sfdx force:auth:jwt:grant -a acme-dev1 -u x\nsfdx force:source:deploy -p force-app')).toEqual([{ target: 'acme-dev1' }]);
    expect(target('sfdx auth:sfdxurl:store --setalias=acme-dev1 -f f\nsf project deploy start')).toEqual([{ target: 'acme-dev1' }]);
  });
  it('gives null with no flag and two logins, or none', () => {
    const two = 'sf org login jwt --alias acme-dev1\nsf org login jwt --alias acme-qa\nsf project deploy start';
    expect(target(two)).toEqual([{ target: null }]);
    expect(target('sf project deploy start --source-dir force-app')).toEqual([{ target: null }]);
    expect(target('sf org login jwt --alias $ALIAS\nsf project deploy start')).toEqual([{ target: null }]);
  });
  it('gives null with no flag and one login when the file sets a default org', () => {
    const s = 'sf org login jwt --alias acme-dev1\nsf project deploy start';
    for (const extra of ['env:\n  SF_TARGET_ORG: acme-prod\n', 'SFDX_DEFAULTUSERNAME', 'sf config set target-org acme-prod', 'sfdx config:set defaultusername=acme-prod']) {
      expect(target(s, `${extra}\n${s}`), extra).toEqual([{ target: null }]);
    }
  });
  it('finds no deploy in report, list, retrieve or a comment', () => {
    for (const s of [
      'sf project deploy report --job-id X',
      'sf org list',
      '# echo sf project deploy start -o acme-prod',
      'echo hi # sf project deploy start -o acme-prod',
      'sf project retrieve start -o acme-prod',
      '',
    ]) {
      expect(target(s), s).toEqual([]);
    }
    expect(deploysIn(undefined, undefined)).toEqual([]);
  });
  it('does not split at & inside a redirect', () => {
    expect(target('sf org login jwt -a acme-dev1\nsf project deploy start 2>&1 -o acme-prod')).toEqual([{ target: 'acme-prod' }]);
    expect(target('sf project deploy start -o acme-prod &> log')).toEqual([{ target: 'acme-prod' }]);
    expect(target('sf project deploy start -o acme-prod >&2')).toEqual([{ target: 'acme-prod' }]);
    expect(target('sf org login jwt -a acme-dev1\nsf project deploy start &>log -o acme-prod')).toEqual([{ target: 'acme-prod' }]);
    expect(target('sf org login jwt -a acme-dev1\nsf project deploy start <&0 -o acme-prod')).toEqual([{ target: 'acme-prod' }]);
  });
  it('splits at a lone background &', () => {
    expect(target('sf project deploy start -o acme-prod & sf project deploy start -o acme-dev1')).toEqual([
      { target: 'acme-prod' },
      { target: 'acme-dev1' },
    ]);
  });
  it('a target glued to a short flag cannot be read', () => {
    expect(target('sf org login jwt -a acme-dev1\nsf project deploy start -oacme-prod')).toEqual([{ target: null }]);
    expect(target('sfdx force:source:deploy -uacme-prod')).toEqual([{ target: null }]);
    expect(target('sf project deploy start -o=acme-dev1')).toEqual([{ target: 'acme-dev1' }]);
  });
  it('a default org set with flags between the words turns off the login fallback', () => {
    const s = 'sf org login jwt --alias acme-dev1\nsf project deploy start';
    for (const extra of ['sf config set --global target-org acme-prod', 'sf config set -g target-org=acme-prod', 'sfdx config:set -g defaultusername=acme-prod']) {
      expect(target(s, `${extra}\n${s}`), extra).toEqual([{ target: null }]);
    }
  });
  it('detects sf run as @salesforce/cli', () => {
    expect(target('npx @salesforce/cli project deploy start -o acme-dev1')).toEqual([{ target: 'acme-dev1' }]);
    expect(target('npx @salesforce/cli@2 project deploy start -o acme-prod')).toEqual([{ target: 'acme-prod' }]);
    expect(target('npx @salesforce/cli org list')).toEqual([]);
  });
});

describe('workflowsCheck', () => {
  const DEV1 = { orgId: '00D000000000001AAA' };
  const QA = { orgId: '00D000000000002AAA' };
  const UAT = { orgId: '00D000000000003AAA' };
  const A = { orgs: { 'acme-dev1': DEV1 }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] };
  const B = {
    productionBranch: 'main',
    orgs: { 'acme-dev1': DEV1, 'acme-qa': QA, 'acme-uat': UAT },
    build: ['acme-dev1'],
    test: 'qa',
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  };
  const OK = { ok: true, level: 'error' };
  const FAIL = { ok: false, level: 'error' };
  const UNLISTED = 'deploys to an org not in salesforce.orgs';
  const UNREADABLE = 'deploys to a target doctor cannot read; give --target-org an alias from salesforce.orgs';

  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-workflows-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const write = (name, text) => {
    const dir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  const workflow = (on, run) => `name: deploy\n${on}\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ${run}\n`;
  const onMain = 'on:\n  push:\n    branches: [main]';
  const check = (block, config = {}) => workflowsCheck(layout(block, config), { root, fs });

  it('is ok "no workflows" when .github/workflows is missing or holds no workflow', () => {
    expect(check(A)).toEqual({ ...OK, detail: 'no workflows' });
    write('README.md', 'x');
    expect(check(A)).toEqual({ ...OK, detail: 'no workflows' });
  });
  it('(a) passes a main-push deploy to acme-dev1', () => {
    write('deploy.yml', workflow(onMain, 'sf project deploy start --source-dir force-app -o acme-dev1'));
    expect(check(A)).toEqual({ ...OK, detail: '1 deploy on main, all to orgs in salesforce.orgs' });
  });
  it('(a) fails a main-push deploy to acme-prod, without naming the alias', () => {
    write('deploy.yml', workflow(onMain, 'sf project deploy start -o acme-prod'));
    const r = check(A);
    expect(r).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yml on main: ${UNLISTED}` });
    expect(r.detail).not.toContain('acme-prod');
  });
  it('(a) fails a target from a secret, without naming the secret', () => {
    write('deploy.yml', workflow(onMain, 'sf project deploy start -o ${{ secrets.PROD_ALIAS }}'));
    const r = check(A);
    expect(r).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yml on main: ${UNREADABLE}` });
    expect(r.detail).not.toContain('PROD_ALIAS');
  });
  it('(b) ignores a deploy job on a branch Foreman never merges into', () => {
    write('deploy.yml', workflow(onMain, 'sf project deploy start -o acme-prod'));
    expect(check(B)).toEqual({ ...OK, detail: 'no workflow deploys qa, uat' });
  });
  it('(b) fails a workflow with no branch filter that deploys to acme-prod, naming qa and uat', () => {
    write('deploy.yml', workflow('on: push', 'sf project deploy start -o acme-prod'));
    expect(check(B)).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yml on qa, uat: ${UNLISTED}` });
  });
  it('(b) counts the deploys on each branch they run on', () => {
    write('qa.yml', workflow('on:\n  push:\n    branches: [qa]', 'sf project deploy start -o acme-qa'));
    write('uat.yaml', workflow('on:\n  push:\n    branches: [uat]', 'sf project deploy start -o acme-uat && sf project deploy validate -o acme-uat'));
    expect(check(B)).toEqual({ ...OK, detail: '3 deploys on qa, uat, all to orgs in salesforce.orgs' });
  });
  it('(a) with no productionBranch still blocks a deploy to acme-prod', () => {
    expect(layout(A, {}).productionBranch).toBeNull();
    write('deploy.yml', workflow('on:\n  push:', 'sf project deploy start -o acme-prod'));
    expect(check(A)).toMatchObject({ ...FAIL, detail: `.github/workflows/deploy.yml on main: ${UNLISTED}` });
  });
  it('fails a local reusable workflow, called from a main-push job, that deploys to acme-prod', () => {
    write('ci.yml', 'on:\n  push:\n    branches: [main]\njobs:\n  call:\n    uses: ./.github/workflows/deploy-reusable.yml\n  gone:\n    uses: ./.github/workflows/missing.yml\n');
    write('deploy-reusable.yml', workflow('on:\n  workflow_call:', 'sf project deploy start -o acme-prod'));
    expect(check(A)).toEqual({ ...FAIL, detail: `.github/workflows/deploy-reusable.yml on main: ${UNLISTED}` });
  });
  it('fails a workflow it cannot read', () => {
    fs.mkdirSync(path.join(root, '.github', 'workflows', 'x.yml'), { recursive: true });
    expect(check(A)).toEqual({ ...FAIL, detail: 'could not read .github/workflows/x.yml' });
  });
  it('names five bad files, then how many more', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) write(`d${n}.yml`, workflow(onMain, 'sf project deploy start -o acme-prod'));
    const r = check(A);
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toBe(`${[1, 2, 3, 4, 5].map((n) => `.github/workflows/d${n}.yml on main: ${UNLISTED}`).join('; ')} and 1 more`);
  });
  it('names each kind of problem once per file', () => {
    write('deploy.yml', workflow(onMain, 'sf project deploy start -o acme-prod; sf project deploy start -o acme-uat; sf project deploy start -o $X'));
    expect(check(A).detail).toBe(`.github/workflows/deploy.yml on main: ${UNLISTED}; .github/workflows/deploy.yml on main: ${UNREADABLE}`);
  });
  it('fails a deploy to a production org even though salesforce.orgs lists it, and still passes one to acme-qa', () => {
    const withMain = { ...B, orgs: { ...B.orgs, 'acme-main': { orgId: '00D000000000004AAA', production: true } } };
    write('deploy.yml', workflow('on:\n  push:\n    branches: [qa]', 'sf project deploy start -o acme-main'));
    const r = check(withMain);
    expect(r).toEqual({ ...FAIL, detail: '.github/workflows/deploy.yml on qa: deploys to a production org; Foreman never deploys to production' });
    expect(r.detail).not.toContain('acme-main');
    write('deploy.yml', workflow('on:\n  push:\n    branches: [qa]', 'sf project deploy start -o acme-qa'));
    expect(check(withMain)).toEqual({ ...OK, detail: '1 deploy on qa, all to orgs in salesforce.orgs' });
  });
  it('fails a deploy to a production org spelled --u', () => {
    const withMain = { ...B, orgs: { ...B.orgs, 'acme-main': { orgId: '00D000000000004AAA', production: true } } };
    for (const step of ['sf project deploy start --u acme-main', 'sf project deploy start --u=acme-main']) {
      write('deploy.yml', workflow('on:\n  push:\n    branches: [qa]', step));
      expect(check(withMain), step).toEqual({ ...FAIL, detail: '.github/workflows/deploy.yml on qa: deploys to a production org; Foreman never deploys to production' });
    }
  });
  it('reads .yaml files, and not other extensions', () => {
    write('deploy.yaml', workflow(onMain, 'sf project deploy start -o acme-prod'));
    write('deploy.yml.bak', workflow(onMain, 'sf project deploy start -o $X'));
    write('deploy.json', workflow(onMain, 'sf project deploy start -o $X'));
    expect(check(A)).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yaml on main: ${UNLISTED}` });
  });
  it('fails when .github/workflows cannot be read, and is ok only when it is missing', () => {
    const withError = (code) => ({
      ...fs,
      readdirSync: () => { throw Object.assign(new Error('x'), { code }); },
    });
    for (const code of ['EACCES', 'ENOTDIR', undefined]) {
      expect(workflowsCheck(layout(A, {}), { root, fs: withError(code) }), String(code)).toEqual({ ...FAIL, detail: 'could not read .github/workflows' });
    }
    expect(workflowsCheck(layout(A, {}), { root, fs: withError('ENOENT') })).toEqual({ ...OK, detail: 'no workflows' });
  });
  it('fails a column-0 on: list with push that deploys to acme-prod', () => {
    write('deploy.yml', 'name: d\non:\n- push\njobs:\n  deploy:\n    runs-on: x\n    steps:\n      - run: sf project deploy start -o acme-prod\n');
    const r = check(A);
    expect(r).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yml on main: ${UNLISTED}` });
    expect(r.detail).not.toContain('acme-prod');
  });
  it('fails an empty branches filter that deploys to acme-prod', () => {
    write('deploy.yml', workflow('on:\n  push:\n    branches:', 'sf project deploy start -o acme-prod'));
    expect(check(B)).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yml on qa, uat: ${UNLISTED}` });
  });
  it('fails a redirect-split deploy to acme-prod after one login', () => {
    write('deploy.yml', workflow(onMain, 'sf org login jwt -a acme-dev1 && sf project deploy start 2>&1 -o acme-prod'));
    expect(check(A)).toEqual({ ...FAIL, detail: `.github/workflows/deploy.yml on main: ${UNLISTED}` });
  });
});

describe('parseWorkflow pullRequest and runsOnPullRequest', () => {
  const onPr = (text, branch) => runsOnPullRequest(parseWorkflow(text), branch);
  it('on: pull_request, [push, pull_request], a key and a column-0 list each run on main', () => {
    for (const text of ['on: pull_request\n', 'on: [push, pull_request]\n', 'on:\n  pull_request:\n', 'on:\n- pull_request\n']) {
      expect(onPr(text, 'main'), text).toBe(true);
    }
  });
  it('on: pull_request_target runs on main, with exactly one filter', () => {
    expect(onPr('on: pull_request_target\n', 'main')).toBe(true);
    expect(parseWorkflow('on: pull_request_target\n').pullRequest).toHaveLength(1);
    expect(parseWorkflow('on:\n  pull_request_target:\n').pullRequest).toHaveLength(1);
    expect(parseWorkflow('on: pull_request\n').pullRequest).toHaveLength(1);
  });
  it('push alone gives no pull request filter', () => {
    for (const text of ['on: push\n', 'on:\n  push:\n    branches: [main]\n', 'on: workflow_dispatch\n']) {
      expect(parseWorkflow(text).pullRequest, text).toEqual([]);
      expect(onPr(text, 'main'), text).toBe(false);
    }
  });
  it('a pull_request branch filter runs on the branches it lists only', () => {
    const text = 'on:\n  pull_request:\n    branches: [develop]\n';
    expect(onPr(text, 'develop')).toBe(true);
    expect(onPr(text, 'main')).toBe(false);
  });
  it('branches-ignore skips what it lists', () => {
    expect(onPr('on:\n  pull_request:\n    branches-ignore: [main]\n', 'main')).toBe(false);
    expect(onPr('on:\n  pull_request:\n    branches-ignore: [main]\n', 'qa')).toBe(true);
  });
  it('a push-only filter is not read as a pull request filter', () => {
    const text = 'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [develop]\n';
    expect(onPr(text, 'main')).toBe(false);
    expect(runsOn(text, 'main')).toBe(true);
  });
  it('a workflow with both pull_request and pull_request_target runs when either does', () => {
    const text = 'on:\n  pull_request:\n    branches: [develop]\n  pull_request_target:\n    branches: [main]\n';
    expect(onPr(text, 'main')).toBe(true);
    expect(onPr(text, 'develop')).toBe(true);
    expect(onPr(text, 'qa')).toBe(false);
  });
  it('an on: the reader cannot place counts as running on pull requests', () => {
    expect(onPr('on:\njobs:\n  a:\n    runs-on: x\n', 'main')).toBe(true);
  });
  it('runsOnPullRequest is false for a missing or odd workflow', () => {
    expect(runsOnPullRequest(null, 'main')).toBe(false);
    expect(runsOnPullRequest({}, 'main')).toBe(false);
  });
});

describe('pullRequestWorkflows', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prwf-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const write = (name, text) => {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', name), text);
  };

  it('gives no names and no error without .github', () => {
    expect(pullRequestWorkflows(root, 'main', fs)).toEqual({ names: [], error: null });
  });
  it('names the workflows that run on a pull request into the branch', () => {
    write('ci.yml', 'on: pull_request\n');
    write('deploy.yml', 'on:\n  push:\n    branches: [main]\n');
    expect(pullRequestWorkflows(root, 'main', fs)).toEqual({ names: ['ci.yml'], error: null });
  });
  it('counts .yaml and not .txt', () => {
    write('ci.yaml', 'on: pull_request\n');
    write('notes.txt', 'on: pull_request\n');
    expect(pullRequestWorkflows(root, 'main', fs)).toEqual({ names: ['ci.yaml'], error: null });
  });
  it('leaves out a workflow for another branch', () => {
    write('ci.yml', 'on:\n  pull_request:\n    branches: [develop]\n');
    expect(pullRequestWorkflows(root, 'main', fs).names).toEqual([]);
    expect(pullRequestWorkflows(root, 'develop', fs).names).toEqual(['ci.yml']);
  });
  it('sorts by file name', () => {
    write('b.yml', 'on: pull_request\n');
    write('a.yml', 'on: pull_request\n');
    expect(pullRequestWorkflows(root, 'main', fs).names).toEqual(['a.yml', 'b.yml']);
  });
  it('gives the error when the folder or a file cannot be read', () => {
    const denied = { ...fs, readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    expect(pullRequestWorkflows(root, 'main', denied)).toEqual({ names: [], error: 'could not read .github/workflows' });
    write('ci.yml', 'on: pull_request\n');
    const noFile = { ...fs, readFileSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    expect(pullRequestWorkflows(root, 'main', noFile).error).toBe('could not read .github/workflows');
  });
  it('never throws on a root that is not text', () => {
    for (const bad of [undefined, null, 7, {}]) {
      expect(pullRequestWorkflows(bad, 'main', fs), String(bad)).toEqual({ names: [], error: 'could not read .github/workflows' });
    }
  });
  it('never throws without an fs', () => {
    expect(pullRequestWorkflows(root, 'main', undefined).error).toBe('could not read .github/workflows');
  });
});
