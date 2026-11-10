// A story session's files in a state folder, as the supervisor leaves them while it runs: the
// slot's mark, its log with the init line, and one transcript with its meta for each agent
// answer given. For tests of what reads a session's agent answers (`foreman workflow-args
// --save-plan`, plan-file.mjs sessionPlan).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markSession } from '../plugin/lib/engine/session-files.mjs';

export const SESSION = '4947378a-6485-4e40-9357-671b81c4acf3';

// `agents` is [{ label, phase, agentType, output }]: output is the StructuredOutput input the
// agent answered with, or null for one that never answered. Returns the projects folder.
export function markedSession(dir, { slot = 'w1', story = 'S-1', agents = [] } = {}) {
  const projects = join(dir, 'claude', 'projects');
  const logs = join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  const log = join(logs, `${slot}-${story}.log`);
  writeFileSync(log, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })}\n`);
  const wf = join(projects, '-acme', SESSION, 'subagents', 'workflows', 'wf_1');
  mkdirSync(wf, { recursive: true });
  const at = (m) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString();
  agents.forEach(({ label, phase = 'Architect', agentType = 'foreman:architect', output }, i) => {
    const n = i + 1;
    const lines = [{ type: 'assistant', timestamp: at(n), message: { id: `m${n}`, content: [{ type: 'text', text: 'working' }] } }];
    if (output) {
      lines.push({ type: 'assistant', timestamp: at(n + 1), message: { id: `o${n}`, content: [{ type: 'tool_use', name: 'StructuredOutput', id: `tu${n}`, input: output }] } });
      lines.push({ type: 'user', timestamp: at(n + 1), message: { content: [{ type: 'tool_result', tool_use_id: `tu${n}`, content: 'Structured output provided successfully' }] } });
    }
    writeFileSync(join(wf, `agent-a${n}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    writeFileSync(join(wf, `agent-a${n}.meta.json`), JSON.stringify({ agentType, description: label, workflowPhase: phase }));
  });
  markSession(dir, slot, { story, pid: 1, log, projects });
  return projects;
}
