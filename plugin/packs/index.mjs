// The packs Foreman knows, by name. A project picks one with `"pack": "<name>"` in
// foreman.config.json; a project without `pack` runs exactly as it would with no packs at all.
// Adding a pack: write it in its own folder beside this file and add it to PACKS.
//
// A pack module is one object:
//
//   {
//     name,                      the pack's key in PACKS
//     detect(dir),               optional; gets the project root. Returns null, undefined or
//                                false when the project is not the pack's, else a plain
//                                JSON-safe object of findings (true counts as findings {}).
//                                It is synchronous: a promise, or anything that is not true
//                                or a plain JSON-safe object, is reported in
//                                found.packErrors and claims nothing.
//                                `foreman init detect` asks each pack in name order; the
//                                first claim wins.
//     defaults(block, project),  optional; gets a clone of the project's own pack block (or
//                                undefined) and returns a partial config. It sits between
//                                Foreman's defaults and the project's file (config/defaults.mjs).
//                                `project` is { root, fs, file } when the config is loaded from
//                                a folder (loadConfig, init detect, the dashboard's pack switch),
//                                else undefined; `file` is the project's raw config, or undefined.
//                                Files are read through project.fs only, and defaults never throws.
//     steps,                     optional; { stepName: stepModule }, shaped like the modules in
//                                lib/adapters/ship/, or a function of the resolved config
//                                returning one, for step names that follow the config. A
//                                name must not clash with a core step.
//                                A step that parks a release may export async check(ctx),
//                                which `foreman release watch` calls until the release
//                                finishes or fails (lib/adapters/ship/registry.mjs says how).
//     requires,                  optional; { tools?: [...] }: commands the pack needs whatever
//                                its steps, such as a tool its set-up runs. The doctor's tools
//                                check counts them (lib/engine/doctor-checks.mjs requirements).
//     envAdapters,               optional; { name: module } with create(options, ctx) and
//                                `requires` or `requiresFor`, like lib/adapters/env/none.mjs.
//                                Its prepare(n, path) returns a state or a promise of one
//                                (lib/engine/slot-prepare.mjs). An optional sweep() tidies
//                                what closed stories left and answers { warnings } or a
//                                promise of it; the supervisor runs it every minute, and once
//                                at a stop as sweep({ stopping: true, limitMs }).
//     doctorChecks(config, ctx), optional; returns [{ name, step, run }] for `foreman doctor`.
//                                `step` is the set-up step the check belongs to
//                                (lib/setup/steps.mjs; 'project' when left out). A result
//                                that is not ok may carry fix: { hint, step?, action? }.
//     commands,                  optional; [{ name, summary, run }] added to the foreman command
//                                line for every pack in PACKS, whatever the project's pack, so
//                                a pack's set-up commands run before its config is complete. A
//                                name must not clash with a core command or another pack's.
//     checkConfig(block, config),
//                                returns [{ path, message }] for the project's pack block, with
//                                paths relative to the block ('' for the block itself). `config`
//                                is the project's file as written (not the resolved config), so
//                                a pack can check its block against top-level keys.
//     slotLimit(block) -> { max, why } | null,
//                                optional; the most slots the project's pack block allows, and
//                                why, or null for no limit. The settings panel refuses more
//                                (lib/settings/registry.mjs).
//     guard({ command, stage, slot, config }),
//                                optional; called on every Bash call in a factory run. `stage`
//                                is 'architect', 'build', 'test', 'review', or null for the
//                                foreman; `slot` is the slot name, such as 'w1'; `config` is the
//                                resolved config, with the pack's block at config[name].
//                                Returns null to allow, or a reason string to deny. A throw
//                                denies.
//     prepareSessions({ config, env, fs, sh, homedir }),
//                                optional; the supervisor calls it once at start, before any
//                                session (lib/engine/pack-session.mjs). Returns
//                                { ok: true, session: { env, pathPrefix, settings } | null } or
//                                { ok: false, reason }. A refusal, or a throw, stops the run.
//                                `env` is added to every story session's environment (the
//                                FOREMAN_* keys still win), `pathPrefix` (absolute folders) goes
//                                first on its PATH, and `settings` is passed as --settings.
//                                A session with anything else in those (a non-string env
//                                value, a relative folder) also stops the run. These settings
//                                are merged last, over the session's own (session.mjs), so
//                                they reach the session as given.
//     sessionNeeds,              optional; { plugins?: ['name@market', ...], mcpServers?:
//                                { name: { ...server } } }: what every story session loads for
//                                the pack, since story sessions load no plugin but Foreman and
//                                no MCP server they are not given (lib/engine/session-scope.mjs).
//                                The plugins are enabled and the servers passed in
//                                --mcp-config; a server of the same name that the project's
//                                session.mcpServers names wins. A sessionNeeds of any other
//                                shape stops the run.
//     liveStage(config, ctx) -> { name, org } | null,
//                                optional; the stage the release is live on (ctx holds the facts
//                                its steps found so far). The core watch and rollback steps name
//                                it in their stage words and reasons ("watching qa (acme-qa)
//                                after the deploy"); "production" is used only when the pack
//                                gives none (lib/adapters/ship/live-stage.mjs).
//     rolledBackAt({ dir, story }) -> ISO time | null,
//                                optional; when the story's last release was rolled back and no
//                                release since replaced it, read from the state folder `dir`. It
//                                is synchronous and never throws. The supervisor and `foreman
//                                story next` use it so that a pull request merged before that
//                                time does not count as shipped, and `foreman ship` uses it so
//                                the release opens a new pull request instead of reusing one
//                                merged before that time.
//     traitsDir,                 optional; an absolute folder holding all.md (every role) and
//                                <role>.md (one role). Their text goes before the project's own
//                                traits (lib/engine/traits.mjs); a missing file is skipped.
//   }
//
// The pack's block is the top-level key named like the pack (`"acme": { ... }` for pack acme).

import salesforce from './salesforce/pack.mjs';

export const PACKS = Object.freeze({ salesforce });

// The pack the config names, or null when it names none. Throws for a name not in `packs`.
export function packFor(config, packs = PACKS) {
  const name = config?.pack;
  if (name === undefined) return null;
  if (Object.hasOwn(packs, name)) return packs[name];
  throw new Error(`unknown pack: ${name}`);
}

export function packNames(packs = PACKS) {
  return Object.keys(packs).sort();
}

// Every pack's commands, in pack name order.
export function packCommands(packs = PACKS) {
  return packNames(packs).flatMap((name) => (Array.isArray(packs[name].commands) ? packs[name].commands : []));
}
