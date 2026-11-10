// A real supervisor run whose story session ends with large transcripts and no result: they are
// read in a child of its own (and the working tree hash it then takes, through a `git write-tree`
// that sleeps 30), so the supervisor keeps ticking (a pause is applied), the dashboard answers,
// and `foreman stop --now` ends the close with the run.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { holdsTheLoopFree, withLoopFree } from '../../../test/loop-free-fixture.mjs';

const SESSION = '6b2f1c9e-3a54-4d7e-9c10-8e5a2f7b4d63';

// The session writes an init event with a session id, about 8 MB of log lines and a transcript of
// about 8 MB for one agent under HOME, then ends with no result.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
appendFileSync(process.env.LOOP_FREE_CLAUDE, process.env.FOREMAN_STORY + '\\n');
const id = '${SESSION}';
const log = [JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'claude-sonnet-4' })];
const filler = JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'x'.repeat(7000) }] } });
for (let i = 0; i < 1200; i++) log.push(filler);
process.stdout.write(log.join('\\n') + '\\n');
const dir = join(process.env.HOME, '.claude', 'projects', '-fake', id, 'subagents');
mkdirSync(dir, { recursive: true });
const turn = JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T10:00:00.000Z', message: { id: 'a', model: 'claude-sonnet-4', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'y'.repeat(7000) }] } });
writeFileSync(join(dir, 'agent-a1.jsonl'), (turn + '\\n').repeat(1200));
process.exit(1);
`;

const ctx = withLoopFree({
  claude: FAKE_CLAUDE,
  git: `case "$1" in
  write-tree)
    if [ -n "$GIT_INDEX_FILE" ]; then echo $$ >> "$LOOP_FREE_MARK"; sleep 30; fi ;;
esac`,
  setup: async (c) => {
    c.story('ACME-1');
    c.commit('Add the story');
  },
});

describe('a supervisor run while an ended session is read', () => {
  it('reads the session files in a child: keeps ticking and answering, and `foreman stop --now` ends it with the run', async () => {
    ctx.start();
    await ctx.waitFor('the close to reach the working tree hash', () => ctx.markPids().length > 0, 60_000);
    const [pid] = ctx.markPids();
    await ctx.waitFor('the slot to say it closes the session', () => ctx.slot('w1')?.story?.detail === 'closing the session', 10_000);
    expect(existsSync(join(ctx.repos.base, '.claude', 'projects', '-fake', SESSION))).toBe(false);

    await holdsTheLoopFree(ctx, { pid });

    expect(ctx.claudeCalls()).toEqual(['ACME-1']);
  }, 120_000);
});
