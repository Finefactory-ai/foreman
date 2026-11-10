// A "build next" request whose story is already running in a slot is settled as started, with no
// warning, also when the run restarted on new code between the pick and the settlement (FM-366).
// The fixture is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixtureEnv,
  go,
  HELD_LOAD,
  isUp,
  pidOf,
  restartEvents,
  runRecords,
  setup,
  slotState,
  slow,
  started,
  startRun,
  state,
  stateJson,
  texts,
  until,
  withRestartRepos,
} from '../../../test/supervisor-restart-fixture.mjs';
import { nextStory } from '../console/control.mjs';
import { readPid } from './supervisor-pid.mjs';

withRestartRepos();

const STARTING = 'You asked for ACME-1 next; starting it.';

// The whole sequence for one slot layout; `extra` is merged into the config.
async function buildNextAcrossRestart(extra) {
  setup(extra, ['ACME-1'], HELD_LOAD);
  mkdirSync(state, { recursive: true });
  nextStory(state, 'ACME-1');
  const at = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8')).requestedAt;
  const run = startRun('go');
  let code;
  try {
    expect(await until(() => pidOf('ACME-1') && readPid(state), 30_000), 'ACME-1 started and the supervisor wrote its pid').toBeTruthy();
    const old = readPid(state);
    expect(await until(() => texts().includes(STARTING), 30_000), 'the old process picked ACME-1 from the request').toBe(true);
    expect(await until(() => restartEvents().length > 0, 40_000), 'the run restarted on the new code').toBe(true);
    expect(await until(() => existsSync(fixtureEnv.ACME_START_HELD) && !isUp(old), 20_000), 'the old process exited and the new one is held as it loads').toBe(true);

    // Lose the settlement, as in the incident: no process writes state.json in this window.
    const file = join(state, 'state.json');
    const { handledNextAt: _gone, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify(rest)}\n`);
    expect(stateJson().handledNextAt).toBeUndefined();

    writeFileSync(fixtureEnv.ACME_START_GATE, '');
    expect(await until(() => texts().includes('Kept 1 running across the restart: ACME-1 (w1).'), 30_000), 'the new process kept ACME-1 across the restart').toBe(true);
    expect(await until(() => stateJson().handledNextAt === at, 30_000), 'the request is settled as started').toBe(true);
    expect(isUp(pidOf('ACME-1')), 'ACME-1 still runs when the request settles').toBe(true);
    expect(existsSync(go)).toBe(false);
    expect(texts().some((t) => t.includes('cannot be built yet'))).toBe(false);
    const after = texts().slice(texts().findIndex((t) => t.startsWith('Restarted on new code')) + 1);
    expect(after.filter((t) => t.startsWith('You asked for ACME-1 next'))).toEqual([STARTING]);

    writeFileSync(go, '');
    expect(await until(() => slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1'), 30_000), 'w1 idle with a run record for ACME-1').toBe(true);
    expect(started()).toEqual(['ACME-1']);
  } finally {
    code = await run.stop();
  }
  expect(code).toBe(0);
}

describe('a build-next request across a restart', () => {
  it('settles a build-next request as started when its story runs in a slot across a restart between the pick and the settlement', async () => {
    await buildNextAcrossRestart({ slots: 2, workers: 2 });
  }, slow(120_000));

  it('settles a build-next request as started while its story fills the only slot, across a restart between the pick and the settlement', async () => {
    await buildNextAcrossRestart({ slots: 1, workers: 1 });
  }, slow(120_000));
});
