import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_SUMMARY,
  DEVHUB_COMMANDS,
  DEVHUB_SPELLINGS,
  DEVOPS_SPELLINGS,
  PROD_ALLOWED,
  SF_PROD_CHECK,
  TARGET_SPELLINGS,
  allowedEntry,
  commandWords,
  deployEndpoint,
  deploys,
  exposes,
  isProductionName,
  namesProduction,
  prodReason,
  toolingWrite,
} from './prod-block.mjs';
import { ACME_DEV1_ID, ACME_PROD_ID } from '../../../test/fake-sf.mjs';

const PROD_USER = 'ops@acme.example';
const DEV1_USER = 'dev1@acme.example';
const production = [{ alias: 'acme-main', orgId: ACME_PROD_ID }];

let tmp;
let home;
let work;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prodblock-'));
  home = path.join(tmp, 'sf-home');
  work = path.join(tmp, 'project', 'worktree');
  const sfdx = path.join(home, '.sfdx');
  fs.mkdirSync(sfdx, { recursive: true });
  fs.mkdirSync(path.join(work, 'force-app', 'main'), { recursive: true });
  fs.writeFileSync(path.join(work, 'sfdx-project.json'), '{}');
  fs.writeFileSync(path.join(sfdx, 'alias.json'), JSON.stringify({ orgs: { 'acme-main': PROD_USER, 'acme-dev1': DEV1_USER, 'acme-other': PROD_USER } }));
  fs.writeFileSync(path.join(sfdx, `${PROD_USER}.json`), JSON.stringify({ orgId: ACME_PROD_ID, username: PROD_USER }));
  fs.writeFileSync(path.join(sfdx, `${DEV1_USER}.json`), JSON.stringify({ orgId: ACME_DEV1_ID, username: DEV1_USER }));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const reason = (args, { env = {}, cwd = work, prod = production } = {}) => prodReason({ args, env, cwd, home, production: prod, fs });
const PROD = /deploys to acme-main, a production org marked "production": true in salesforce\.orgs; Foreman never deploys to production/;
const EXPOSE = /prints or hands out the credentials of acme-main, a production org marked "production": true in salesforce\.orgs, or calls its API directly/;
const NOT_ALLOWED = /acme-main is a production org marked "production": true in salesforce\.orgs, and this command is not one Foreman allows against production/;
const UNKNOWN = /could not tell which org this runs against/;
const TOOLING = /this changes metadata in acme-main, a production org marked "production": true in salesforce\.orgs, through the Tooling API/;
const FLAGS_DIR = /--flags-dir/;
// Every way a command can name an org: each target, DevOps Center and dev-hub spelling, in each
// form, and a bare word.
const SPELLED = (x) => [
  ['-o', x],
  [`-o${x}`],
  [`-o=${x}`],
  ['--target-org', x],
  [`--target-org=${x}`],
  ['-u', x],
  ['--u', x],
  [`--u=${x}`],
  ['--targetusername', x],
  [`--targetusername=${x}`],
  ['-c', x],
  ['--devops-center-username', x],
  [`--devops-center-username=${x}`],
  ['-v', x],
  [`--target-dev-hub=${x}`],
  [x],
];
// Each production name: alias, 18- and 15-character org ID, username, and another alias for it.
const PROD_NAMES = ['acme-main', ACME_PROD_ID, ACME_PROD_ID.slice(0, 15), PROD_USER, 'acme-other'];
// Commands not on the allow-list, each with the reason it gets against production.
const REFUSED = [
  ['package install -p 04t000000000001', PROD],
  ['org delete sandbox', PROD],
  ['community publish', PROD],
  ['org display', EXPOSE],
  ['org open --url-only', EXPOSE],
  ['apex run -f x.apex', NOT_ALLOWED],
  ['project deploy report --job-id 0Af', NOT_ALLOWED],
  ['package installed list', NOT_ALLOWED],
  ['org create sandbox --name dev', NOT_ALLOWED],
  ['api request rest /services/data', EXPOSE],
];
const split = (command) => command.split(' ');
// Each command that prints or hands out an org's credentials, or calls its API directly.
const EXPOSING = [
  'org display',
  'org display user',
  'force:org:display',
  'force:user:display',
  'org open',
  'org open agent',
  'force:source:open',
  'org generate password',
  'force:user:password:generate',
  'org auth show-access-token',
  'org auth show-sfdx-auth-url',
  'org auth show-user-password',
  'api request rest',
  'api request graphql',
];

describe('commandWords and deploys', () => {
  it('reads the words before the first flag, split at colons', () => {
    expect(commandWords(['project', 'deploy', 'start', '-o', 'x'])).toEqual(['project', 'deploy', 'start']);
    expect(commandWords(['force:source:deploy', '-p', 'force-app'])).toEqual(['force', 'source', 'deploy']);
  });
  it('knows the commands that deploy, in any word order', () => {
    for (const args of [
      ['project', 'deploy', 'start'],
      ['deploy', 'project', 'validate'],
      ['project', 'deploy', 'resume'],
      ['deploy', 'metadata'],
      ['force:source:deploy'],
      ['force:mdapi:deploy'],
      ['project', 'delete', 'source'],
      ['force:source:push'],
      ['org', 'delete', 'sandbox'],
      ['org', 'refresh', 'sandbox'],
      ['package', 'install'],
      ['package', 'uninstall'],
      ['agent', 'publish', 'authoring-bundle'],
      ['community', 'publish'],
      ['devops', 'promote'],
      ['devops:promotion:complete'],
      ['devops', 'promotion', 'validate'],
      ['devops', 'work-item', 'promote'],
    ]) {
      expect(deploys(commandWords(args)), args.join(' ')).toBe(true);
    }
    for (const args of [['data', 'query'], ['project', 'retrieve', 'start'], ['org', 'list'], ['apex', 'run'], ['org', 'create', 'scratch'], ['project', 'deploy', 'report'], ['devops', 'work-item', 'list'], ['devops', 'pipeline', 'get']]) {
      expect(deploys(commandWords(args)), args.join(' ')).toBe(false);
    }
  });
});

describe('exposes and deployEndpoint', () => {
  it('knows the commands that print or hand out credentials, or call the API directly', () => {
    for (const command of EXPOSING) expect(exposes(commandWords(split(command))), command).toBe(true);
    for (const command of ['data query', 'org list', 'org list limits', 'org list users', 'project retrieve start', 'info releasenotes display']) {
      expect(exposes(commandWords(split(command))), command).toBe(false);
    }
  });
  it('finds a deploy endpoint in any word, and not in ordinary queries', () => {
    for (const args of [
      ['api', 'request', 'rest', '/services/data/v62.0/metadata/deployRequest'],
      ['https://acme.my.salesforce.com/services/Soap/m/62.0'],
      ['data', 'create', 'record', '--sobject', 'MetadataContainer'],
      ['ContainerAsyncRequest'],
    ]) {
      expect(deployEndpoint(args), args.join(' ')).toBe(true);
    }
    expect(deployEndpoint(['data', 'query', '--query', 'SELECT Id FROM GroupMember'])).toBe(false);
  });
});

describe('prodReason', () => {
  it('is null for every command when no production org is configured', () => {
    expect(reason(['project', 'deploy', 'start', '-o', 'acme-main'], { prod: [] })).toBeNull();
    expect(reason(['project', 'deploy', 'start'], { prod: [] })).toBeNull();
  });

  it('refuses a deploy whose -o names the production org by alias, org ID, username, or another alias for it', () => {
    for (const target of ['acme-main', ACME_PROD_ID, ACME_PROD_ID.slice(0, 15), PROD_USER, 'acme-other']) {
      for (const args of [
        ['project', 'deploy', 'start', '-o', target],
        ['project', 'deploy', 'start', `--target-org=${target}`],
        ['project', 'deploy', 'start', `-o${target}`],
        ['force:source:deploy', '-p', 'force-app', '-u', target],
        ['project', 'delete', 'source', '-m', 'ApexClass:X', '--target-org', target],
        ['devops', 'promote', '-t', '1Fa000000000001', '-o', target],
        ['devops', 'promotion', 'complete', '-a', '-t', '1Fa000000000001', '-o', target],
      ]) {
        expect(reason(args), args.join(' ')).toMatch(PROD);
      }
    }
  });

  it('never names a username in its reason', () => {
    expect(reason(['project', 'deploy', 'start', '-o', PROD_USER])).not.toContain(PROD_USER);
    expect(reason(['project', 'deploy', 'start', '-o', 'nobody@acme.example'])).not.toContain('nobody@acme.example');
  });

  it('allows a deploy to a sandbox whose login is in the home', () => {
    expect(reason(['project', 'deploy', 'start', '-o', 'acme-dev1'])).toBeNull();
    expect(reason(['project', 'deploy', 'start', '--target-org', DEV1_USER])).toBeNull();
  });

  it('refuses a command that prints its credentials or calls its API, by alias, org ID, username or another alias', () => {
    for (const target of ['acme-main', ACME_PROD_ID, PROD_USER, 'acme-other']) {
      for (const command of [
        'org display --verbose --json',
        'org display user',
        'org open --url-only',
        'org generate password',
        'org auth show-access-token',
        'api request rest /services/data/v62.0/limits',
        'api request graphql --body q.json',
      ]) {
        const args = [...split(command), '-o', target];
        expect(reason(args), args.join(' ')).toMatch(EXPOSE);
        expect(reason(args), args.join(' ')).not.toContain(PROD_USER);
      }
    }
  });

  it('refuses an exposing command with no -o when the default org is production', () => {
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-main' });
    expect(reason(['org', 'display', '--verbose'])).toMatch(EXPOSE);
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
    expect(reason(['org', 'display', '--verbose'])).toBeNull();
    expect(reason(['org', 'display', '--verbose'], { env: { SF_TARGET_ORG: 'acme-main' } })).toMatch(EXPOSE);
  });

  it('allows the exposing commands against a sandbox', () => {
    for (const command of EXPOSING) {
      const args = [...split(command), '-o', 'acme-dev1'];
      expect(reason(args), args.join(' ')).toBeNull();
    }
  });

  it('counts a call to a deploy endpoint as a deploy', () => {
    expect(reason(['api', 'request', 'rest', '/services/data/v62.0/metadata/deployRequest', '--method', 'POST', '-o', 'acme-main'])).toMatch(PROD);
    expect(reason(['data', 'create', 'record', '--sobject', 'ContainerAsyncRequest', '--use-tooling-api', '-o', 'acme-main'])).toMatch(PROD);
  });

  it('says which commands run against production, without a username', () => {
    for (const args of [
      ['project', 'deploy', 'start', '-o', PROD_USER],
      ['apex', 'run', '-f', 'x.apex', '-o', PROD_USER],
    ]) {
      const text = reason(args);
      expect(text, args.join(' ')).toContain(`Against production Foreman runs only: ${ALLOWED_SUMMARY}.`);
      expect(text, args.join(' ')).not.toContain(PROD_USER);
    }
    expect(reason(['apex', 'run', '-f', 'x.apex', '-o', PROD_USER])).toBe(
      `foreman: sf refused: acme-main is a production org marked "production": true in salesforce.orgs, and this command is not one Foreman allows against production. Against production Foreman runs only: ${ALLOWED_SUMMARY}. Deployments to production are blocked.`,
    );
    expect(reason(['apex', 'run', '-f', 'x.apex', '-o', ACME_PROD_ID], { prod: [{ alias: '', orgId: ACME_PROD_ID }] })).toContain(`${ACME_PROD_ID.slice(0, 15)} is a production org`);
  });

  it('refuses a deploy with no -o when the project .sf/config.json points at production, from any folder in it', () => {
    for (const value of ['acme-main', ACME_PROD_ID, PROD_USER]) {
      writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': value });
      expect(reason(['project', 'deploy', 'start']), value).toMatch(PROD);
      expect(reason(['project', 'deploy', 'start'], { cwd: path.join(work, 'force-app', 'main') }), value).toMatch(PROD);
    }
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
    expect(reason(['project', 'deploy', 'start'])).toBeNull();
  });

  it('reads the legacy config, then the home config, as sf does', () => {
    writeJson(path.join(work, '.sfdx', 'sfdx-config.json'), { defaultusername: 'acme-main' });
    expect(reason(['force:source:deploy', '-p', 'force-app'])).toMatch(PROD);
    fs.rmSync(path.join(work, '.sfdx'), { recursive: true });

    writeJson(path.join(home, '.sf', 'config.json'), { 'target-org': 'acme-main' });
    expect(reason(['project', 'deploy', 'start'])).toMatch(PROD);
    // the project's own default wins over the home's
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
    expect(reason(['project', 'deploy', 'start'])).toBeNull();
  });

  it('ignores a config above the project root, which sf never reads', () => {
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
    writeJson(path.join(tmp, 'project', '.sf', 'config.json'), { 'target-org': 'acme-elsewhere' });
    expect(reason(['project', 'deploy', 'start'])).toBeNull();
  });

  it('refuses a deploy with no -o when SF_TARGET_ORG or SFDX_DEFAULTUSERNAME names production', () => {
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
    expect(reason(['project', 'deploy', 'start'], { env: { SF_TARGET_ORG: 'acme-main' } })).toMatch(PROD);
    expect(reason(['project', 'deploy', 'start'], { env: { SFDX_DEFAULTUSERNAME: PROD_USER } })).toMatch(PROD);
    expect(reason(['project', 'deploy', 'start'], { env: { SF_TARGET_ORG: 'acme-dev1', SFDX_DEFAULTUSERNAME: 'acme-main' } })).toMatch(PROD);
    expect(reason(['project', 'deploy', 'start'], { env: { SF_TARGET_ORG: 'acme-dev1' } })).toBeNull();
  });

  it('fails closed on a deploy whose org it cannot tell', () => {
    expect(reason(['project', 'deploy', 'start'])).toMatch(UNKNOWN);
    expect(reason(['project', 'deploy', 'start', '-o', 'acme-nowhere'])).toMatch(UNKNOWN);
    expect(reason(['project', 'deploy', 'start', '-o', '../escape'])).toMatch(UNKNOWN);
    fs.mkdirSync(path.join(work, '.sf'), { recursive: true });
    fs.writeFileSync(path.join(work, '.sf', 'config.json'), 'not json');
    expect(reason(['project', 'deploy', 'start'])).toMatch(UNKNOWN);
    fs.writeFileSync(path.join(home, '.sfdx', 'alias.json'), 'not json');
    expect(reason(['project', 'deploy', 'start', '-o', 'acme-dev1'])).toMatch(UNKNOWN);
    expect(reason(['project', 'deploy', 'start', '-o', 'acme-main'])).toMatch(PROD);
  });

  it('refuses a deploy given --flags-dir, which can name the org out of sight', () => {
    expect(reason(['project', 'deploy', 'start', '--flags-dir', 'flags', '-o', 'acme-dev1'])).toMatch(/--flags-dir/);
    expect(reason(['project', 'deploy', 'start', '--flags-dir=flags'])).toMatch(/--flags-dir/);
    expect(reason(['apex', 'run', '--flags-dir', 'flags'])).toMatch(/--flags-dir/);
    expect(reason(['data', 'query', '--flags-dir', 'flags'])).toBeNull();
  });
});

describe('the allow-list', () => {
  const words = (id) => id.split(':');

  it('matches each allowed id in any word order, and nothing with another word', () => {
    for (const entry of PROD_ALLOWED) {
      expect(allowedEntry(words(entry.id)), entry.id).toBe(entry);
      expect(allowedEntry([...words(entry.id)].reverse()), entry.id).toBe(entry);
    }
    expect(allowedEntry(['list', 'org'])).toMatchObject({ id: 'org:list' });
    for (const cmd of [['org', 'list', 'foo'], ['force', 'data', 'soql', 'query'], ['apex', 'run'], ['org', 'display'], ['org', 'list', 'list'], []]) {
      expect(allowedEntry(cmd), cmd.join(' ')).toBeNull();
    }
  });

  it('marks scratch org create and delete as Dev Hub only, and nothing else', () => {
    expect(allowedEntry(['org', 'create', 'scratch'])).toEqual({ id: 'org:create:scratch', devHubOnly: true });
    expect(allowedEntry(['org', 'delete', 'scratch'])).toEqual({ id: 'org:delete:scratch', devHubOnly: true });
    expect(PROD_ALLOWED.filter((e) => e.devHubOnly).map((e) => e.id)).toEqual(['org:create:scratch', 'org:delete:scratch']);
    expect(Object.isFrozen(PROD_ALLOWED)).toBe(true);
  });

  it('lists none of the commands the owner refused', () => {
    for (const id of ['org:display', 'org:display:user', 'org:open', 'org:generate:password', 'api:request:rest', 'apex:run', 'apex:run:test', 'project:deploy:start', 'project:deploy:report', 'package:install', 'org:create:sandbox']) {
      expect(allowedEntry(words(id)), id).toBeNull();
    }
  });
});

describe('isProductionName and namesProduction', () => {
  const isProd = (text) => isProductionName(production, text);

  it('matches an alias exactly and an org ID by its first 15 characters', () => {
    expect(isProd('acme-main')).toEqual(production[0]);
    expect(isProd(ACME_PROD_ID)).toEqual(production[0]);
    expect(isProd(ACME_PROD_ID.slice(0, 15))).toEqual(production[0]);
    expect(isProd(`${ACME_PROD_ID.slice(0, 15)}ZZZ`)).toEqual(production[0]);
    for (const text of ['acme-mai', 'ACME-MAIN', ACME_PROD_ID.slice(0, 14), `x${ACME_PROD_ID}`, PROD_USER, '', undefined]) {
      expect(isProd(text), String(text)).toBeFalsy();
    }
  });

  it('finds production in every spelling and form, and as a bare word', () => {
    for (const name of ['acme-main', ACME_PROD_ID, ACME_PROD_ID.slice(0, 15)]) {
      for (const spelled of SPELLED(name)) {
        const texts = ['package', 'install', ...spelled];
        expect(namesProduction(texts, isProd), texts.join(' ')).toEqual(production[0]);
      }
    }
    expect(namesProduction(['data', 'query', '-o', 'acme-dev1', '--query', 'SELECT Id FROM Account'], isProd)).toBeNull();
  });

  it('skips the dev-hub values with skipDevHub, and nothing else', () => {
    for (const texts of [
      ['org', 'create', 'scratch', '-v', 'acme-main'],
      ['org', 'create', 'scratch', '--target-dev-hub', 'acme-main'],
      ['org', 'create', 'scratch', '--target-dev-hub=acme-main'],
      ['org', 'create', 'scratch', '-vacme-main'],
      ['org', 'create', 'scratch', '--targetdevhubusername', ACME_PROD_ID],
    ]) {
      expect(namesProduction(texts, isProd, { skipDevHub: true }), texts.join(' ')).toBeNull();
      expect(namesProduction(texts, isProd), texts.join(' ')).toEqual(production[0]);
    }
    expect(namesProduction(['org', 'delete', 'scratch', '-o', 'acme-main'], isProd, { skipDevHub: true })).toEqual(production[0]);
    expect(namesProduction(['org', 'create', 'scratch', '-v', 'acme-dev1', 'acme-main'], isProd, { skipDevHub: true })).toEqual(production[0]);
  });
});

describe('prodReason against the allow-list', () => {
  it('refuses every command off the list that names production, in every spelling, with its reason', () => {
    for (const [command, why] of REFUSED) {
      for (const name of PROD_NAMES) {
        for (const spelled of SPELLED(name)) {
          const args = [...split(command), ...spelled];
          const text = reason(args);
          expect(text, args.join(' ')).toMatch(why);
          expect(text, args.join(' ')).not.toContain(PROD_USER);
        }
      }
    }
  });

  it('refuses a DevOps Center pipeline deploy that names production as its DevOps Center org', () => {
    for (const step of ['start', 'validate', 'quick', 'resume']) {
      for (const spelled of [['-c', 'acme-main'], ['--devops-center-username', 'acme-main'], ['--devops-center-username=acme-main'], ['-c', PROD_USER]]) {
        const args = ['project', 'deploy', 'pipeline', step, '--branch-name', 'main', ...spelled];
        expect(reason(args), args.join(' ')).toMatch(PROD);
      }
      expect(reason(['project', 'deploy', 'pipeline', step, '-c', 'acme-dev1'])).toBeNull();
      expect(reason(['project', 'deploy', 'pipeline', step, '-c', 'acme-nowhere'])).toMatch(UNKNOWN);
    }
  });

  it('refuses a DevOps Center pipeline deploy with no DevOps Center org given, whatever the default org', () => {
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
    for (const step of ['start', 'validate', 'quick', 'resume']) {
      for (const extra of [[], ['-o', 'acme-dev1'], ['--target-org=acme-dev1']]) {
        const args = ['project', 'deploy', 'pipeline', step, '-p', 'P', '-b', 'main', ...extra];
        expect(reason(args), args.join(' ')).toMatch(UNKNOWN);
        expect(reason(args, { env: { SF_TARGET_ORG: 'acme-dev1' } }), args.join(' ')).toMatch(UNKNOWN);
      }
    }
    expect(reason(['project', 'deploy', 'pipeline', 'report', '-i', '0Af'])).toBeNull();
  });

  it('allows every command on the list against production, by -o or --u, without reading a file', () => {
    const none = { readFileSync: () => { throw new Error('read'); }, existsSync: () => { throw new Error('read'); } };
    for (const entry of PROD_ALLOWED.filter((e) => !e.devHubOnly)) {
      for (const spelled of [['-o', 'acme-main'], ['--u', 'acme-main'], [`--target-org=${ACME_PROD_ID}`], ['-u', PROD_USER]]) {
        const args = [...entry.id.split(':'), ...spelled];
        expect(reason(args), args.join(' ')).toBeNull();
        expect(prodReason({ args, env: { SF_TARGET_ORG: 'acme-main' }, cwd: work, home, production, fs: none }), args.join(' ')).toBeNull();
      }
    }
  });

  it('allows scratch org create on a production Dev Hub, and scratch org delete only off production', () => {
    for (const spelled of [['--target-dev-hub', 'acme-main'], ['-v', 'acme-main'], ['--target-dev-hub=acme-main'], ['-vacme-main']]) {
      const args = ['org', 'create', 'scratch', '-f', 'config/project-scratch-def.json', ...spelled];
      expect(reason(args), args.join(' ')).toBeNull();
    }
    expect(reason(['org', 'delete', 'scratch', '-o', 'acme-main'])).toMatch(PROD);
    expect(reason(['org', 'delete', 'scratch', '-o', 'acme-dev1'])).toBeNull();
    expect(reason(['org', 'create', 'scratch', '-v', 'acme-main', '-o', 'acme-main'])).toMatch(NOT_ALLOWED);
  });

  it('still refuses an allowed command that calls a deploy endpoint against production', () => {
    expect(reason(['data', 'create', 'record', '--sobject', 'MetadataContainer', '--use-tooling-api', '-o', 'acme-main'])).toMatch(PROD);
    expect(reason(['data', 'create', 'record', '--sobject', 'MetadataContainer', '--use-tooling-api', '-o', 'acme-dev1'])).toBeNull();
  });

  it('refuses a record change through the Tooling API against production, since it changes metadata', () => {
    for (const verb of ['create', 'update', 'delete']) {
      // --usetoolingapi is the CLI's deprecated alias (2.150.6); --use-toolingapi stands for any
      // later spelling of the same name, which fails closed.
      for (const tooling of ['-t', '--use-tooling-api', '--use-tooling-api=true', '--usetoolingapi', '--usetoolingapi=true', '--use-toolingapi']) {
        for (const target of ['acme-main', ACME_PROD_ID, PROD_USER, 'acme-other']) {
          const args = ['data', verb, 'record', tooling, '--sobject', 'CustomField', '--record-id', '00N000000000001', '-o', target];
          const text = reason(args);
          expect(text, args.join(' ')).toMatch(TOOLING);
          expect(text, args.join(' ')).not.toContain(PROD_USER);
        }
        const base = ['data', verb, 'record', tooling, '--sobject', 'Flow', '--record-id', '301000000000001'];
        expect(reason([...base, '-o', 'acme-dev1']), base.join(' ')).toBeNull();
        // fails closed when it cannot tell the org, as a deploy does
        expect(reason([...base, '-o', 'acme-nowhere']), base.join(' ')).toMatch(UNKNOWN);
        expect(reason(base, { env: { SF_TARGET_ORG: 'acme-main' } }), base.join(' ')).toMatch(TOOLING);
      }
    }
    // A Tooling API read changes nothing, and a plain record change stays allowed.
    expect(reason(['data', 'query', '-t', '--query', 'SELECT Id FROM CustomField', '-o', 'acme-main'])).toBeNull();
    expect(reason(['data', 'get', 'record', '--use-tooling-api', '--sobject', 'Flow', '--record-id', '301', '-o', 'acme-main'])).toBeNull();
    expect(reason(['data', 'delete', 'record', '--sobject', 'Account', '--record-id', '001', '-o', 'acme-main'])).toBeNull();
  });

  it('refuses a record change given --flags-dir, which can add --use-tooling-api out of sight', () => {
    for (const verb of ['create', 'update', 'delete']) {
      for (const flagsDir of [['--flags-dir', 'd'], ['--flags-dir=d']]) {
        for (const target of [['-o', 'acme-main'], ['-o', 'acme-dev1'], []]) {
          const args = ['data', verb, 'record', ...flagsDir, ...target];
          expect(reason(args), args.join(' ')).toMatch(FLAGS_DIR);
        }
      }
    }
  });

  it('refuses a command off the list with no target when the default org is production', () => {
    for (const command of ['apex run -f x.apex', 'package install -p 04t000000000001']) {
      writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-main' });
      expect(reason(split(command)), command).toMatch(/acme-main/);
      writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-dev1' });
      expect(reason(split(command)), command).toBeNull();
      expect(reason(split(command), { env: { SF_TARGET_ORG: 'acme-main' } }), command).toMatch(/acme-main/);
    }
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-org': 'acme-main' });
    expect(reason(['apex', 'run', '-f', 'x.apex'])).toMatch(NOT_ALLOWED);
    expect(reason(['package', 'install', '-p', '04t000000000001'])).toMatch(PROD);
  });

  it('refuses a Dev Hub command with no -v when the default dev hub is production', () => {
    const args = ['package', 'version', 'create', '-p', 'X'];
    expect(reason(args, { env: { SF_TARGET_DEV_HUB: 'acme-main' } })).toMatch(NOT_ALLOWED);
    expect(reason(args, { env: { SFDX_DEFAULTDEVHUBUSERNAME: PROD_USER } })).toMatch(NOT_ALLOWED);
    expect(reason(['force:package:version:create', '-p', 'X'], { env: { SF_TARGET_DEV_HUB: 'acme-main' } })).toMatch(NOT_ALLOWED);
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-dev-hub': 'acme-main' });
    expect(reason(args)).toMatch(NOT_ALLOWED);
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-dev-hub': 'acme-dev1' });
    expect(reason(args)).toBeNull();
    fs.rmSync(path.join(work, '.sf'), { recursive: true });
    writeJson(path.join(work, '.sfdx', 'sfdx-config.json'), { defaultdevhubusername: 'acme-main' });
    expect(reason(args)).toMatch(NOT_ALLOWED);
    fs.rmSync(path.join(work, '.sfdx'), { recursive: true });
    writeJson(path.join(home, '.sf', 'config.json'), { 'target-dev-hub': 'acme-main' });
    expect(reason(args)).toMatch(NOT_ALLOWED);
    expect(reason([...args, '-v', 'acme-dev1'])).toBeNull();
    writeJson(path.join(home, '.sf', 'config.json'), { 'target-dev-hub': 'acme-dev1' });
    expect(reason(args)).toBeNull();
    fs.rmSync(path.join(home, '.sf'), { recursive: true });
    expect(reason(args)).toBeNull();
  });

  it('allows scratch org create when the default dev hub is production', () => {
    expect(reason(['org', 'create', 'scratch', '-f', 'def.json'], { env: { SF_TARGET_DEV_HUB: 'acme-main' } })).toBeNull();
    writeJson(path.join(work, '.sf', 'config.json'), { 'target-dev-hub': 'acme-main', 'target-org': 'acme-dev1' });
    expect(reason(['org', 'create', 'scratch', '-f', 'def.json'])).toBeNull();
  });

  it('runs a command off the list that names no org it can tie to production', () => {
    expect(reason(['agent', 'preview', 'send', '-u', 'hello'])).toBeNull();
    expect(reason(['agent', 'preview', 'send', '--utterance', 'acme-dev1'])).toBeNull();
    expect(reason(['apex', 'run', '-f', 'x.apex'])).toBeNull();
    expect(reason(['project', 'deploy', 'start', '-o', 'acme-dev1'])).toBeNull();
  });
});

describe('sf-prod-check', () => {
  // A production JSON that does not parse makes prodReason throw. Each check is a real process,
  // and they run at once: one after another they took over the slow-test limit on a busy machine.
  const check = (args) => new Promise((resolve) => {
    execFile(process.execPath, [SF_PROD_CHECK, 'not json', ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stderr });
    });
  });

  it('refuses everything off the list when the check itself fails, and runs the commands on it', { timeout: 30_000 }, async () => {
    const refused = [['apex', 'run', '-f', 'x.apex'], ['project', 'deploy', 'start'], ['org', 'create', 'scratch', '-v', 'acme-main'], ['data', 'create', 'record', '--sobject', 'MetadataContainer'], ['data', 'delete', 'record', '-t', '--sobject', 'CustomField'], ['data', 'update', 'record', '--use-tooling-api=true'], ['data', 'update', 'record', '--usetoolingapi'], ['data', 'create', 'record', '--usetoolingapi=true'], ['data', 'delete', 'record', '--usetoolingapi'], ['data', 'create', 'record', '--flags-dir', 'd']];
    const allowed = ['data', 'query', '--query', 'SELECT Id FROM Account'];
    const [r, ...results] = await Promise.all([check(allowed), ...refused.map(check)]);
    refused.forEach((args, i) => {
      expect(results[i].status, args.join(' ')).toBe(1);
      expect(results[i].stderr, args.join(' ')).toMatch(/the production check failed/);
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

// The spellings and Dev Hub commands above are read from this CLI's own command list, when sf
// is installed.
const SF_COMMANDS = (() => {
  const r = spawnSync('sf', ['commands', '--json'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true' } });
  try {
    const list = r.status === 0 ? JSON.parse(r.stdout) : null;
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
})();

describe.skipIf(!SF_COMMANDS)('against the installed sf', () => {
  const ORG_FLAGS = ['target-org', 'target-dev-hub', 'devops-center-username'];
  const spellings = new Set([...TARGET_SPELLINGS, ...DEVHUB_SPELLINGS, ...DEVOPS_SPELLINGS]);
  const sameWords = (a, b) => {
    const x = a.split(':');
    const y = b.split(':');
    return x.length === y.length && x.every((w) => y.includes(w)) && y.every((w) => x.includes(w));
  };

  it('knows every spelling of the org flags', { timeout: 180_000 }, () => {
    for (const command of SF_COMMANDS) {
      for (const [name, flag] of Object.entries(command.flags ?? {})) {
        if (!ORG_FLAGS.includes(name)) continue;
        const forms = [`--${flag.name ?? name}`, ...(flag.aliases ?? []).map((a) => `--${a}`), ...(flag.char ? [`-${flag.char}`] : [])];
        for (const form of forms) expect(spellings.has(form), `${command.id} ${form}`).toBe(true);
      }
    }
  });

  it('knows every command that takes a dev hub, and every allowed id exists', { timeout: 180_000 }, () => {
    for (const command of SF_COMMANDS.filter((c) => c.flags?.['target-dev-hub'])) {
      const known = DEVHUB_COMMANDS.some((id) => sameWords(id, command.id)) || PROD_ALLOWED.some((e) => e.devHubOnly && sameWords(e.id, command.id));
      expect(known, command.id).toBe(true);
    }
    const ids = new Set(SF_COMMANDS.map((c) => c.id));
    for (const entry of PROD_ALLOWED) expect(ids.has(entry.id), entry.id).toBe(true);
  });

  it('counts every spelling of use-tooling-api on an allowed command as a Tooling write, and marks every allowed command that writes with it', { timeout: 180_000 }, () => {
    // The allowed commands that take use-tooling-api only to read.
    const READS = ['data:query', 'data:get:record', 'sobject:describe'];
    for (const command of SF_COMMANDS) {
      const entry = PROD_ALLOWED.find((e) => sameWords(e.id, command.id));
      const flag = command.flags?.['use-tooling-api'];
      if (!entry || !flag) continue;
      if (READS.includes(entry.id)) continue;
      expect(entry.tooling, command.id).toBe(true);
      const cmd = command.id.split(':');
      const forms = [`--${flag.name ?? 'use-tooling-api'}`, ...(flag.aliases ?? []).map((a) => `--${a}`), ...(flag.char ? [`-${flag.char}`] : [])];
      for (const form of forms) {
        expect(toolingWrite(cmd, [...cmd, form]), `${command.id} ${form}`).toBe(true);
        if (form.startsWith('--')) expect(toolingWrite(cmd, [...cmd, `${form}=true`]), `${command.id} ${form}=true`).toBe(true);
      }
    }
  });
});

// Independent review, 2026-10-25: three routes past the allow-list.
describe('prodReason: routes found in review', () => {
  it('finds a production target hidden in combined one-letter flags', () => {
    expect(reason(['project', 'deploy', 'start', '-goacme-main'])).toMatch(PROD);
    expect(reason(['org', 'open', '-roacme-main'])).toMatch(EXPOSE);
    expect(reason(['package', 'install', '-wpacme-main'])).toMatch(PROD);
  });

  it('refuses package push-upgrade schedule outright while a production org is marked', () => {
    expect(reason(['package', 'push-upgrade', 'schedule', '-p', '04t000000000000AAA', '-l', `00D000000000001AAA,${ACME_PROD_ID}`])).toMatch(PROD);
    expect(reason(['package', 'push-upgrade', 'schedule', '-p', '04t000000000000AAA', '-f', 'orgs.txt'])).toMatch(PROD);
    expect(reason(['package', 'push-upgrade', 'schedule', '-p', '04t000000000000AAA', '-f', 'orgs.txt'], { prod: [] })).toBeNull();
  });

  it('finds a production org ID in a comma-separated list', () => {
    expect(reason(['package', 'install', '-p', '04t000000000000AAA', '-o', `acme-dev1,${ACME_PROD_ID}`])).toMatch(PROD);
  });

  it('refuses a command off the allow-list naming any target when the alias file cannot be read', () => {
    fs.writeFileSync(path.join(home, '.sfdx', 'alias.json'), '{ not json');
    expect(reason(['apex', 'run', '-o', 'acme-other'])).toMatch(UNKNOWN);
    expect(reason(['org', 'create', 'sandbox', '-o', 'acme-other', '-n', 'acme'])).toMatch(UNKNOWN);
    // a name sf cannot resolve either cannot reach production while the alias file is readable
    fs.writeFileSync(path.join(home, '.sfdx', 'alias.json'), JSON.stringify({ orgs: { 'acme-dev1': DEV1_USER } }));
    expect(reason(['apex', 'run', '-o', 'nobody-knows'])).toBeNull();
    // the slot org (known, not production) still runs
    expect(reason(['apex', 'run', '-o', 'acme-dev1'])).toBeNull();
  });
});
