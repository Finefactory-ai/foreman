// A made-up pack named "acme" for tests. It has every member a pack can have (see
// plugin/packs/index.mjs), so the tests can register it in place of the real PACKS and check
// that each registry picks it up only when the config names it.

export function fakePack(overrides = {}) {
  return {
    name: 'acme',
    detect: () => null,
    defaults: (block) => ({
      rounds: 5,
      ship: { steps: ['merge-main', 'push', 'acme-deploy'] },
      acme: { region: 'eu', mode: block?.mode ?? 'basic' },
    }),
    steps: {
      'acme-deploy': {
        name: 'acme-deploy',
        needs: ['acme-cli'],
        requires: { env: ['ACME_TOKEN'] },
        async run() {
          return { ok: true };
        },
      },
    },
    envAdapters: {
      'acme-org': {
        create: () => ({ env: (n) => ({ FOREMAN_SLOT: `w${n}` }), prepare: () => 'up' }),
        requires: { env: ['ACME_ORG_KEY'] },
      },
    },
    doctorChecks: () => [{ name: 'acme org', run: () => ({ ok: true, level: 'error', detail: '' }) }],
    checkConfig: (block) => (block?.region === 'moon' ? [{ path: 'region', message: 'unknown region' }] : []),
    guard: () => null,
    ...overrides,
  };
}
