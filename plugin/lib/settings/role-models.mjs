// The model setting of each agent role, made per project: one entry for the architect, each
// builder, the tester and each reviewer the config has (registry.mjs settingsFor lists them,
// findSetting finds one by name). Names:
//
//   roles.architect.model   roles.tester.model
//   roles.builders.<name>.model
//   roles.reviewers.<name>.model   (in the file, the reviewer of that name in the array)
//   roles.reviewers.<name>.engine  the CLI a reviewer runs through, as text "<engine>:<model>"
//                             (`antigravity:claude-opus-4-6-thinking`); in the file it is the
//                             reviewer's `engine: { name, model, minutes? }` block
//                             (config/validate.mjs reviewEngine). Set, it writes name and model
//                             and keeps minutes; removed, the whole block goes, because an
//                             engine without a model does not validate.
//
//   roleModelEntry(name)      the entry for that name, or null when it is not a role model
//   roleModelEntries(config)  the entries for the roles `config` has: architect, each builder in
//                             object order, tester, each reviewer in array order (its model,
//                             then its engine)
//
// Each entry is a registry entry (an enum of AGENT_MODELS, unset by default, in the models
// group) plus what a dotted path cannot do, since reviewers is an array and builders replace
// as a whole:
//
//   get(config)               the role's model, or undefined
//   put(obj, value)           sets the role's model in place on a loaded config (the local
//                             layer); does nothing when the role is missing
//   team.set(raw, value, config)
//                             a new raw file with the model set. A file without the role's block
//                             first gets it copied whole from `config`, the team-merged config:
//                             the role object, the whole builders object (so a pack project keeps
//                             its pack builders) or the whole reviewers array. The merged config
//                             then differs only by the model, and the file still validates.
//   team.remove(raw)          a new raw file without the model, the rest of the block kept; null
//                             when the file does not set it
//   unset                     what the dashboard calls "no model": the first option of the dropdown
//   inFile                    (reviewers only) where the model sits in the file, said to the user,
//                             because a reviewer's dotted name is not a path there

import { AGENT_MODELS, REVIEW_ENGINES } from '../config/validate.mjs';

const NAME = /^roles\.(?:(architect|tester)|(builders|reviewers)\.([a-z][a-z0-9-]*))\.model$/;
const ENGINE_NAME = /^roles\.reviewers\.([a-z][a-z0-9-]*)\.engine$/;
const DESCRIPTION = "The Claude model this agent runs on. Unset, it uses the story session's model.";
const REVIEWER_DESCRIPTION = 'The Claude model this reviewer runs on, or falls back to when its engine cannot run.';
const ENGINE_DESCRIPTION = 'Another CLI for this review, as engine:model, such as antigravity:claude-opus-4-6-thinking.';
const UNSET_MODEL = 'Same as the story session';
// "<engine>:<model>": a known engine, then the model as the CLI names it (no spaces or colons).
const ENGINE_TEXT = new RegExp(`^(${REVIEW_ENGINES.join('|')}):([^\\s:]+)$`);
const ENGINE_PROBLEM = `expected engine:model, the engine being ${REVIEW_ENGINES.join(' or ')}, such as antigravity:claude-opus-4-6-thinking`;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : structuredClone(v));

// How to find each kind of role in a config or raw file: the block that holds the model, and the
// whole part of `roles` a raw file must hold for it.
function kindOf(kind, name) {
  if (kind === 'architect' || kind === 'tester') {
    const label = kind === 'architect' ? 'Architect' : 'Tester';
    return {
      label,
      whenText: `the project has ${kind === 'architect' ? 'an architect' : 'a tester'}`,
      key: kind,
      has: (part) => isPlain(part),
      block: (part) => (isPlain(part) ? part : null),
    };
  }
  if (kind === 'builders') {
    return {
      label: `Builder: ${name}`,
      whenText: `the project has a builder named ${name}`,
      key: 'builders',
      has: (part) => isPlain(part),
      block: (part) => (isPlain(part) && Object.hasOwn(part, name) && isPlain(part[name]) ? part[name] : null),
    };
  }
  return {
    label: `Reviewer: ${name}`,
    whenText: `the project has a reviewer named ${name}`,
    inFile: `the reviewer named ${name} in roles.reviewers`,
    key: 'reviewers',
    has: (part) => Array.isArray(part),
    block: (part) => (Array.isArray(part) ? (part.find((r) => isPlain(r) && r.name === name) ?? null) : null),
  };
}

const partOf = (obj, key) => (isPlain(obj) && isPlain(obj.roles) && Object.hasOwn(obj.roles, key) ? obj.roles[key] : undefined);

export function roleModelEntry(name) {
  const m = NAME.exec(String(name));
  if (!m) return reviewerEngineEntry(name);
  const k = kindOf(m[1] ?? m[2], m[3]);
  const blockIn = (obj) => k.block(partOf(obj, k.key));
  return Object.freeze({
    name,
    label: k.label,
    description: k.key === 'reviewers' ? REVIEWER_DESCRIPTION : DESCRIPTION,
    type: 'enum',
    values: AGENT_MODELS,
    default: null,
    applies: 'next-story',
    group: 'models',
    secret: false,
    unset: UNSET_MODEL,
    ...(k.inFile ? { inFile: k.inFile } : {}),
    when: (config) => blockIn(config) !== null,
    whenText: k.whenText,
    get: (config) => blockIn(config)?.model,
    put(obj, value) {
      const block = blockIn(obj);
      if (block) block.model = value;
      return obj;
    },
    team: Object.freeze({
      set(raw, value, config) {
        const out = clone(raw);
        if (!isPlain(out.roles)) out.roles = {};
        if (!k.has(out.roles[k.key])) out.roles[k.key] = clone(partOf(config, k.key));
        const block = k.block(out.roles[k.key]);
        if (block) block.model = value;
        return out;
      },
      remove(raw) {
        const block = blockIn(raw);
        if (!block || !Object.hasOwn(block, 'model')) return null;
        const out = clone(raw);
        delete blockIn(out).model;
        return out;
      },
    }),
  });
}

const engineText = (engine) => (isPlain(engine) && typeof engine.name === 'string' && typeof engine.model === 'string' ? `${engine.name}:${engine.model}` : undefined);

function setEngine(block, value) {
  const m = ENGINE_TEXT.exec(String(value));
  if (block && m) block.engine = { ...(isPlain(block.engine) ? block.engine : {}), name: m[1], model: m[2] };
}

function reviewerEngineEntry(name) {
  const m = ENGINE_NAME.exec(String(name));
  if (!m) return null;
  const k = kindOf('reviewers', m[1]);
  const blockIn = (obj) => k.block(partOf(obj, k.key));
  return Object.freeze({
    name,
    label: `${k.label} engine`,
    description: ENGINE_DESCRIPTION,
    type: 'string',
    default: null,
    applies: 'next-story',
    group: 'models',
    secret: false,
    inFile: k.inFile,
    when: (config) => blockIn(config) !== null,
    whenText: k.whenText,
    check: (value) => (ENGINE_TEXT.test(String(value)) ? null : ENGINE_PROBLEM),
    get: (config) => engineText(blockIn(config)?.engine),
    put(obj, value) {
      setEngine(blockIn(obj), value);
      return obj;
    },
    team: Object.freeze({
      set(raw, value, config) {
        const out = clone(raw);
        if (!isPlain(out.roles)) out.roles = {};
        if (!k.has(out.roles[k.key])) out.roles[k.key] = clone(partOf(config, k.key));
        setEngine(k.block(out.roles[k.key]), value);
        return out;
      },
      remove(raw) {
        const block = blockIn(raw);
        if (!block || !Object.hasOwn(block, 'engine')) return null;
        const out = clone(raw);
        delete blockIn(out).engine;
        return out;
      },
    }),
  });
}

export function roleModelEntries(config) {
  const roles = isPlain(config) && isPlain(config.roles) ? config.roles : {};
  const names = [
    ...(isPlain(roles.architect) ? ['roles.architect.model'] : []),
    ...(isPlain(roles.builders) ? Object.keys(roles.builders).map((b) => `roles.builders.${b}.model`) : []),
    ...(isPlain(roles.tester) ? ['roles.tester.model'] : []),
    ...(Array.isArray(roles.reviewers) ? roles.reviewers.flatMap((r) => [`roles.reviewers.${isPlain(r) ? r.name : ''}.model`, `roles.reviewers.${isPlain(r) ? r.name : ''}.engine`]) : []),
  ];
  return names.map(roleModelEntry).filter(Boolean);
}
