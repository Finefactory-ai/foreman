// Runs a Workflow-tool script under vitest. A workflow script is the body of an async
// function: it reads a global `args`, calls the globals `agent`, `parallel`, `phase` and
// `log`, and ends with a top-level `return`. The harness drops the `export const meta`
// block, injects fakes for those globals, and records every agent call.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PIPELINE = fileURLToPath(new URL('../plugin/workflows/pipeline.js', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// Finds the `export const meta = { ... }` block by walking to its balanced closing brace,
// skipping braces inside strings, template literals and comments.
export function splitMeta(source) {
  const start = source.indexOf('export const meta');
  if (start === -1) throw new Error('no `export const meta` in the workflow');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      const literal = source.slice(open, i + 1);
      const meta = new Function(`return (${literal})`)();
      return { meta, body: source.slice(0, start) + source.slice(i + 1) };
    }
  }
  throw new Error('the meta block never closes');
}

// The scripted result for a call: an exact label first, then the longest label prefix.
// A function value is called with the recorded call. An unscripted label is a test bug.
function scripted(script, call) {
  let key = Object.hasOwn(script, call.label) ? call.label : undefined;
  if (key === undefined) {
    key = Object.keys(script)
      .filter((k) => call.label.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
  }
  if (key === undefined) throw new Error(`no scripted result for agent label ${call.label}`);
  const value = script[key];
  return typeof value === 'function' ? value(call) : value;
}

// Runs the workflow with `args`. `script` maps labels (or label prefixes) to the results the
// fake `agent` returns. `file` defaults to workflows/pipeline.js.
export async function runWorkflow(args, script = {}, { file = PIPELINE } = {}) {
  const { meta, body } = splitMeta(readFileSync(file, 'utf8'));
  const calls = [];
  const logs = [];
  const phases = [];
  let current;

  const agent = async (prompt, opts = {}) => {
    const call = {
      prompt,
      agentType: opts.agentType,
      label: opts.label,
      phase: opts.phase ?? current,
      schema: opts.schema,
      model: opts.model,
      hasModel: Object.hasOwn(opts, 'model'),
    };
    calls.push(call);
    return structuredClone(await scripted(script, call));
  };
  const parallel = (thunks) => Promise.all(thunks.map((f) => f()));
  const phase = (title) => {
    current = title;
    phases.push(title);
  };
  const log = (text) => logs.push(text);

  const run = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body);
  const result = await run(args, agent, parallel, phase, log);
  return { result, calls, logs, phases, meta };
}
