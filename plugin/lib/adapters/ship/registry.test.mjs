import { describe, expect, it } from 'vitest';
import { envNamesOf, onFailureFor, stepTableFor, stepsFor } from './registry.mjs';
import { withDefaults } from '../../config/defaults.mjs';
import mergeMain from './merge-main.mjs';
import resources from './resources.mjs';
import push from './push.mjs';
import pr from './pr.mjs';
import ci from './ci.mjs';
import merge from './merge.mjs';
import mergeableRecheck from './mergeable-recheck.mjs';
import prepareMigrations from './prepare-migrations.mjs';
import supabaseCredentials from './supabase-credentials.mjs';
import migrateSupabase from './migrate-supabase.mjs';
import deployGithub from './deploy-github.mjs';
import smoke from './smoke.mjs';
import watch from './watch.mjs';
import rollback from './rollback.mjs';
import { validate } from '../../config/validate.mjs';
import { fakePack } from '../../../../test/fake-pack.mjs';

describe('stepsFor', () => {
  it('the default steps resolve to the seven modules, in order', () => {
    const steps = stepsFor(withDefaults({ version: 1, project: { name: 'T' } }));
    expect(steps).toEqual([mergeMain, resources, push, pr, ci, mergeableRecheck, merge]);
    expect(steps.map((s) => s.name)).toEqual(['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge']);
  });
  it('follows the configured order', () => {
    expect(stepsFor({ ship: { steps: ['push', 'merge'] } })).toEqual([push, merge]);
  });
  it('knows the migration steps', () => {
    expect(stepsFor({ ship: { steps: ['prepare-migrations', 'migrate-supabase'] } })).toEqual([prepareMigrations, migrateSupabase]);
  });
  it('resolves an eleven-step release, with its options, in order', () => {
    const raw = {
      version: 1,
      project: { name: 'Acme' },
      ship: {
        steps: ['merge-main', 'prepare-migrations', 'resources', 'supabase-credentials', 'push', 'pr', 'ci', 'migrate-supabase', 'merge', 'deploy-github', 'smoke'],
        ci: { required: ['typecheck · lint · unit tests', 'migrations · policy tests · integration tests'] },
        'prepare-migrations': {},
        'migrate-supabase': { projectRef: 'uoizcnvpsbrzcvkxdjez' },
        'deploy-github': { environment: 'Production' },
        smoke: { urls: ['https://acme-app.vercel.app'] },
      },
    };
    expect(validate(raw)).toEqual([]);
    const config = withDefaults(raw);
    expect(stepsFor(config)).toEqual([mergeMain, prepareMigrations, resources, supabaseCredentials, push, pr, ci, migrateSupabase, merge, deployGithub, smoke]);
    expect(config.ship['migrate-supabase'].projectRef).toBe('uoizcnvpsbrzcvkxdjez');
    expect(config.ship.smoke.urls).toEqual(['https://acme-app.vercel.app']);
  });
  it('knows mergeable-recheck', () => {
    expect(stepsFor({ ship: { steps: ['mergeable-recheck'] } }).map((s) => s.name)).toEqual(['mergeable-recheck']);
  });
  it('knows watch', () => {
    expect(stepsFor({ ship: { steps: ['deploy-github', 'smoke', 'watch'] } })).toEqual([deployGithub, smoke, watch]);
  });
  it('never puts rollback in the normal order', () => {
    expect(() => stepsFor({ ship: { steps: ['merge', 'rollback'] } })).toThrow('rollback runs only on failure; set ship.rollback.command and leave it out of ship.steps');
  });
  it('rejects an unknown step', () => {
    expect(() => stepsFor({ ship: { steps: ['push', 'launch-rocket'] } })).toThrow('unknown ship step: launch-rocket');
    expect(() => stepsFor({ ship: { steps: ['toString'] } })).toThrow('unknown ship step: toString');
  });
  it('every step has a name, a run function and a list of needs', () => {
    for (const s of stepsFor(withDefaults({ version: 1, project: { name: 'T' } }))) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.run).toBe('function');
      expect(Array.isArray(s.needs)).toBe(true);
    }
  });
});

describe('stepsFor and onFailureFor with the switches off', () => {
  const RELEASE = { steps: ['pr', 'ci', 'mergeable-recheck', 'merge', 'deploy-github', 'watch'], watch: { command: './check.sh' }, rollback: { command: 'vercel rollback --yes' } };
  const config = (features) => withDefaults({ version: 1, project: { name: 'T' }, ship: RELEASE, features });

  it('keeps every step while the switches are on, as they are by default', () => {
    expect(stepsFor(config({})).map((s) => s.name)).toEqual(['pr', 'ci', 'mergeable-recheck', 'merge', 'deploy-github', 'watch']);
    expect(onFailureFor(config({}))).toBe(rollback);
  });
  it('treats a config with no features block as on', () => {
    expect(stepsFor({ ship: RELEASE }).map((s) => s.name)).toContain('watch');
    expect(onFailureFor({ ship: RELEASE })).toBe(rollback);
  });
  it('features.mergeableRecheck off skips the mergeable-recheck step', () => {
    expect(stepsFor(config({ mergeableRecheck: false })).map((s) => s.name)).toEqual(['pr', 'ci', 'merge', 'deploy-github', 'watch']);
    expect(onFailureFor(config({ mergeableRecheck: false }))).toBe(rollback);
  });
  it('features.watchRollback off skips the watch step and never rolls back', () => {
    expect(stepsFor(config({ watchRollback: false })).map((s) => s.name)).toEqual(['pr', 'ci', 'mergeable-recheck', 'merge', 'deploy-github']);
    expect(onFailureFor(config({ watchRollback: false }))).toBeNull();
  });
});

describe('onFailureFor', () => {
  it('is the rollback step when ship.rollback.command is set', () => {
    expect(onFailureFor({ ship: { steps: ['merge'], rollback: { command: 'vercel rollback --yes' } } })).toBe(rollback);
  });
  it('is null otherwise', () => {
    expect(onFailureFor({ ship: { steps: ['merge'] } })).toBeNull();
    expect(onFailureFor({ ship: { steps: ['merge'], rollback: {} } })).toBeNull();
    expect(onFailureFor(withDefaults({ version: 1, project: { name: 'T' } }))).toBeNull();
  });
});

describe('stepsFor with a pack', () => {
  const packs = { acme: fakePack() };
  it('finds the pack steps when the config names the pack', () => {
    const acme = packs.acme.steps['acme-deploy'];
    expect(stepsFor({ pack: 'acme', ship: { steps: ['merge-main', 'push', 'acme-deploy'] } }, { packs })).toEqual([mergeMain, push, acme]);
  });
  it('does not know a pack step when the config names no pack', () => {
    expect(() => stepsFor({ ship: { steps: ['merge-main', 'acme-deploy'] } }, { packs })).toThrow('unknown ship step: acme-deploy');
  });
  it('refuses a pack step named like a core step', () => {
    const clash = { acme: fakePack({ steps: { merge: { name: 'merge', async run() { return { ok: true }; } } } }) };
    expect(() => stepsFor({ pack: 'acme', ship: { steps: ['merge'] } }, { packs: clash })).toThrow('pack acme ship step merge clashes with a core step');
  });
});

describe('stepTableFor', () => {
  it('holds every core step, configured or not', () => {
    expect(stepTableFor({ ship: { steps: ['push'] } })['migrate-supabase']).toBe(migrateSupabase);
  });
  it("adds the pack's steps when the config names the pack", () => {
    const packs = { acme: fakePack() };
    expect(stepTableFor({ pack: 'acme' }, { packs })['acme-deploy']).toBe(packs.acme.steps['acme-deploy']);
  });
  it('refuses a pack step named like a core step', () => {
    const clash = { acme: fakePack({ steps: { merge: { name: 'merge', async run() { return { ok: true }; } } } }) };
    expect(() => stepTableFor({ pack: 'acme' }, { packs: clash })).toThrow('clashes with a core step');
  });
});

describe('a pack whose steps are a function of the config', () => {
  const deploy = (stage) => ({ name: `acme-deploy-${stage}`, async run() { return { ok: true }; } });
  it('gets the config, and its names resolve in stepsFor', () => {
    const seen = [];
    const packs = { acme: fakePack({ steps: (config) => (seen.push(config), { [`acme-deploy-${config.acme.stage}`]: deploy(config.acme.stage) }) }) };
    const config = { pack: 'acme', acme: { stage: 'qa' }, ship: { steps: ['merge-main', 'acme-deploy-qa'] } };
    const [first, second] = stepsFor(config, { packs });
    expect(first).toBe(mergeMain);
    expect(second.name).toBe('acme-deploy-qa');
    expect(seen).toContain(config);
    expect(() => stepsFor({ ...config, acme: { stage: 'uat' } }, { packs })).toThrow('unknown ship step: acme-deploy-qa');
  });
  it('applies the clash check to what the function returns', () => {
    const packs = { acme: fakePack({ steps: () => ({ merge: deploy('x') }) }) };
    expect(() => stepTableFor({ pack: 'acme' }, { packs })).toThrow('pack acme ship step merge clashes with a core step');
  });
  it('refuses a function that returns something other than an object', () => {
    for (const bad of [[deploy('qa')], 'acme-deploy', 3]) {
      const packs = { acme: fakePack({ steps: () => bad }) };
      expect(() => stepTableFor({ pack: 'acme' }, { packs })).toThrow('pack acme ship steps must be an object of step modules');
    }
  });
  it('gives the core steps for a function that returns nothing', () => {
    const packs = { acme: fakePack({ steps: () => null }) };
    expect(stepTableFor({ pack: 'acme' }, { packs })).toBe(stepTableFor({}));
  });
});

describe('envNamesOf', () => {
  it('gives the names the steps declare in requires.env, once each, in first-seen order', () => {
    expect(envNamesOf([{ requires: { env: ['A', 'B'] } }, {}, { requires: { env: ['B', 'C'] } }])).toEqual(['A', 'B', 'C']);
  });

  it('skips missing and empty entries', () => {
    expect(envNamesOf([{ requires: {} }, { requires: { env: ['', 'A', null] } }, null])).toEqual(['A']);
  });
});
