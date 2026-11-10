// Token counts of a story session and its agents. Pure: text and objects in, counts out.
//
//   T                   { input, output, cacheRead, cacheWrite, turns }; ZERO is all zeros and
//                       total(t) is input + output + cacheRead + cacheWrite
//   transcriptUsage(text)  T plus model, from one agent's transcript (JSONL). Claude Code writes
//                       one `assistant` line per content block, each with the message's usage so
//                       far, so only the last line of each message.id counts (a line with no id
//                       counts on its own). turns is the messages counted; model the most
//                       frequent one, '<synthetic>' left out
//   agentOf(meta)       { role, name, agent, round } from an agent's .meta.json: the label the
//                       pipeline gives (architect:<id>, build:<id>, fix:<id>#<n>, test:<id>#<n>,
//                       <reviewer>:<id>#<n>), else its workflow phase, else 'other'
//   resultTokens(event) T plus models from a `result` event: modelUsage (which counts the
//                       subagents) summed over its models, else the main thread's usage, else null
//   storyAgents({ subagents, total, model })
//                       one row { role, name, agent, model, input, output, cacheRead, cacheWrite,
//                       turns, round } per subagent, plus an orchestration row (the session
//                       itself) worth the total less the subagents, never below 0, when the
//                       total is known; sorted by round, role and name

export const ZERO = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const ROLE_ORDER = ['architect', 'builder', 'tester', 'reviewer', 'other', 'orchestration'];
const PHASES = { Review: 'reviewer', Architect: 'architect', Build: 'builder', Test: 'tester' };
const NAMES = { architect: 'architect', build: 'builder', fix: 'builder', test: 'tester' };

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export const total = (t) => FIELDS.reduce((n, f) => n + count(t?.[f]), 0);

const parse = (line) => {
  if (!line.startsWith('{')) return null;
  try {
    const v = JSON.parse(line);
    return isPlain(v) ? v : null;
  } catch {
    return null; // a torn line
  }
};

export function transcriptUsage(text) {
  const byId = new Map();
  const loose = [];
  for (const raw of String(text ?? '').split('\n')) {
    const event = parse(raw.trim());
    if (event?.type !== 'assistant' || !isPlain(event.message?.usage)) continue;
    const { id, usage, model } = event.message;
    const entry = { usage, model: typeof model === 'string' ? model : null };
    if (typeof id === 'string' && id) byId.set(id, entry);
    else loose.push(entry);
  }
  const messages = [...byId.values(), ...loose];
  const t = { ...ZERO, turns: messages.length };
  const models = new Map();
  for (const { usage, model } of messages) {
    t.input += count(usage.input_tokens);
    t.output += count(usage.output_tokens);
    t.cacheRead += count(usage.cache_read_input_tokens);
    t.cacheWrite += count(usage.cache_creation_input_tokens);
    if (model && model !== '<synthetic>') models.set(model, (models.get(model) ?? 0) + 1);
  }
  let model = null;
  for (const [name, n] of models) if (model === null || n > models.get(model)) model = name;
  return { ...t, model };
}

export function agentOf(meta) {
  const other = { role: 'other', name: 'agent', agent: null, round: null };
  if (!isPlain(meta)) return other;
  const label = typeof meta.description === 'string' ? meta.description.trim() : '';
  const colon = label.indexOf(':');
  const name = (colon === -1 ? label : label.slice(0, colon)).trim();
  const hash = /#(\d+)\s*$/.exec(label);
  let round = hash ? Number(hash[1]) : null;
  const agent = typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : null;
  const role = NAMES[name] ?? PHASES[meta.workflowPhase] ?? null;
  if (!role) return { role: 'other', name: agent ?? 'agent', agent, round };
  if (name === 'build' && round === null) round = 1;
  return { role, name: name || agent || 'agent', agent, round };
}

export function resultTokens(event) {
  if (!isPlain(event)) return null;
  const turns = count(event.num_turns);
  const mu = event.modelUsage;
  if (isPlain(mu) && Object.keys(mu).length) {
    const t = { ...ZERO, turns };
    for (const m of Object.values(mu)) {
      t.input += count(m?.inputTokens);
      t.output += count(m?.outputTokens);
      t.cacheRead += count(m?.cacheReadInputTokens);
      t.cacheWrite += count(m?.cacheCreationInputTokens);
    }
    return { ...t, models: Object.keys(mu) };
  }
  const u = event.usage;
  if (isPlain(u)) {
    return { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens), turns, models: [] };
  }
  return null;
}

const roleRank = (role) => {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
};
const roundRank = (round) => (round === null ? -Infinity : round);

export function storyAgents({ subagents = [], total: sum = null, model = null } = {}) {
  const rows = (Array.isArray(subagents) ? subagents : []).map(({ meta, text } = {}) => {
    const a = agentOf(meta);
    const u = transcriptUsage(text);
    return { role: a.role, name: a.name, agent: a.agent, model: u.model, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, turns: u.turns, round: a.round };
  });
  if (sum) {
    const left = Object.fromEntries(FIELDS.map((f) => [f, Math.max(0, count(sum[f]) - rows.reduce((n, r) => n + r[f], 0))]));
    rows.push({ role: 'orchestration', name: 'orchestration', agent: null, model, ...left, turns: count(sum.turns), round: null });
  }
  return rows.sort((a, b) => roundRank(a.round) - roundRank(b.round) || roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'en'));
}
