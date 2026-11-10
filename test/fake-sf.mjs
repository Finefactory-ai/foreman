// Fake Salesforce CLI output for tests, in the shapes `sf ... --json` prints (seen with sf 2.150.6),
// and a fake shell that answers `sf` from a table of routes.
//
//   sfOk(result)                  a success envelope: { status: 0, result, warnings: [] }
//   sfError(name, message, code)  an error with no `status` field, as sf prints it, with the
//                                 `actions` and `stack` a caller must never show
//   sfRaw(value)                  raw JSON with no envelope (`sf plugins --core`, `sf version`)
//   sfCall(cmd, args)             a call as sf sees it: runSf runs sf through its watcher
//                                 (`node sf-watch.mjs <limitMs> sf <args...>`), and this gives
//                                 { cmd: 'sf', args, limitMs } for that, or { cmd, args } as they are
//   fakeSfShell(routes, fallback) an sh(cmd, args, opts) for the doctor. For `sf`, the first
//                                 route whose key is a substring of args.join(' ') answers; a
//                                 route may be a function of (args, opts). Other commands go to
//                                 fallback. sh.calls records { cmd, args, opts } for each call,
//                                 with a watched sf call read through sfCall.
//   orgList(entries)              the answer to `sf org list --all --skip-connection-status`,
//                                 with each entry listed as a sandbox and a non-scratch org
//   acmeOrg(alias, orgId)         one org list entry, with a made-up Acme username
//   acmeSfRoutes(over)            a healthy Acme set: the tools, the acme-dev1 and acme-qa
//                                 sandboxes, an isolated sf home holding just those two, source
//                                 tracking on, telemetry off, and Agentforce with a Data Cloud
//                                 licence in every org. Routes in `over` come first, so they win.
//                                 The home holds only acme-dev1 and acme-qa: acme-uat has a
//                                 query route but is not signed in, because the shared Acme
//                                 config has no uat, and a uat entry would count as a stray.

import { SF_WATCH } from '../plugin/packs/salesforce/sf.mjs';

export const ACME_DEV1_ID = '00D000000000001AAA';
export const ACME_QA_ID = '00D000000000002AAA';
export const ACME_UAT_ID = '00D000000000003AAA';
// The Acme production org, alias acme-main, marked "production": true where a test lists it.
export const ACME_PROD_ID = '00D000000000004AAA';

export const sfOk = (result) => ({ status: 0, stdout: JSON.stringify({ status: 0, result, warnings: [] }), stderr: '' });

export const sfError = (name, message, exitCode = 1) => ({
  status: exitCode,
  stdout: JSON.stringify({ name, message, exitCode, actions: ['Did you mean "Other-Org"?'], stack: 'x' }),
  stderr: ' ›   Warning: update available',
});

export const sfRaw = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });

const NO_ROUTE = (args) => ({ status: 1, stdout: '', stderr: `no fake route for sf ${args.join(' ')}` });
const QUIET = () => ({ status: 0, stdout: '', stderr: '' });

export function sfCall(cmd, args = []) {
  if (cmd === process.execPath && args[0] === SF_WATCH) return { cmd: args[2], args: args.slice(3), limitMs: Number(args[1]) };
  return { cmd, args };
}

export function fakeSfShell(routes = {}, fallback = QUIET) {
  const calls = [];
  const sh = (rawCmd, rawArgs = [], opts = {}) => {
    const { cmd, args } = sfCall(rawCmd, rawArgs);
    calls.push({ cmd, args: [...args], opts });
    if (cmd !== 'sf') return fallback(cmd, args, opts);
    const line = args.join(' ');
    const key = Object.keys(routes).find((k) => line.includes(k));
    if (key === undefined) return NO_ROUTE(args);
    const route = routes[key];
    return typeof route === 'function' ? route(args, opts) : route;
  };
  sh.calls = calls;
  // The `sf` calls, each as its args joined by spaces.
  sh.sfLines = () => calls.filter((c) => c.cmd === 'sf').map((c) => c.args.join(' '));
  return sh;
}

// `sf plugins --core` with each named plugin at its version; null leaves one out.
export function acmePlugins(versions = {}) {
  const all = {
    '@salesforce/cli': '2.150.6',
    'sfdx-git-delta': '6.20.0',
    '@salesforce/plugin-code-analyzer': '5.13.0',
    '@salesforce/plugin-agent': '2.0.5',
    ...versions,
  };
  return Object.entries(all)
    .filter(([, version]) => version !== null)
    .map(([name, version]) => ({ name, version, type: name === '@salesforce/cli' ? 'core' : 'user' }));
}

// The answer to `sf data query` for SELECT Id, IsSandbox FROM Organization.
export const orgRecord = (id, isSandbox = true) =>
  sfOk({ records: [{ attributes: { type: 'Organization', url: `/services/data/v62.0/sobjects/Organization/${id}` }, Id: id, IsSandbox: isSandbox }], totalSize: 1, done: true });

export const orgRoute = (alias) => `FROM Organization --target-org ${alias}`;
export const TRACKING = 'FROM SourceMember';
export const TELEMETRY = 'config get disable-telemetry';
export const PLUGINS = 'plugins --core';
export const ORG_LIST = 'org list';
export const AGENTFORCE = 'FROM GenAiPlannerDefinition LIMIT 1';
export const DATA_CLOUD = 'FROM PermissionSetLicense';

export const acmeOrg = (alias, orgId) => ({ alias, username: `admin@${alias}.acme.example`, orgId, isSandbox: true, instanceUrl: `https://${alias}.sandbox.my.salesforce.com` });

export const orgList = (entries = []) => sfOk({ other: [], sandboxes: entries, nonScratchOrgs: entries, devHubs: [], scratchOrgs: [] });

export function acmeSfRoutes(over = {}) {
  const base = {
    [PLUGINS]: sfRaw(acmePlugins()),
    [ORG_LIST]: orgList([acmeOrg('acme-dev1', ACME_DEV1_ID), acmeOrg('acme-qa', ACME_QA_ID)]),
    [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID),
    [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID),
    [orgRoute('acme-uat')]: orgRecord(ACME_UAT_ID),
    [TRACKING]: sfOk({ records: [], totalSize: 0, done: true }),
    [TELEMETRY]: sfOk([{ name: 'disable-telemetry', key: 'disable-telemetry', value: 'true', location: 'Global', success: true }]),
    [AGENTFORCE]: sfOk({ records: [{ attributes: { type: 'GenAiPlannerDefinition' }, Id: '16j000000000001AAA' }], totalSize: 1, done: true }),
    [DATA_CLOUD]: sfOk({ records: [{ attributes: { type: 'PermissionSetLicense' }, DeveloperName: 'GenieDataPlatformStarterPsl' }], totalSize: 1, done: true }),
  };
  const routes = { ...over };
  for (const [key, value] of Object.entries(base)) if (!Object.hasOwn(routes, key)) routes[key] = value;
  return routes;
}
