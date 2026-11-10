// Ship step `sf-org-guard`, the first step of every Salesforce release: production is never a
// target. It refuses, in order:
//
//   1. a pull request into salesforce.productionBranch, through ship.pr.into or baseBranch (as
//      the pr step picks its target) or through the first stage's branch. No sf call runs
//      before this check.
//   2. an isolated sf home that is not an absolute path
//   3. a salesforce block with no orgs
//   4. any org in salesforce.orgs that cannot be read, is another org than its configured org
//      ID, or has no org ID; a deploy target (a build org or a stage's org) or an unmarked org
//      that is not a sandbox; and an org marked "production": true whose server says it is a
//      sandbox. A marked org that is not a deploy target may be production: any command that does
//      not deploy may target it, and it may be the scratch dev hub. A deploy target marked
//      production is still refused by its server's answer, so deployments to production are
//      blocked. Each org is queried once, in key order, on the server: the answer is the org's
//      own IsSandbox and Id, never a local cache.
//
// Any refusal is code 8 and, through `halts`, writes HALT: a release line that could reach
// production stays frozen until the owner fixes the config or the sf home. A reason names
// only aliases, org IDs and branches, plus sf's own error message; never a username.

import os from 'node:os';
import { layout } from '../config.mjs';
import { homeProblem, isolatedSh, orgQuery, sfHome } from '../isolation.mjs';

const STAGE = 'sf-org-guard';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const refuse = (reason) => ({ ok: false, code: 8, stage: STAGE, reason });

// The branch pull requests merge into, the same rule as the pr step's prTarget.
const prTarget = (config) => config.ship?.pr?.into ?? config.baseBranch;

export default {
  name: 'sf-org-guard',
  label: 'checking every Salesforce org is an allow-listed sandbox',
  needs: ['sf'],
  halts: true,

  run(ctx) {
    const l = layout(ctx.config.salesforce, ctx.config);
    const production = l.productionBranch;
    if (production) {
      for (const target of [prTarget(ctx.config), l.prInto]) {
        if (target === production) return refuse(`pull requests would merge into ${production}, the production branch; production is never a target`);
      }
    }

    const env = ctx.env ?? process.env;
    const home = sfHome(env, os.homedir());
    const problem = homeProblem(env, home);
    if (problem) return refuse(problem);

    const aliases = Object.keys(l.orgs);
    if (aliases.length === 0) return refuse('salesforce.orgs names no org; production is never a target');

    const targets = new Set([...l.build.aliases, ...l.stages.map((s) => s.org)]);
    const iso = isolatedSh(ctx.sh, env, home, os.homedir());
    for (const alias of aliases) {
      const { orgId, production } = l.orgs[alias];
      if (!orgId) return refuse(`${alias} has no org ID in salesforce.orgs`);
      const q = orgQuery(iso, alias);
      if (!q.ok) return refuse(`could not check ${alias}: ${q.error.message}`);
      const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
      const record = isObject(records[0]) ? records[0] : null;
      if (production === true && !targets.has(alias)) {
        if (record?.IsSandbox !== false) return refuse(`${alias} is marked "production": true in salesforce.orgs, but its server says it is a sandbox`);
      } else if (!record || record.IsSandbox !== true) return refuse(`${alias} is not a sandbox; production is never a target`);
      if (id15(record.Id) !== id15(orgId)) return refuse(`${alias} is org ${id15(record.Id)}, not ${orgId}`);
    }
    return { ok: true };
  },
};
