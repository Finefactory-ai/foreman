// Ship step `sf-delta`: what this story changes in Salesforce terms, for the steps after it.
// It runs after merge-main, so the base branch is already merged in. It refuses with code 1 when
// the story id is not a plain id (STORY_ID), before it runs anything.
//
//   1. the pin: sfdx-git-delta on the SGD_LINE version line (the runner image pins the same)
//   2. the range: from `git merge-base HEAD <remote>/<baseBranch>` to HEAD, both as SHAs.
//      It never passes --merge-base: the range is worked out here, once.
//   3. `sf sgd source delta --generate-delta` into <stateDir>/salesforce/delta/<story id>,
//      emptied first so nothing from an earlier run is read
//   4. no agent test definitions: an AiEvaluationDefinition in the package manifest (added or
//      changed in the package folders) stops with code 2 and one entry per member in failures,
//      so nothing is pushed and the builder gets a fix round. The eval spec lives in
//      tests/<agent>-eval.json instead. Deleting one is a normal delete. Unless
//      salesforce.agentforce is "off", every AiAuthoringBundle in the manifest needs that spec
//      at HEAD, in the shape readEvalSpec (agent-eval.mjs) checks; a missing or malformed one
//      also stops with code 2.
//   5. the deletes: sgd always writes destructiveChanges/destructiveChanges.xml, empty when
//      nothing is deleted, so deletes are any <types> in it. Flow and RecordType deletes are
//      never deployed: each becomes a manual step for the owner. The rest are written to
//      postDestructiveChanges.xml (written even when empty), sorted by type, then member.
//   6. the decision: no deletes, or salesforce.destructive "allow", passes. With "ask" (the
//      default) the deletes pass only when the owner allowed them for this exact
//      destructiveChanges.xml (its sha256; deletes.mjs keeps the record). An owner who asked
//      to keep them out gets code 10 with keepOut and the record as it is. Otherwise the
//      question is recorded and the step stops with code 10: nothing pushed, nothing halted.
//
// Facts for later steps: sfDelta { dir, from, to, manifest, postDestructive, deletes, sha256 }
// and manualSteps (always an array). sgdProblem (step 1) and buildDelta (steps 3 and 5, without
// the decision) are exported for rollback.mjs. buildDelta also takes `hold`, a list of
// { type, member } that a delete must not deploy (the rollback holds what a published agent
// still uses); the step itself passes none. A message names only metadata types and members, plus
// sf's own error message; never an sf result.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { out } from '../../../lib/engine/git.mjs';
import { stateDir } from '../../../lib/engine/paths.mjs';
import { safeId } from '../../../lib/adapters/stories/overlay.mjs';
import { STORY_ID } from '../../../lib/console/commands.mjs';
import { loadEvalSpec } from '../agent-eval.mjs';
import { agentBundles, evalDefinitions } from '../agentforce.mjs';
import { askDeletes, readDeletes } from '../deletes.mjs';
import { manifestTypes } from '../env/sandbox-pool.mjs';
import { isolatedSh, sfHome } from '../isolation.mjs';
import { runSf } from '../sf.mjs';

export const SGD_LINE = '6.45';

const STAGE = 'sf-delta';
const SGD = 'sfdx-git-delta';
const SGD_TIMEOUT_MS = 600_000;
const BY_HAND = ['Flow', 'RecordType'];
const XMLNS = 'http://soap.sforce.com/2006/04/metadata';

const fail = (code, reason, extra = {}) => ({ ok: false, code, stage: STAGE, reason, ...extra });
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The installed sfdx-git-delta version, or null.
function sgdVersion(result) {
  const list = Array.isArray(result) ? result : [];
  const entry = list.find((p) => p && typeof p === 'object' && p.name === SGD);
  return typeof entry?.version === 'string' ? entry.version : null;
}

// The <version> of a manifest, or null.
function versionOf(file) {
  try {
    return /<version>\s*([^<]+?)\s*<\/version>/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

function packageXml(deletes, version) {
  const byType = new Map();
  for (const { type, member } of deletes) byType.set(type, [...(byType.get(type) ?? []), member]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Package xmlns="${XMLNS}">`,
    ...[...byType].map(([type, members]) => ['    <types>', ...members.map((m) => `        <members>${escapeXml(m)}</members>`), `        <name>${escapeXml(type)}</name>`, '    </types>'].join('\n')),
    ...(version ? [`    <version>${escapeXml(version)}</version>`] : []),
    '</Package>',
    '',
  ].join('\n');
}

// Why the installed sfdx-git-delta cannot be used, or null when it is on the SGD_LINE line.
export function sgdProblem(iso) {
  const plugins = runSf(iso, ['plugins', '--core']);
  if (!plugins.ok) return `could not list the sf plugins: ${plugins.error.message}`;
  const version = sgdVersion(plugins.result);
  if (!version?.startsWith(`${SGD_LINE}.`)) {
    return `${SGD} ${version ?? 'missing'} is installed; Foreman needs ${SGD_LINE}.x: sf plugins install ${SGD}@${SGD_LINE}.1`;
  }
  return null;
}

// Runs sgd from `from` to `to` into `dir`, emptied first, in `cwd` when given, and reads what
// it wrote: Flow and RecordType deletes go into byHand, the rest into deletes (sorted by type,
// then member), which are written to postDestructiveChanges.xml. A delete that equals a `hold`
// item (same type and member, not Flow or RecordType) goes into held, sorted the same way, and
// not into deletes or the file. Returns { ok: true, manifest, postDestructive, deletes, byHand,
// held, sha256 } (sha256 is that of destructiveChanges.xml, held or not), or { ok: false,
// reason }. rollback.mjs builds its reverse delta with it.
export function buildDelta(iso, { from, to, dir, cwd, hold = [] }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const delta = runSf(iso, ['sgd', 'source', 'delta', '--from', from, '--to', to, '--output-dir', dir, '--generate-delta'], { timeoutMs: SGD_TIMEOUT_MS, ...(cwd ? { cwd } : {}) });
  if (!delta.ok) return { ok: false, reason: `could not build the delta: ${delta.error.message}` };

  const manifest = join(dir, 'package', 'package.xml');
  const destructive = join(dir, 'destructiveChanges', 'destructiveChanges.xml');
  const removed = manifestTypes(destructive);

  const byHand = [];
  const deletes = [];
  const held = [];
  const holding = (type, member) => hold.find((h) => h?.type === type && h?.member === member);
  for (const [type, members] of Object.entries(removed)) {
    for (const member of members) {
      if (BY_HAND.includes(type)) byHand.push({ type, member });
      else if (holding(type, member)) held.push({ ...holding(type, member) });
      else deletes.push({ type, member });
    }
  }
  const byTypeThenMember = (a, b) => compare(a.type, b.type) || compare(a.member, b.member);
  byHand.sort(byTypeThenMember);
  deletes.sort(byTypeThenMember);
  held.sort(byTypeThenMember);

  const postDestructive = join(dir, 'postDestructiveChanges.xml');
  fs.writeFileSync(postDestructive, packageXml(deletes, versionOf(destructive)));

  let bytes;
  try {
    bytes = fs.readFileSync(destructive);
  } catch {
    return { ok: false, reason: 'sfdx-git-delta wrote no destructiveChanges.xml' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { ok: true, manifest, postDestructive, deletes, byHand, held, sha256 };
}

export default {
  name: 'sf-delta',
  label: 'working out the Salesforce delta',
  needs: ['sf', 'git'],

  run(ctx) {
    if (typeof ctx.story !== 'string' || !STORY_ID.test(ctx.story)) return fail(1, `not a story id: ${JSON.stringify(String(ctx.story ?? ''))}`);
    const env = ctx.env ?? process.env;
    const iso = isolatedSh(ctx.sh, env, sfHome(env, os.homedir()), os.homedir());

    const pin = sgdProblem(iso);
    if (pin) return fail(1, pin);

    const { remote, baseBranch } = ctx.config;
    const from = out(ctx, 'git', ['merge-base', 'HEAD', `${remote}/${baseBranch}`]);
    if (!from) return fail(1, `could not find where the branch left ${remote}/${baseBranch}`);
    const to = out(ctx, 'git', ['rev-parse', 'HEAD']);
    if (!to) return fail(1, 'could not read HEAD');

    const dir = join(stateDir(ctx.root, ctx.config, env), 'salesforce', 'delta', safeId(ctx.story));
    const built = buildDelta(iso, { from, to, dir });
    if (!built.ok) return fail(1, built.reason);
    const { manifest, postDestructive, deletes, sha256 } = built;

    const evals = evalDefinitions(manifest);
    if (evals.length) {
      return fail(2, `The change puts AiEvaluationDefinition files in the package folders: ${evals.join(', ')}. Agent test definitions never go there: delete them and keep the eval spec in tests/<agent>-eval.json.`, {
        failures: evals.map((name) => ({ kind: 'AiEvaluationDefinition', name, message: 'agent test definitions never go in the package folders; delete it' })),
      });
    }

    if (ctx.config.salesforce?.agentforce !== 'off') {
      for (const api of agentBundles(manifest)) {
        const spec = loadEvalSpec(ctx.sh, to, api);
        if (!spec.ok) return fail(2, `${spec.reason}. Every changed agent needs its eval spec before it ships.`);
      }
    }

    const manualSteps = built.byHand.map(({ type, member }) => `Delete ${type} ${member} by hand in each org the story reaches; Foreman never deletes ${type}s`);
    manualSteps.sort(compare);
    const facts = { sfDelta: { dir, from, to, manifest, postDestructive, deletes, sha256 }, manualSteps };

    if (deletes.length === 0 || ctx.config.salesforce?.destructive === 'allow') return { ok: true, ...facts };

    const state = stateDir(ctx.root, ctx.config, env);
    const record = readDeletes(state, ctx.story);
    if (record?.answer === 'allow' && record.sha256 === sha256) return { ok: true, ...facts, deletesAllowed: true };
    if (record?.answer === 'keep-out') {
      return fail(10, `The owner asked to keep deletes out, but the change still deletes ${deletes.length} component(s).`, { deletes, keepOut: true, manualSteps });
    }
    askDeletes(state, { story: ctx.story, sha256, deletes }, ctx.now?.() ?? new Date());
    return fail(10, `The change deletes ${deletes.length} component(s); the owner must allow the deletes before it ships.`, { deletes, sha256, manualSteps });
  },
};
