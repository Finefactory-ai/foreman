import { describe, expect, it } from 'vitest';
import { guard, simpleCommands, slotOrg } from './guard.mjs';
import { ALLOWED_SUMMARY } from './prod-block.mjs';
import pack from './pack.mjs';
import { PACKS } from '../index.mjs';
import { bashDecision } from '../../lib/engine/bash-guard.mjs';
import { stageMap } from '../../lib/engine/state.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';

// Two build sandboxes, then QA and UAT; the tester's dry runs go to QA (test: 'qa').
const config = {
  pack: 'salesforce',
  salesforce: {
    productionBranch: 'main',
    orgs: {
      'acme-dev1': { orgId: '00D000000000001AAA' },
      'acme-dev2': { orgId: '00D000000000002AAA' },
      'acme-qa': { orgId: '00D0000000000QAAAA' },
      'acme-uat': { orgId: '00D000000000UATAAA' },
    },
    build: ['acme-dev1', 'acme-dev2'],
    test: 'qa',
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  },
};
const scratch = {
  ...config,
  salesforce: {
    ...config.salesforce,
    orgs: { ...config.salesforce.orgs, 'acme-hub': { orgId: '00D0000000000HUBAA' } },
    build: { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } },
  },
};
// The same with test left at its default, the slot's own org.
const testOnBuild = { ...config, salesforce: { ...config.salesforce, test: 'build' } };

const g = (command, { stage = 'build', slot = 'w1', cfg = config } = {}) => guard({ command, stage, slot, config: cfg });

const DENY = /^Foreman's Salesforce guard denies/;
const LOGIN = /org login/;
const QUICK = /deploy quick/;
const IGNORE = /--ignore-conflicts[\s\S]*--ignore-errors|--ignore-errors[\s\S]*--ignore-conflicts/;
const DEVHUB = /--target-dev-hub/;
const DEFAULTS = /default org and aliases belong to Foreman/;
const DYNAMIC = /cannot tell which program/;
const TARGET = /Give no target to use the slot org/;
const RETRIEVE = /sf project retrieve/;
const DATA_WRITE = /create, update, delete, upsert or import records/;
const KEY = /where Foreman keeps the project's Salesforce sign-in key/;
// Commands that name the key folder, ~/.config/foreman/sf, in its spellings.
const KEY_COMMANDS = [
  'cat ~/.config/foreman/sf/acme-shop-1234abcd/server.key',
  'cat $HOME/.config/foreman/sf/*/server.key',
  'cat "${HOME}/.config/foreman/sf/acme/server.key"',
  'ls /home/acme/.config/foreman/sf',
  'cp -r ~/.config/foreman/sf /tmp/x',
  'tar czf k.tgz ~/.config//foreman/sf/',
  'cat ~/.config/"foreman"/sf/a/server.key',
  'cat ~/.config/foreman/s\\f/a/server.key',
  "bash -c 'cat ~/.config/foreman/sf/a/server.key'",
  'npm test && cat ~/.config/foreman/sf/a/server.key',
  'echo x > ~/.config/foreman/sf/a/server.crt',
];

const denied = (command, pattern, opts) => {
  const reason = g(command, opts);
  expect(reason, command).toMatch(DENY);
  if (pattern) expect(reason, command).toMatch(pattern);
};
const allowed = (command, opts) => expect(g(command, opts), command).toBeNull();
const texts = (command) => simpleCommands(command).map((words) => words.map((w) => w.text));

describe('simpleCommands', () => {
  it('splits at && || ; | & and newline', () => {
    expect(texts('a && b; c || d | e & f\ng')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]);
  });

  it('drops redirections and their targets', () => {
    expect(texts('echo 2>&1 | tee x')).toEqual([['echo'], ['tee', 'x']]);
    expect(texts('2>/dev/null sf org login web')).toEqual([['sf', 'org', 'login', 'web']]);
    expect(texts('sf>out org')).toEqual([['sf', 'org']]);
    expect(texts('a &> o; b >> p; c >| q; d <<< w; e 3<in')).toEqual([['a'], ['b'], ['c'], ['d'], ['e']]);
  });

  it('still splits at a background &', () => {
    expect(texts('a & b')).toEqual([['a'], ['b']]);
  });

  it('keeps a quoted > as a word', () => {
    expect(texts('echo ">" x')).toEqual([['echo', '>', 'x']]);
  });

  it('collects a nested command in a redirect target', () => {
    expect(texts('echo a > "$(c d)"')).toContainEqual(['c', 'd']);
  });

  it('does not throw on deep nesting', () => {
    expect(() => simpleCommands('$('.repeat(20000))).not.toThrow();
  });

  it('joins a line ended by a backslash without adding a word', () => {
    expect(texts('sf org \\\nlogin web')).toEqual([['sf', 'org', 'login', 'web']]);
  });

  it('removes quotes', () => {
    expect(simpleCommands(`"s"'f' org`)).toEqual([[{ text: 'sf', dynamic: false }, { text: 'org', dynamic: false }]]);
  });

  it('marks words built at run time as dynamic', () => {
    for (const command of ['$X', '"$X"', '`x`']) expect(simpleCommands(command).at(-1)[0].dynamic, command).toBe(true);
    for (const command of ['\\$X', "'$X'"]) {
      const [[word]] = simpleCommands(command);
      expect(word, command).toEqual({ text: '$X', dynamic: false });
    }
  });

  it('returns the nested commands of subshells', () => {
    expect(texts('(a b)')).toContainEqual(['a', 'b']);
    expect(texts('echo $(c d)')).toContainEqual(['c', 'd']);
    expect(texts('echo "$(e f)"')).toContainEqual(['e', 'f']);
    expect(texts('echo `g h`')).toContainEqual(['g', 'h']);
  });

  it('marks a word with unquoted brace expansion', () => {
    expect(simpleCommands('{a,b} "{c,d}"')).toEqual([[{ text: '{a,b}', dynamic: false, braces: true }, { text: '{c,d}', dynamic: false }]]);
  });

  it('does not throw on an unclosed quote or paren', () => {
    for (const command of ['echo "abc', "echo 'abc", 'echo $(abc', '(abc', 'echo `abc', 'echo \\']) {
      expect(() => simpleCommands(command), command).not.toThrow();
    }
  });
});

describe('slotOrg', () => {
  it('maps a slot to its build org', () => {
    expect(slotOrg(config, 'w1')).toEqual({ alias: 'acme-dev1', orgId: '00D000000000001AAA' });
    expect(slotOrg(config, 'w2')?.alias).toBe('acme-dev2');
  });

  it('gives null without a build org', () => {
    expect(slotOrg(config, 'w3')).toBeNull();
    expect(slotOrg(config, 'x1')).toBeNull();
    expect(slotOrg(scratch, 'w1')).toBeNull();
    expect(slotOrg({ pack: 'salesforce' }, 'w1')).toBeNull();
  });
});

describe('targets', () => {
  it('allows no target, or the slot org by alias or org ID', () => {
    for (const command of [
      'sf org list',
      'sf project deploy start --dry-run',
      'sf project deploy start -o acme-dev1',
      'sf project deploy start --target-org=acme-dev1',
      'sf project deploy start --target-org "acme-dev1"',
      'sf project deploy start -o 00D000000000001AAA',
      'sfdx force:source:deploy -u acme-dev1',
    ]) {
      allowed(command);
    }
    allowed('sf project deploy start -o acme-dev2', { slot: 'w2' });
  });

  it('denies another slot org in every form', () => {
    for (const command of [
      'sf project deploy start -o acme-dev2',
      'sf project deploy start -oacme-dev2',
      'sf project deploy start -o=acme-dev2',
      'sf project deploy start --targetusername=acme-dev2',
      'sf project deploy start -u acme-dev2',
    ]) {
      denied(command, /acme-dev2/);
      denied(command, TARGET);
    }
  });

  it('denies a target at a slot with no pool entry', () => {
    denied('sf project deploy start -o acme-dev1', TARGET, { slot: 'w3' });
  });

  it('denies a dynamic or missing target', () => {
    denied('sf project deploy start -o "$ORG"', TARGET);
    denied('sf project deploy start -o', TARGET);
  });

  it('allows -c outside deploy start', () => {
    allowed('sf apex run test -c');
  });
});

describe('the test org (QA here) only for dry-run validation in the test stage', () => {
  const qa = [
    'sf project deploy start --dry-run -o acme-qa',
    "sf project:deploy:start --dry-run --target-org='acme-qa'",
    'sf deploy metadata --dry-run -o acme-qa',
  ];

  it('allows QA for a dry run in the test stage', () => {
    for (const command of qa) allowed(command, { stage: 'test' });
  });

  it('denies the same command in any other stage', () => {
    for (const stage of ['build', 'review', 'architect', null]) {
      for (const command of qa) denied(command, TARGET, { stage });
    }
  });

  it('denies QA without --dry-run, or for validate, in the test stage', () => {
    denied('sf project deploy start -o acme-qa', TARGET, { stage: 'test' });
    denied('sf project deploy validate -o acme-qa', TARGET, { stage: 'test' });
  });

  it('denies UAT in every stage', () => {
    for (const stage of ['build', 'test', 'review', 'architect', null]) {
      denied('sf project deploy start --dry-run -o acme-uat', TARGET, { stage });
    }
  });

  it('denies QA in the test stage when test is left at "build"', () => {
    for (const command of qa) denied(command, TARGET, { stage: 'test', cfg: testOnBuild });
    allowed('sf project deploy start --dry-run -o acme-dev1', { stage: 'test', cfg: testOnBuild });
  });

  it('allows the test org by its org ID', () => {
    allowed('sf project deploy start --dry-run -o 00D0000000000QAAAA', { stage: 'test' });
  });
});

describe('the three layouts', () => {
  const DEV1 = { orgId: '00D000000000001AAA' };
  const DEV2 = { orgId: '00D000000000002AAA' };
  const QA = { orgId: '00D0000000000QAAAA' };
  const UAT = { orgId: '00D000000000UATAAA' };
  const STAGES = ['build', 'test', 'review', 'architect', null];
  const DRY = (alias) => `sf project deploy start --dry-run -o ${alias}`;

  it('(a) one shared sandbox: it is the slot org, and nothing else is', () => {
    const cfg = {
      pack: 'salesforce',
      salesforce: { orgs: { 'acme-dev1': DEV1 }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] },
    };
    for (const stage of ['build', 'test']) allowed('sf project deploy start -o acme-dev1', { cfg, stage, slot: 'w1' });
    allowed(DRY('acme-dev1'), { cfg, stage: 'test', slot: 'w1' });
    denied('sf project deploy start -o acme-qa', TARGET, { cfg, slot: 'w1' });
    denied('sf project deploy start -o acme-dev1', TARGET, { cfg, slot: 'w2' });
  });

  it('(b) one build sandbox, test on QA: QA only for a dry run in the test stage, UAT never', () => {
    const cfg = {
      pack: 'salesforce',
      salesforce: {
        productionBranch: 'main',
        orgs: { 'acme-dev1': DEV1, 'acme-qa': QA, 'acme-uat': UAT },
        build: ['acme-dev1'],
        test: 'qa',
        stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
      },
    };
    allowed('sf project deploy start -o acme-dev1', { cfg, slot: 'w1' });
    allowed(DRY('acme-qa'), { cfg, stage: 'test' });
    for (const stage of ['build', 'review', 'architect', null]) denied(DRY('acme-qa'), TARGET, { cfg, stage });
    denied('sf project deploy start -o acme-qa', TARGET, { cfg, stage: 'test' });
    for (const stage of STAGES) {
      denied(DRY('acme-uat'), TARGET, { cfg, stage });
      denied('sf project deploy start -o acme-uat', TARGET, { cfg, stage });
    }
  });

  it('(c) two build sandboxes: each slot its own, QA only when test names it', () => {
    const cfg = {
      pack: 'salesforce',
      salesforce: {
        orgs: { 'acme-dev1': DEV1, 'acme-dev2': DEV2, 'acme-qa': QA },
        build: ['acme-dev1', 'acme-dev2'],
        stages: [{ name: 'qa', org: 'acme-qa' }],
      },
    };
    allowed('sf project deploy start -o acme-dev1', { cfg, slot: 'w1' });
    allowed('sf project deploy start -o acme-dev2', { cfg, slot: 'w2' });
    denied('sf project deploy start -o acme-dev2', TARGET, { cfg, slot: 'w1' });
    denied('sf project deploy start -o acme-dev1', TARGET, { cfg, slot: 'w2' });
    denied(DRY('acme-qa'), TARGET, { cfg, stage: 'test' });

    const onQa = { ...cfg, salesforce: { ...cfg.salesforce, test: 'qa' } };
    allowed(DRY('acme-qa'), { cfg: onQa, stage: 'test' });
    for (const stage of ['build', 'review', 'architect', null]) denied(DRY('acme-qa'), TARGET, { cfg: onQa, stage });
  });
});

describe('forbidden commands and flags', () => {
  it('denies login and logout', () => {
    for (const command of [
      'sf org login web',
      'sf org login jwt --username a',
      'sf org logout --all',
      'sf org:login:web',
      'sfdx force:auth:web:login',
      'sfdx auth:jwt:grant',
    ]) {
      denied(command, LOGIN);
    }
    allowed('sf org list auth');
  });

  it('denies quick deploys', () => {
    for (const command of ['sf project deploy quick --job-id 0Af', 'sf project:deploy:quick', 'sf deploy metadata quick']) denied(command, QUICK);
  });

  it('denies ignoring conflicts or errors', () => {
    for (const command of [
      'sf project deploy start --ignore-conflicts',
      'sf project deploy start --ignore-errors',
      'sf project deploy start --ignore-errors=true',
      'sf project deploy start -c',
      'sf project deploy start -r',
      'sf project retrieve start --ignore-conflicts',
    ]) {
      denied(command, IGNORE);
    }
  });

  it('denies a dev hub in sandbox-pool mode', () => {
    for (const command of [
      'sf org create scratch --target-dev-hub acme-hub',
      'sf org create scratch -v acme-hub',
      'sf org create scratch --target-hub-org=acme-hub',
    ]) {
      denied(command, DEVHUB);
    }
  });

  it('allows only the configured dev hub in scratch mode', () => {
    allowed('sf org create scratch --target-dev-hub acme-hub', { cfg: scratch });
    allowed('sf org create scratch --target-dev-hub 00D0000000000HUBAA', { cfg: scratch });
    denied('sf org create scratch --target-dev-hub acme-other', DEVHUB, { cfg: scratch });
    denied('sf org create scratch --target-dev-hub acme-qa', DEVHUB, { cfg: scratch });
    expect(g('sf org create scratch -v acme-other', { cfg: scratch })).toContain('salesforce.build.scratch.devHub');
  });

  it('denies changing the default org or aliases', () => {
    for (const command of [
      'sf config set target-org acme-qa',
      'sf config set target-org=acme-qa',
      'sf config unset target-org',
      'sfdx force:config:set defaultusername=x',
      'sf alias set acme-dev1=boss@acme.test',
      'sf project deploy start --flags-dir ./f',
      'SF_TARGET_ORG=acme-qa sf project deploy start',
    ]) {
      denied(command, DEFAULTS);
    }
  });

  it('denies sf agent test run-eval, which loops on its sign-in until the org locks out logins', () => {
    for (const command of ['sf agent test run-eval --spec x.json', 'sf agent:test:run-eval --spec x', 'sfdx agent test run-eval']) denied(command, /run-eval/);
    denied('sf agent test run-eval -o acme-dev1', /run-eval/, { stage: 'test' });
    expect(g('sf agent test run-eval --spec x.json')).toMatch(/sf agent preview/);
    allowed('sf agent test run --api-name X');
    allowed('sf agent preview start');
  });

  it('allows reading config and aliases', () => {
    for (const command of ['sf config get target-org', 'sf config list', 'sf alias list']) allowed(command);
  });

  const STAGES = ['architect', 'build', 'test', 'review', null];

  it('denies retrieves in every stage', () => {
    for (const stage of STAGES) {
      for (const command of [
        'sf project retrieve start',
        'sf project retrieve start --metadata ApexClass',
        'sf project retrieve preview',
        'sf project:retrieve:start',
        'sf retrieve metadata',
        'sfdx force:source:retrieve -m ApexClass',
        'sfdx force:source:pull',
        'sfdx force:mdapi:retrieve -r out',
        'sf project retrieve start -o acme-dev1',
      ]) {
        denied(command, RETRIEVE, { stage });
      }
    }
  });

  it('denies sf data writes in every stage', () => {
    for (const stage of STAGES) {
      for (const command of [
        'sf data create record --sobject Account --values "Name=Acme"',
        'sf data update record --sobject Account --record-id 001 --values "Name=X"',
        'sf data delete record --sobject Account --record-id 001',
        'sf data delete bulk --sobject Account --file a.csv',
        'sf data upsert bulk --sobject Account --file a.csv --external-id Id',
        'sf data import tree --plan p.json',
        'sf data import bulk --sobject Account --file a.csv',
        'sf data update bulk --sobject Account --file a.csv',
        'sf data create file --file x.pdf',
        'sf data:create:record --sobject Account',
        'sfdx force:data:record:create -s Account -v Name=X',
        'sfdx force:data:tree:import -p p.json',
        'sfdx force:data:bulk:upsert -s Account -f a.csv -i Id',
      ]) {
        denied(command, DATA_WRITE, { stage });
      }
    }
    denied('sf data create record --sobject Account', DATA_WRITE, { stage: 'architect' });
  });

  it('allows sf data reads and other project commands', () => {
    for (const command of [
      'sf data query --query "SELECT Id FROM Account" --json',
      `sf data query --query "SELECT Id FROM Account WHERE Name = 'delete'" --json`,
      'sf data get record --sobject Account --record-id 001',
      'sf data search --query "FIND {Acme}"',
      'sf data export tree --query "SELECT Id FROM Account"',
      'sf sobject describe --sobject Account --json',
      'sf project deploy start',
    ]) {
      allowed(command);
    }
    allowed('sf project deploy start --dry-run -o acme-qa', { stage: 'test' });
  });

  it('keeps the earlier reasons first', () => {
    expect(g('sf project retrieve start --ignore-conflicts')).toMatch(IGNORE);
    expect(g('sf project retrieve start -o acme-qa')).toMatch(RETRIEVE);
  });

  // sf's oclif config has flexibleTaxonomy: it runs `sf create data record` as `sf data create record`.
  it('matches the command words in any order, as sf does', () => {
    for (const stage of STAGES) {
      for (const command of ['sf start retrieve project', 'sf start project retrieve', 'sf retrieve project start --metadata ApexClass', 'sf pull source']) {
        denied(command, RETRIEVE, { stage });
      }
      for (const command of [
        'sf create data record --sobject Account --values Name=X',
        'sf record create data --sobject Account',
        'sf delete data record --sobject Account --record-id 001',
        'sf import data tree --plan p.json',
        'sf bulk upsert data --sobject Account --file a.csv',
      ]) {
        denied(command, DATA_WRITE, { stage });
      }
    }
    for (const command of ['sf login org web', 'sf web login org', 'sf logout org --all', 'sf login']) denied(command, LOGIN);
    for (const command of ['sf test run-eval agent --spec x.json', 'sf run-eval agent test']) denied(command, /run-eval/);
    for (const command of ['sf set config target-org acme-qa', 'sf unset config target-org', 'sf set alias acme-dev1=boss@acme.test']) denied(command, DEFAULTS);
    denied('sf start deploy project -c', IGNORE);
    allowed('sf start deploy project --dry-run -o acme-qa', { stage: 'test' });
    for (const command of [
      'sf query data --query "SELECT Id FROM Account" --json',
      'sf record get data --sobject Account --record-id 001',
      'sf tree export data --query "SELECT Id FROM Account"',
      'sf start deploy project',
      'sf list auth org',
      'sf get config target-org',
      'sf list alias',
      'sf run test agent --api-name X',
    ]) {
      allowed(command);
    }
  });

  it('denies retrieves and data writes in chains and wrappers', () => {
    denied('npm test && sf data create record --sobject Account', DATA_WRITE);
    denied('bash -c "sf project retrieve start"', RETRIEVE);
    denied('env sf data import tree -p p.json', DATA_WRITE);
  });

  it('reads the command words after leading flags, for every check', () => {
    for (const command of [
      'sf --json agent test run-eval',
      'sfdx --json agent test run-eval',
      'npx sf --json agent test run-eval',
      'cd x && sf --json agent test run-eval',
      'sf  --json  agent test run-eval',
      'sf --json --dev-debug agent:test:run-eval',
      'sf -h agent test run-eval',
    ]) {
      denied(command, /run-eval/);
    }
    denied('sf --json org login web', LOGIN);
    denied('sf --json org logout --all', LOGIN);
    denied('sf --json project deploy quick --job-id 0Af', QUICK);
    denied('sf --json data create record --sobject Account', DATA_WRITE);
    denied('sf --json project retrieve start', RETRIEVE);
    denied('sf --json config set target-org=acme-qa', DEFAULTS);
    denied('sf --json alias set acme-dev1=boss@acme.test', DEFAULTS);
    for (const command of ['sf --json data query --query "SELECT Id FROM Account"', 'sf --version', 'sf --json org list', 'sf --json agent test run --api-name X']) {
      allowed(command);
    }
  });
});

describe('quotes', () => {
  it('sees through quotes', () => {
    denied('sf "org" "login" web', LOGIN);
    denied("'sf' org logout", LOGIN);
    denied("sf org log'in' web", LOGIN);
    denied('sf project deploy start "--ignore-conflicts"', IGNORE);
    denied('sf project deploy start --target-org="acme-dev2"', /acme-dev2/);
    denied("sf project deploy start -o 'acme-uat'", /acme-uat/);
  });

  it('allows sf words inside quoted arguments of other programs', () => {
    allowed('git commit -m "sf org login web"');
    allowed("grep -r 'deploy quick' .");
  });
});

describe('chains', () => {
  it('checks every command in a chain', () => {
    denied('npm test && sf org login web', LOGIN);
    denied('npm test; sf org logout', LOGIN);
    denied('false || sf project deploy quick', QUICK);
    denied('cat x | sf org login web', LOGIN);
    denied('npm test & sf org logout', LOGIN);
    denied('npm test\nsf org logout', LOGIN);
    denied('npm test 2>&1 && sf project deploy start -o acme-uat', /acme-uat/);
  });

  it('allows a chain of allowed commands', () => {
    allowed('npm test 2>&1 | tee out.txt && sf org list');
  });
});

describe('subshells and wrappers', () => {
  it('checks commands inside subshells and wrappers', () => {
    denied('(sf org login web)', LOGIN);
    denied('echo $(sf org login web)', LOGIN);
    denied('echo `sf org logout`', LOGIN);
    denied('echo "$(sf project deploy quick)"', QUICK);
    denied('bash -c "sf org login web"', LOGIN);
    denied("sh -lc 'sf org logout'", LOGIN);
    denied('env FOO=1 sf org login web', LOGIN);
    denied('FOO=1 sf org login web', LOGIN);
    denied('command sf org logout', LOGIN);
    denied('npx sf org login web', LOGIN);
    denied('{ sf org login web; }', LOGIN);
    denied('if true; then sf org logout; fi', LOGIN);
    denied('time sf project deploy quick', QUICK);
  });
});

describe('dynamic programs', () => {
  it('denies a dynamic program when the command names sf or sfdx', () => {
    for (const command of ['S=sf; $S org login web', 'eval "sf org logout"', '`which sf` org list', '$(echo sf) org logout']) {
      denied(command, DYNAMIC);
    }
  });

  it('allows a dynamic program, and test brackets, when the command names no sf', () => {
    for (const command of [
      '$EDITOR notes.md',
      '"$CMD" --version',
      'eval echo hi',
      '$X org login web',
      'for f in *.sh; do "$f"; done',
      '[ -f x ] && echo ok',
      '[[ -n $X ]]',
      'test -n "$X"',
      'cat $(ls)',
      'npm test',
      'node -e "1"',
    ]) {
      allowed(command);
    }
  });

  it('denies a dynamic sf command word', () => {
    denied('sf $SUB login web', DYNAMIC);
  });

  it('denies sf split by an empty or run-time substitution', () => {
    for (const command of [
      's$()f org login web',
      's``f org login web',
      's$( )f org logout',
      's"$()"f org login web',
      's$($())f org login web',
      's`$()`f org login web',
      's$(true)f org login web',
      '$X s$()f org login web',
      "eval 's\"\"f org login web'",
      '$X s`$()`f org login web',
    ]) {
      denied(command, DYNAMIC);
    }
  });

  it('denies sf split by an empty expansion or built by a $-quote', () => {
    for (const command of [
      's${Y}f org login web',
      '$X s${Y}f org login web',
      's$""f org login web',
      "s$''f org login web",
      "s$'\\x66' org login web",
      's$"f" org login web',
      's$Y"f" org login web',
      's$1f org login web',
      "$'\\x73\\x66' org login web",
      "$'\\163\\146' org login web",
      "$'\\u0073\\u0066' org login web",
      // a quoted string ending in $ is not a $'...' string, so the escape after it still joins
      "$X 'a$' s\\f org login web",
    ]) {
      denied(command, DYNAMIC);
    }
  });

  it('reads a variable name as bash does and allows expansions that join no sf', () => {
    allowed('$X s$Yf org login web');
    allowed("$EDITOR $'a\\tb'");
    allowed('"$CMD" ${HOME}/x');
    allowed("$X $'\\U110000' x");
  });

  it('allows an empty substitution that joins no sf', () => {
    allowed('$X $() f');
  });
});

describe('redirections', () => {
  it('sees sf commands around redirections', () => {
    for (const command of [
      '2>/dev/null sf org login web',
      '>out sf org login web',
      'sf>out org login web',
      'sf 2>/dev/null org login web',
      'sf org login web 2>&1',
      'echo x > $(sf org login web)',
      'cat <(sf org logout)',
    ]) {
      denied(command, LOGIN);
    }
    denied('sf 2>/dev/null project deploy quick', QUICK);
    denied('sf >x config set target-org acme-qa', DEFAULTS);
    denied('sf project deploy start -o acme-uat>out', TARGET);
  });

  it('allows allowed commands with redirections', () => {
    for (const command of [
      'npm test 2>&1 | tee out.txt && sf org list',
      'sf org list > orgs.json',
      'sf project deploy start -o acme-dev1 2>&1',
      'npm test &> log.txt',
    ]) {
      allowed(command);
    }
  });
});

describe('dynamic -c scripts', () => {
  it('denies a dynamic script when the command names sf', () => {
    for (const command of ['zsh -c "$(echo sf org logout)"', 'bash -c "$(echo sf org login web)"', 'sh -c "`echo sf org logout`"']) {
      denied(command, DYNAMIC);
    }
  });

  it('allows a dynamic script that names no sf', () => {
    allowed('bash -c "$(echo hi)"');
  });

  it('still checks a literal script', () => {
    denied('bash -c "sf org login web"', LOGIN);
    denied('bash -c "sf project deploy start -o $ORG"');
  });
});

describe('never throws', () => {
  it('denies deep nesting around sf without throwing', () => {
    const command = '$('.repeat(20000) + 'sf org list' + ')'.repeat(20000);
    expect(() => g(command)).not.toThrow();
    expect(g(command)).toMatch(DYNAMIC);
  });

  it('allows deep nesting with no sf', () => {
    const command = '('.repeat(5000) + 'echo hi' + ')'.repeat(5000);
    expect(() => g(command)).not.toThrow();
    expect(g(command)).toBeNull();
  });

  it('scans exactly under the cap', () => {
    denied('$('.repeat(150) + 'sf org login web' + ')'.repeat(150), LOGIN);
  });

  it('denies sf split by quotes or a backslash past the cap', () => {
    denied('$('.repeat(201) + "s''f org login web" + ')'.repeat(201), DYNAMIC);
    denied('('.repeat(202) + "s''f org login web" + ')'.repeat(202), DYNAMIC);
    denied('$('.repeat(201) + 's\\f org login web' + ')'.repeat(201), DYNAMIC);
  });

  it('denies sf split by backslash-newline or an empty substitution past the cap', () => {
    denied('$('.repeat(201) + 's\\\nf org login web' + ')'.repeat(201), DYNAMIC);
    denied('$('.repeat(201) + '"s\\\nf" org login web' + ')'.repeat(201), DYNAMIC);
    denied('$('.repeat(201) + 's$()f org login web' + ')'.repeat(201), DYNAMIC);
    denied('$('.repeat(201) + 's``f org login web' + ')'.repeat(201), DYNAMIC);
    denied('$('.repeat(201) + 's`$()`f org login web' + ')'.repeat(201), DYNAMIC);
    denied('$('.repeat(201) + 's${Y}f org login web' + ')'.repeat(201), DYNAMIC);
  });

  it('sees sf split by backslash-newline under the cap', () => {
    denied('s\\\nf org login web', LOGIN);
    denied('"s\\\nf" org login web', LOGIN);
  });

  it('allows nesting past the cap with no sf', () => {
    allowed('$('.repeat(201) + 'echo hi' + ')'.repeat(201));
    allowed('$('.repeat(201) + ')'.repeat(201));
  });

  it('checks deep empty nesting in linear time without throwing', () => {
    const command = '$('.repeat(20000) + ')'.repeat(20000);
    expect(() => g(command)).not.toThrow();
    expect(g(command)).toBeNull();
    expect(g('$('.repeat(20000) + 'sf org list' + ')'.repeat(20000))).toMatch(DYNAMIC);
  });

  // The old quadratic code took about 1.2 s on the 400k + 120k input on an idle machine. The
  // bound stretches with the load past one runnable process per core, as the slow-test guard's
  // does, so a busy shared machine is not read as a quadratic scan.
  const LINEAR_MS = stretchByLoad(1000);

  it('skips unclosed ${ in linear time', () => {
    const command = '$X ' + '${'.repeat(100000);
    const start = performance.now();
    expect(g(command)).toBeNull();
    expect(performance.now() - start).toBeLessThan(LINEAR_MS);
  });

  it('drops many empty substitutions after a long prefix in linear time', () => {
    const command = '$X ' + 'x'.repeat(400000) + '$()'.repeat(120000);
    const start = performance.now();
    expect(g(command)).toBeNull();
    expect(performance.now() - start).toBeLessThan(LINEAR_MS);
    denied('$X s' + '$()'.repeat(60000) + 'f org login web', DYNAMIC);
  });

  it('fails closed when the check throws', () => {
    const input = { command: 'sf org list', stage: 'build', slot: 'w1', config: { get salesforce() { throw new Error('boom'); } } };
    expect(() => guard(input)).not.toThrow();
    expect(guard(input)).toMatch(DYNAMIC);
  });
});

describe('launchers, reserved words, braces and case', () => {
  it('sees sf behind more launchers and in any case', () => {
    for (const command of [
      'timeout 60 sf org login web',
      'timeout --preserve-status 60 sf org login web',
      'nice sf org login web',
      'nice -10 sf org logout',
      'coproc sf org login web',
      'coproc NAME { sf org login web; }',
      'SF org login web',
      'Sfdx force:auth:web:login',
      '/usr/local/bin/SF org logout',
      'NICE sf org login web',
    ]) {
      denied(command, LOGIN);
    }
  });

  it('denies brace expansion in the program or sf command words', () => {
    for (const command of ['{sf,org,login,web}', 'sf org {login,list} web', 'S=SF; $S org login web', '{a,"b"} x', '"s"{f,x} org login web']) {
      denied(command, DYNAMIC);
    }
  });

  it('allows quoted or escaped braces in the program word', () => {
    for (const command of ['"{a,b}" x', "'{a,b}' x", '\\{a,b} x', '{a","b} x', 'sf org "{login,list}" web']) allowed(command);
  });

  it('allows other programs behind launchers, and braces in arguments', () => {
    for (const command of ['timeout 60 npm test', 'nice -10 npm test', 'echo {a,b}', 'SF_DIR=x npm test']) allowed(command);
  });
});

describe('the isolated sf home', () => {
  const ISOLATION = /step around Foreman's isolated sf home/;

  it('denies sf by path, and the variables that move its home or skip the wrapper', () => {
    for (const command of [
      '/usr/local/bin/sf org list',
      './node_modules/.bin/sf org list',
      '"/opt/homebrew/bin/sf" org list',
      '/usr/local/bin/sfdx force:org:list',
      '/usr/local/bin/sf apex run test -o acme-dev1',
      'FOREMAN_SF_HOME=/home/acme sf org list -o acme-dev1',
      'HOME=/home/acme sf org list',
      'SF_DATA_DIR=/x sfdx force:org:list',
      'PATH=/usr/local/bin:$PATH sf org list',
      'env FOREMAN_SF_HOME=/home/acme sf org list',
      '/usr/bin/env FOREMAN_SF_HOME=/home/acme sf org list',
      'export FOREMAN_SF_HOME=/home/acme',
      'FOREMAN_SF_HOME=/home/acme',
      'export FOREMAN_SF_HOME=$HOME; sf org list',
      'export HOME=/home/acme; sf org list',
      'declare -x SF_DATA_DIR=/x && sf plugins',
      'bash -c "FOREMAN_SF_HOME=/home/acme sf org list"',
      'export PATH=/opt/homebrew/bin:$PATH && sf org list',
      'PATH=/x:$PATH; sf org list',
    ]) {
      denied(command, ISOLATION);
    }
  });

  it('allows sf by name, other variables, and these variables for other programs', () => {
    for (const command of [
      'sf org list',
      'SF_DISABLE_TELEMETRY=true sf org list',
      'HOME=/tmp npm test',
      'export HOME=/tmp && npm test',
      'PATH=/x:$PATH npm test',
      'export SF_DATA_DIR=/x; npm test',
      'export PATH=/x:$PATH && npm test',
      'PATH=/x:$PATH; npm test',
    ]) {
      allowed(command);
    }
  });

  it('sees sf behind a launcher given by path, and keeps the earlier reasons first', () => {
    denied('/usr/bin/env sf org login web', LOGIN);
    denied('/usr/local/bin/SF org logout', LOGIN);
  });
});

describe('a production org marked "production": true', () => {
  const MAIN_ID = '00D0000000000MAINA';
  const withMain = {
    ...config,
    salesforce: { ...config.salesforce, orgs: { ...config.salesforce.orgs, 'acme-main': { orgId: MAIN_ID, production: true } } },
  };
  // Scratch mode on a production Dev Hub.
  const scratchMain = {
    ...scratch,
    salesforce: { ...scratch.salesforce, orgs: { ...scratch.salesforce.orgs, 'acme-hub': { orgId: '00D0000000000HUBAA', production: true } } },
  };
  const PROD_DEPLOY = /deploying to a production org: Foreman never deploys to production/;
  const EXPOSE = /prints or hands out the org's credentials, or calls its API directly/;
  const RAW_DEPLOY = /a raw call to a Salesforce deploy endpoint while a production org is connected/;
  const PROD_NOT_ALLOWED = /against a production org: it is not one Foreman allows against production/;
  const STAGES = ['build', 'test', 'review'];

  it('denies a command naming the key folder in every stage, before any production reason', () => {
    for (const stage of [...STAGES, null]) for (const command of KEY_COMMANDS) denied(command, KEY, { cfg: withMain, stage });
  });

  // Independent review, 2026-10-25.
  it('finds a production target hidden in combined one-letter flags', () => {
    denied('sf project deploy start -goacme-main', PROD_DEPLOY, { cfg: withMain });
    denied('sf org open -roacme-main', EXPOSE, { cfg: withMain });
  });

  it('denies package push-upgrade schedule outright while a production org is marked', () => {
    denied('sf package push-upgrade schedule -p 04t000000000000AAA -f orgs.txt', PROD_DEPLOY, { cfg: withMain });
    denied(`sf package push-upgrade schedule -p 04t000000000000AAA -l 00D000000000001AAA,${MAIN_ID}`, PROD_DEPLOY, { cfg: withMain });
  });

  it('denies every deployment to it, by alias or org ID, in every stage', () => {
    for (const stage of STAGES) {
      for (const target of ['acme-main', MAIN_ID]) {
        for (const command of [
          `sf project deploy start -o ${target}`,
          `sf project deploy validate -o ${target}`,
          `sf project deploy resume --job-id 0Af -o ${target}`,
          `sf project deploy start --pre-destructive-changes x.xml -o ${target}`,
          `sf project delete source -m ApexClass:X -o ${target}`,
          `sf project deploy start --dry-run --target-org ${target}`,
          `sfdx force:source:deploy -p force-app -u ${target}`,
          `sfdx force:mdapi:deploy -d out -u ${target}`,
          `sfdx force:source:delete -m ApexClass:X -u ${target}`,
          `sfdx force:source:push -u ${target}`,
          `sf deploy metadata -o ${target}`,
          `sf org delete sandbox --target-org ${target}`,
          `sf org refresh sandbox --name dev -o ${target}`,
          `sf package install --package 04t000000000001 -o ${target}`,
          `sf package uninstall --package 04t000000000001 -o ${target}`,
          `sfdx force:package:install -p 04t000000000001 -u ${target}`,
          `sf agent publish authoring-bundle --api-name X -o ${target}`,
          `sf agent create --spec x.yaml -o ${target}`,
          `sf agent activate --api-name X -o ${target}`,
          `sf agent deactivate --api-name X -o ${target}`,
          `sf community publish --name X -o ${target}`,
          `sf devops promote -t 1Fa000000000001 -o ${target}`,
          `sf devops promotion complete -a -t 1Fa000000000001 -o ${target}`,
          `sf devops promotion validate -t 1Fa000000000001 -o ${target}`,
        ]) {
          denied(command, PROD_DEPLOY, { stage, cfg: withMain });
        }
      }
    }
    denied('sf api request rest /services/data/v62.0/metadata/deployRequest --method POST -o acme-main', PROD_DEPLOY, { cfg: withMain });
    expect(g('sf project deploy start -o acme-main', { cfg: withMain })).toBe(
      `Foreman's Salesforce guard denies deploying to a production org: Foreman never deploys to production. Against production Foreman runs only: ${ALLOWED_SUMMARY}.`,
    );
  });

  it('denies a deployment to it after a leading flag', () => {
    denied('sf --json project deploy start -o acme-main', PROD_DEPLOY, { cfg: withMain });
  });

  it('denies deploy quick to it as a production deploy, and elsewhere as a quick deploy', () => {
    denied('sf project deploy quick --job-id 0Af -o acme-main', PROD_DEPLOY, { cfg: withMain });
    denied('sf project deploy quick --job-id 0Af', QUICK, { cfg: withMain });
  });

  it('allows the commands on the allow-list against it, in every stage', () => {
    for (const stage of STAGES) {
      for (const command of [
        'sf data query --query "SELECT Id FROM Account" -o acme-main',
        'sf data query --query "SELECT Id FROM GroupMember" --u acme-main',
        'sf sobject describe -s Account -o acme-main',
        'sf project retrieve start -m ApexClass:X -o acme-main',
        'sf project retrieve start -m ApexClass:X --u acme-main',
        `sf project retrieve start -m ApexClass:X --target-org ${MAIN_ID}`,
        'sf org list limits -o acme-main',
        'sf list org limits -o acme-main',
        'sf org list metadata --metadata-type ApexClass -o acme-main',
        'sf org list users -o acme-main',
        'sf org assign permset --name X -o acme-main',
        'sf org create user -o acme-main',
        'sf apex get log -o acme-main',
        'sf apex list log --u=acme-main',
      ]) {
        allowed(command, { stage, cfg: withMain });
      }
    }
  });

  it('denies every command off the allow-list that names it, in every spelling, in every stage', () => {
    for (const stage of STAGES) {
      for (const target of ['acme-main', MAIN_ID, MAIN_ID.slice(0, 15)]) {
        for (const spelled of [`-o ${target}`, `-o${target}`, `-o=${target}`, `--target-org=${target}`, `-u ${target}`, `--u ${target}`, `--u=${target}`, `--targetusername ${target}`, `--targetusername=${target}`, `-c ${target}`, `-v ${target}`, target]) {
          denied(`sf package install -p 04t000000000001 ${spelled}`, PROD_DEPLOY, { stage, cfg: withMain });
          denied(`sf org display ${spelled}`, EXPOSE, { stage, cfg: withMain });
          denied(`sf apex run -f x.apex ${spelled}`, PROD_NOT_ALLOWED, { stage, cfg: withMain });
        }
        for (const command of [
          `sf apex run -f x.apex -o ${target}`,
          `sfdx force:data:soql:query -q "SELECT Id FROM Account" -u ${target}`,
          `sf org create sandbox --name dev -o ${target}`,
          `sf project deploy report --job-id 0Af -o ${target}`,
          `sf package installed list -o ${target}`,
          `sf org login jwt -o ${target}`,
          `sf org create scratch -f x.json -o ${target}`,
        ]) {
          denied(command, PROD_NOT_ALLOWED, { stage, cfg: withMain });
        }
      }
    }
    expect(g('sf apex run -f x.apex -o acme-main', { cfg: withMain })).toBe(
      "Foreman's Salesforce guard denies this command against a production org: it is not one Foreman allows against production. Against production Foreman runs only: " +
        `${ALLOWED_SUMMARY}. Deployments to production are blocked.`,
    );
  });

  it('denies a DevOps Center pipeline deploy that names it, and any other DevOps Center org but the slot', () => {
    for (const stage of STAGES) {
      for (const step of ['start', 'validate', 'quick', 'resume']) {
        for (const spelled of ['-c acme-main', '--devops-center-username acme-main', '--devops-center-username=acme-main', `-c ${MAIN_ID}`]) {
          denied(`sf project deploy pipeline ${step} --branch-name main ${spelled}`, PROD_DEPLOY, { stage, cfg: withMain });
        }
        // pipeline quick is a quick deploy, denied as such before its target is read; pipeline
        // start counts as a deploy start, where -c is denied as on main
        const other = step === 'quick' ? QUICK : step === 'start' ? IGNORE : TARGET;
        denied(`sf project deploy pipeline ${step} -c "$X"`, other, { stage, cfg: withMain });
        denied(`sf project deploy pipeline ${step} -c acme-qa`, other, { stage, cfg: withMain });
        denied(`sf project deploy pipeline ${step} -c acme-qa`, other, { stage });
        // glued, -c is no exact -c word, so it is read as the DevOps Center target
        denied(`sf project deploy pipeline ${step} -cacme-qa`, step === 'quick' ? QUICK : TARGET, { stage, cfg: withMain });
      }
    }
    allowed('sf apex run test -n T -c', { cfg: withMain });
    allowed('sf apex run test -n T -c -o acme-dev1', { cfg: withMain });
  });

  it('denies a DevOps Center pipeline start with no production org marked, as on main', () => {
    for (const stage of STAGES) {
      for (const cfg of [config, testOnBuild]) {
        denied('sf project deploy pipeline start -c acme-dev1 -p P -b b', IGNORE, { stage, cfg });
        denied('sf project deploy pipeline start --devops-center-username acme-dev1 -p P -b b -r', IGNORE, { stage, cfg });
      }
    }
  });

  it('denies a record change through the Tooling API, or with --flags-dir, as a metadata change, in every stage', () => {
    const PROD_TOOLING = /a record change with --use-tooling-api[\s\S]*writes metadata/;
    for (const stage of STAGES) {
      for (const target of ['acme-main', MAIN_ID]) {
        for (const verb of ['create', 'update', 'delete']) {
          for (const tooling of ['-t', '--use-tooling-api', '--use-tooling-api=true', '--usetoolingapi', '--usetoolingapi=true', '--flags-dir d']) {
            denied(`sf data ${verb} record ${tooling} --sobject CustomField --record-id 00N000000000001 -o ${target}`, PROD_TOOLING, { stage, cfg: withMain });
          }
        }
      }
      // Off production these stay plain record changes.
      denied('sf data delete record -t --sobject CustomField --record-id 00N000000000001 -o acme-dev1', DATA_WRITE, { stage, cfg: withMain });
      denied('sf data delete record -t --sobject CustomField --record-id 00N000000000001 -o acme-main', DATA_WRITE, { stage });
    }
  });

  it('denies the commands that print its credentials or call its API directly, in every stage', () => {
    for (const stage of STAGES) {
      for (const target of ['acme-main', MAIN_ID]) {
        for (const command of [
          `sf org display -o ${target}`,
          `sf org display --verbose --json -o ${target}`,
          `sf org display user -o ${target}`,
          `sfdx force:org:display -u ${target}`,
          `sfdx force:user:display -u ${target}`,
          `sf org open --url-only -o ${target}`,
          `sf org open agent --api-name X -o ${target}`,
          `sf org generate password -o ${target}`,
          `sfdx force:user:password:generate -u ${target}`,
          `sf api request rest /services/data/v62.0/limits -o ${target}`,
          `sf api request graphql --body q.json -o ${target}`,
        ]) {
          denied(command, EXPOSE, { stage, cfg: withMain });
        }
      }
    }
    denied('sf org auth show-access-token -o acme-main', EXPOSE, { cfg: withMain });
    denied('sf org auth show-access-token -o acme-dev1', LOGIN, { cfg: withMain });
    allowed('sf org display', { cfg: withMain });
    allowed('sf org display -o acme-dev1', { cfg: withMain, slot: 'w1' });
    denied('sf org display -o acme-qa', TARGET, { cfg: withMain });
  });

  it('denies a raw call to a deploy endpoint while a production org is marked', () => {
    for (const command of [
      'curl -X POST https://acme.my.salesforce.com/services/data/v62.0/metadata/deployRequest',
      'curl https://acme.my.salesforce.com/services/Soap/m/62.0',
      'bash -c "curl -X POST https://acme.my.salesforce.com/services/data/v62.0/metadata/deployRequest"',
    ]) {
      denied(command, RAW_DEPLOY, { cfg: withMain });
      // Nothing is marked production in the shared config.
      allowed(command);
    }
  });

  it('denies setting the default-org variables in any form, so no deploy reaches it without -o', () => {
    for (const command of [
      'export SF_TARGET_ORG=acme-main; sf project deploy start',
      'export SF_TARGET_ORG=acme-main && sf project deploy start',
      'SF_TARGET_ORG=acme-main; sf project deploy start',
      'declare -x SF_TARGET_ORG=acme-main; sf project deploy start',
      'typeset -x SF_TARGET_ORG=acme-main; sf project deploy start',
      'export SFDX_DEFAULTUSERNAME=acme-main; sfdx force:source:deploy -p force-app',
      'export SF_TARGET_DEV_HUB=acme-main',
      'SFDX_DEFAULTDEVHUBUSERNAME=acme-main',
      'export SF_TARGET_ORG',
      'SF_TARGET_ORG=acme-main bash -c "sf project deploy start"',
      'env SF_TARGET_ORG=acme-main sh -c "sf project deploy start"',
      'SF_TARGET_ORG=acme-main npm run deploy',
    ]) {
      denied(command, DEFAULTS, { cfg: withMain });
    }
    allowed('unset SF_TARGET_ORG; sf org list', { cfg: withMain });
  });

  it('leaves the default-org variables alone outside sf when no production org is marked, as on main', () => {
    for (const command of [
      'export SF_TARGET_ORG=acme-dev1',
      'SF_TARGET_ORG=acme-dev1 npm test',
      'declare -x SFDX_DEFAULTUSERNAME=x',
      'SF_TARGET_DEV_HUB=acme-hub',
      'SF_TARGET_ORG=acme-dev1 bash -c "npm test"',
    ]) {
      allowed(command);
    }
    // in front of sf itself it stays denied, as on main
    denied('SF_TARGET_ORG=acme-dev1 sf org list', DEFAULTS);
  });

  it('allows scratch org create and delete on a production Dev Hub', () => {
    for (const devHub of ['--target-dev-hub acme-hub', '-v acme-hub', '--target-dev-hub=acme-hub', '-vacme-hub']) {
      allowed(`sf org create scratch ${devHub} -f config/project-scratch-def.json`, { cfg: scratchMain });
    }
    allowed('sf org delete scratch --target-dev-hub acme-hub --no-prompt', { cfg: scratchMain });
    denied('sf org delete scratch -o acme-hub --no-prompt', PROD_DEPLOY, { cfg: scratchMain });
    denied('sf org delete sandbox -o acme-hub', PROD_DEPLOY, { cfg: scratchMain });
    // Outside scratch mode a production org is no dev hub.
    denied('sf org create scratch -v acme-main -f config/project-scratch-def.json', DEVHUB, { cfg: withMain });
  });

  it('keeps every other deny', () => {
    for (const command of [
      'sf project retrieve start -m ApexClass:X',
      'sf project retrieve start -m ApexClass:X -o acme-dev1',
      'sf project retrieve start -m ApexClass:X -o acme-qa',
      'sf project retrieve start -m ApexClass:X -o acme-main -o acme-qa',
      'sf project retrieve start -m ApexClass:X -o "$ORG"',
    ]) {
      denied(command, RETRIEVE, { cfg: withMain });
    }
    denied('sf data create record --sobject Account --values "Name=X" -o acme-main', DATA_WRITE, { cfg: withMain });
    denied('sf data delete record --sobject Account --record-id 001 -o acme-main', DATA_WRITE, { cfg: withMain });
    denied('sf data query --query "SELECT Id FROM Account" -o acme-qa', TARGET, { cfg: withMain });
    denied('sf data query --query "SELECT Id FROM Account" -o acme-other', TARGET, { cfg: withMain });
    denied('sf project deploy start -o acme-qa', TARGET, { cfg: withMain, stage: 'test' });
    denied('sf org login jwt -o acme-dev1', LOGIN, { cfg: withMain });
    denied('sf org create scratch --target-dev-hub acme-main', DEVHUB, { cfg: withMain });
    // The org is not marked in the shared config, so it is just another target.
    denied('sf data query --query "SELECT Id FROM Account" -o acme-main', TARGET);
  });
});

describe('the key folder', () => {
  it('denies a command naming ~/.config/foreman/sf in the build, test and review stages and the foreman\'s', () => {
    for (const stage of ['build', 'test', 'review', null]) for (const command of KEY_COMMANDS) denied(command, KEY, { stage });
  });

  it('allows the isolated sf home and other names that only start alike', () => {
    for (const stage of ['build', 'test', 'review', null]) {
      for (const command of ['ls ~/.config/foreman/sf-home', 'cat ~/.config/foreman/sfdx.txt', 'ls ~/.config/foreman', 'npm test', 'sf org list']) allowed(command, { stage });
    }
  });

  it('denies the same through bashDecision with the real packs', () => {
    const command = KEY_COMMANDS[0];
    const decide = bashDecision({ command, agentType: 'foreman:builder', config, stages: stageMap(config), slot: 'w1', packs: PACKS });
    expect(decide).toMatch(KEY);
    expect(decide).toBe(g(command));
  });
});

describe('wiring', () => {
  it('is the pack guard', () => {
    expect(pack.guard).toBe(guard);
  });

  it('runs through bashDecision with the real packs', () => {
    const decide = (command) => bashDecision({ command, agentType: 'foreman:builder', config, stages: stageMap(config), slot: 'w1', packs: PACKS });
    const login = g('sf org login web');
    expect(login).toMatch(LOGIN);
    expect(decide('sf org login web')).toBe(login);
    const deleteRecord = 'sf data delete record --sobject Account --record-id 001';
    expect(g(deleteRecord)).toMatch(DATA_WRITE);
    expect(decide(deleteRecord)).toBe(g(deleteRecord));
    expect(g('sf project retrieve start')).toMatch(RETRIEVE);
    expect(decide('sf project retrieve start')).toBe(g('sf project retrieve start'));
    expect(decide('npm test')).toBeNull();
  });

  it('does not throw on a partial config or odd input', () => {
    expect(guard({ command: 'sf org list', stage: 'build', slot: 'w1', config: { pack: 'salesforce' } })).toBeNull();
    expect(() => guard({ command: 'sf project deploy start -o acme-dev1', stage: 'build', slot: 'w1', config: { pack: 'salesforce', salesforce: { orgs: { 'acme-dev1': null }, build: [null] } } })).not.toThrow();
    for (const command of [undefined, null, '', 42]) expect(guard({ command, stage: 'build', slot: 'w1', config })).toBeNull();
    expect(guard(null)).toBeNull();
  });
});
