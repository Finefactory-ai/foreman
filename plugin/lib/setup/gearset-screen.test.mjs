import { describe, expect, it } from 'vitest';
import { GEARSET_SCREEN } from './gearset-screen.mjs';

// Every {placeholder} the page or the server fills in, by the words that use it.
const FILLED = {
  'flags.unmatched': [],
  'flags.production': [],
  missing: ['org', 'stage'],
  testsChecked: ['tests', 'stage'],
  testsNone: ['stage'],
  testsUnknown: [],
  confirmedByYou: ['date'],
  'errors.other': ['status'],
};

const at = (path) => path.split('.').reduce((v, k) => v[k], GEARSET_SCREEN);
const texts = (v, path = '') => (typeof v === 'string' ? [[path, v]] : Object.entries(v).flatMap(([k, x]) => texts(x, path ? `${path}.${k}` : k)));

describe('GEARSET_SCREEN', () => {
  it('is plain data, deep-frozen, with part gearset', () => {
    const walk = (v, where) => {
      expect(typeof v, where).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), where).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
      }
    };
    walk(GEARSET_SCREEN, 'GEARSET_SCREEN');
    expect(JSON.parse(JSON.stringify(GEARSET_SCREEN))).toEqual(GEARSET_SCREEN);
    expect(GEARSET_SCREEN.part).toBe('gearset');
  });

  it('has words for the picker, the table, the CI jobs, the test levels and every error', () => {
    const want = [
      'heading',
      'picker.label', 'picker.read', 'picker.readAgain', 'picker.reading', 'picker.save', 'picker.saving', 'picker.noPipelines', 'picker.pickFirst',
      'table.environment', 'table.gearsetStage', 'table.org', 'table.stage', 'table.ciJob',
      'flags.unmatched', 'flags.production', 'missing',
      'ciJob.enabled', 'ciJob.off', 'ciJob.none',
      'testsChecked', 'testsNone', 'testsUnknown', 'confirmedByYou', 'confirm', 'unconfirm',
      'errors.tokenFirst', 'errors.badToken', 'errors.tier', 'errors.tooMany', 'errors.unreachable', 'errors.other', 'errors.notGearset',
      'errors.badPipeline', 'errors.badStage', 'errors.badBody', 'errors.nothingChanged', 'errors.setupFirst', 'errors.notSaved',
    ];
    for (const path of want) expect(typeof at(path) === 'string' && at(path).length > 0, path).toBe(true);
    expect(GEARSET_SCREEN.flags.unmatched).toBe('No org in salesforce.orgs has this org ID');
    expect(GEARSET_SCREEN.flags.production).toBe("Gearset's production environment: Foreman never promotes here");
    expect(GEARSET_SCREEN.missing).toBe('No Gearset environment in this pipeline deploys to {org}, the org of stage {stage}');
    expect(GEARSET_SCREEN.testsChecked).toBe("Checked: {tests} Apex tests ran in Gearset's last deploy to {stage}.");
    expect(GEARSET_SCREEN.testsUnknown).toBe("Gearset does not show a CI job's test level, and no recent deploy shows it. Check the CI job in Gearset, then confirm here.");
    expect(GEARSET_SCREEN.confirm).toBe('I set a test level on this CI job');
    expect(GEARSET_SCREEN.errors.tokenFirst).toBe('Save GEARSET_API_TOKEN first.');
    expect(GEARSET_SCREEN.errors.tier).toMatch(/Teams or Enterprise/);
    expect(GEARSET_SCREEN.errors.badToken).toMatch(/key card below/);
    expect(GEARSET_SCREEN.errors.badToken).not.toMatch(/above/);
  });

  it('uses only the placeholders the page or the server fills in', () => {
    for (const [path, text] of texts(GEARSET_SCREEN)) {
      const used = [...text.matchAll(/\{([a-z]+)\}/gi)].map((m) => m[1]).sort();
      expect(used, path).toEqual([...(FILLED[path] ?? [])].sort());
    }
  });

  it('holds no click path and no guide text', () => {
    for (const [path, text] of texts(GEARSET_SCREEN)) {
      expect(text, path).not.toMatch(/›|>|Edit CI job|RunLocalTests/);
    }
    expect(JSON.stringify(GEARSET_SCREEN)).not.toContain('click');
  });
});
