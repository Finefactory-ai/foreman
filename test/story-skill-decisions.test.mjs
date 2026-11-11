// The story skill asks its decisions as choices: a summary, a hint per option and a
// recommendation, on one command line each so the line can be found and checked here.
// Text pasted from the architect, a reviewer or a decision item goes in single quotes, so the
// shell never runs a backtick or $(...) inside it.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { explainProblems } from '../plugin/lib/console/decisions.mjs';
import { applyAnswers, RELEASE_RETRY_NOTE } from '../plugin/lib/engine/answers.mjs';
import { allText, skillFile } from './story-skill.mjs';

// SKILL.md holds the main path; each rare path is a file next to it.
const text = skillFile();
const answersFile = () => skillFile('answers.md');
const collapse = (t) => t.replace(/\s+/g, ' ').trim();

// The one line, across every file of the skill, holding every piece of text given.
function lineWith(...parts) {
  const found = allText().split('\n').filter((l) => parts.every((p) => l.includes(p)));
  expect(found, parts.join(' + ')).toHaveLength(1);
  return found[0];
}
const optionsOf = (line) => [...line.matchAll(/--option "([^"]+)"/g)].map((m) => m[1]);
const count = (line, flag) => line.split(flag).length - 1;

// The text between a heading and the next heading of the same or a higher level.
function section(text, heading) {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.match(/^#+/)[0];
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

describe('story skill: the review-failure decision', () => {
  const line = () => lineWith('foreman decide add', 'could not pass review');

  it('has a summary and a recommendation', () => {
    expect(line()).toContain('--summary ');
    expect(line()).toContain('--recommend "');
  });

  it('single-quotes the pasted summary and body', () => {
    expect(line()).toMatch(/--summary '</);
    expect(line()).toMatch(/--body '</);
  });

  it('keeps the three options in order, each with a hint', () => {
    expect(optionsOf(line())).toEqual(['Retry with a note to the architect', "I'll take it", 'Drop']);
    expect(count(line(), '--hint ')).toBe(count(line(), '--option '));
  });

  const storyParagraph = () =>
    skillFile('failed.md')
      .split(/\n\s*\n/)
      .find((p) => p.includes('cause: "story"'));
  const CORRECTED = '"after the architect corrected"';
  const FIX_ROUND = '"in a fix round after review"';
  const correctedSlice = (p) => p.slice(p.indexOf(CORRECTED), p.indexOf(FIX_ROUND));
  const fixRoundSlice = (p) => p.slice(p.indexOf(FIX_ROUND));

  it("recommends I'll take it when the pipeline failed because the story cannot hold", () => {
    const paragraph = storyParagraph();
    expect(paragraph).toBeDefined();
    expect(correctedSlice(paragraph)).toContain('--recommend "I\'ll take it"');
    expect(paragraph).toContain('--summary');
    expect(paragraph).toContain('plain words');
    expect(paragraph).toContain('Done-when');
    expect(paragraph).not.toContain('foreman decide add');
    expect(paragraph).not.toMatch(/\(step \d/);
    expect(line()).toContain('--title "<ID> could not pass review"');
  });

  it("recommends I'll take it only after the architect corrected the story", () => {
    const paragraph = storyParagraph();
    expect(paragraph).toContain(CORRECTED);
    const corrected = collapse(correctedSlice(paragraph));
    expect(corrected).toContain('--recommend "I\'ll take it"');
    expect(corrected).toContain('already had one go');
    expect(corrected).not.toContain('--recommend "Retry with a note to the architect"');
  });

  it('recommends a retry when the builder found it in a fix round after review', () => {
    const paragraph = storyParagraph();
    expect(paragraph).toContain(FIX_ROUND);
    expect(paragraph.indexOf(FIX_ROUND)).toBeGreaterThan(paragraph.indexOf(CORRECTED));
    const fixRound = collapse(fixRoundSlice(paragraph));
    expect(fixRound).toContain('--recommend "Retry with a note to the architect"');
    expect(fixRound).toContain('Note for the architect');
    expect(fixRound).not.toContain('already had one go');
    expect(fixRound).not.toContain('already corrected');
    expect(fixRound).not.toContain('even after the architect corrected');
  });

  it('keys the two cases on the reasons the pipeline writes', () => {
    const pipeline = readFileSync(new URL('../plugin/workflows/pipeline.js', import.meta.url), 'utf8');
    expect(pipeline).toContain('after the architect corrected');
    expect(pipeline).toContain('in a fix round after review');
  });
});

describe('story skill: the nothing-to-build decision', () => {
  const line = () => lineWith('foreman decide add', 'Close <ID>: nothing to build?');

  it('has a summary, two options with a hint each, and recommends closing', () => {
    expect(line()).toContain('--summary ');
    expect(optionsOf(line())).toEqual(['Close it as Done', 'Build it anyway']);
    expect(count(line(), '--hint ')).toBe(2);
    expect(line()).toContain('--recommend "Close it as Done"');
  });

  it('single-quotes the architect\'s reason', () => {
    expect(line()).toMatch(/--summary '</);
    expect(line()).toMatch(/--body '</);
  });

  it('is applied in the owner\'s answers by closing or reopening the story', () => {
    const answers = answersFile();
    expect(answers).toContain('Close <ID>: nothing to build?');
    expect(answers).toContain('foreman story done <ID> --note');
    expect(answers).toContain("foreman story todo <ID> --note 'Note for the architect");
    const rule = answers.slice(answers.indexOf('Close <ID>: nothing to build?'), answers.indexOf('Decide for <ID>:'));
    expect(rule).toContain("foreman story done <ID> --note 'Closed by the owner");
    expect(rule).not.toMatch(/--note "/);
  });
});

describe('story skill: the architect\'s own question', () => {
  it('turns owner_question into a decision in the blocked step', () => {
    const file = skillFile('blocked.md');
    expect(file.indexOf('- **`blocked`**')).toBeGreaterThan(-1);
    const blocked = file.slice(file.indexOf('- **`blocked`**'));
    expect(blocked).toContain('owner_question');
    expect(blocked).toContain('Decide for <ID>:');
  });

  it('single-quotes everything it pastes from the architect', () => {
    const line = lineWith('foreman decide add', 'Decide for <ID>:');
    expect(line).toContain("--title 'Decide for <ID>: <owner_question.summary>'");
    expect(line).toMatch(/--summary '</);
    expect(line).toMatch(/--body '</);
    expect(line).toMatch(/--recommend '</);
    expect(line).not.toMatch(/"/);
  });

  it('says once that pasted text goes in single quotes', () => {
    expect(text).toMatch(/single quotes/);
    expect(text).toContain("'\\''");
    expect(allText().split('so the shell never expands it')).toHaveLength(2);
  });

  it('applies the answer by sending the choice to the architect', () => {
    const answers = answersFile();
    const rule = answers.slice(answers.indexOf('Decide for <ID>:'));
    expect(answers).toContain('Decide for <ID>:');
    expect(rule).toContain('Note for the architect');
    expect(rule).toContain('foreman decide applied <item id>');
    expect(rule).toContain(`--note 'Note for the architect: the owner answered "<the title of the item>" with "<the option from the answer>".`);
    expect(rule).not.toContain('the owner chose');
  });

  it('the Decide for note reads the same whoever applies it', async () => {
    const rule = collapse(answersFile());
    const start = rule.indexOf('An answered item titled `Decide for <ID>:');
    expect(start).toBeGreaterThan(-1);
    const template = /--note '([^']*)'/.exec(rule.slice(start))[1];
    const filled = template
      .replace('<the title of the item>', 'Decide for ACME-2: Which store?')
      .replace('<the option from the answer>', 'The cache')
      .replace('< the note from the answer, when given>', ' Speed matters');
    const calls = [];
    const foreman = async (args) => { calls.push(args); return { status: 0, stdout: '' }; };
    const item = {
      id: 'd-1', kind: 'decision', story: 'ACME-2', title: 'Decide for ACME-2: Which store?', options: ['The cache', 'The database'],
      answer: { option: 'The cache', note: 'Speed matters' },
    };
    await applyAnswers([item], { foreman, gh: async () => ({ status: 0, stdout: '' }), git: async () => ({ status: 0, stdout: '' }), canRequeue: () => true });
    const todo = calls.find((a) => a[0] === 'story' && a[1] === 'todo');
    expect(todo).toBeTruthy();
    expect(todo[todo.indexOf('--note') + 1]).toBe(filled);
  });

  // The paragraph and bullets for an answered item whose kind is task, up to the supervisor's paragraph.
  const TASK_START = 'An answered item whose `kind` is `task`';
  const taskRule = () => {
    const answers = answersFile();
    const start = answers.indexOf(TASK_START);
    expect(start).toBeGreaterThan(-1);
    return collapse(answers.slice(start, answers.indexOf('The supervisor also applies')));
  };

  it('applies an owner task by Retry the story or Close the task', () => {
    const answers = answersFile();
    expect(answers).toContain('Retry the story');
    expect(answers).toContain('Close the task');
    const rule = taskRule();
    expect(rule).toContain('whatever its `story`');
    const close = rule.slice(rule.indexOf('**"Close the task"**'));
    expect(close).toContain('change nothing on the story');
    expect(close).toContain('even when it is blocked');
    expect(close).toContain('`foreman decide applied <item id>`');
    expect(close).not.toContain('foreman story todo');
    expect(close).toContain('answered only in words');
    expect(answers.indexOf(TASK_START)).toBeGreaterThan(answers.indexOf('Decide for <ID>: <question>'));
    expect(answers.indexOf(TASK_START)).toBeLessThan(answers.indexOf('The supervisor also applies'));
  });

  it('the task Retry note reads the same whoever applies it', async () => {
    const rule = taskRule();
    const template = /--note '([^']*)'/.exec(rule.slice(rule.indexOf('**"Retry the story"**')))[1];
    const filled = template
      .replace('<the title of the item>', 'ACME-1: which store?')
      .replace('< the note from the answer, when given>', ' use it');
    const calls = [];
    const foreman = async (args) => { calls.push(args); return { status: 0, stdout: '' }; };
    const item = {
      id: 'd-1', kind: 'task', story: 'ACME-1', title: 'ACME-1: which store?', options: ['Retry the story', 'Close the task'],
      answer: { option: 'Retry the story', note: 'use it' },
    };
    await applyAnswers([item], { foreman, gh: async () => ({ status: 0, stdout: '' }), git: async () => ({ status: 0, stdout: '' }), canRequeue: () => true });
    const todo = calls.find((a) => a[0] === 'story' && a[1] === 'todo');
    expect(todo).toBeTruthy();
    expect(todo[todo.indexOf('--note') + 1]).toBe(filled);
  });

  it('says the supervisor counts a task only when answered Retry the story, and clears a closed one', () => {
    const answers = collapse(answersFile());
    const para = answers.slice(answers.indexOf('The supervisor also applies'));
    expect(para).toContain('tasks count only when answered "Retry the story"');
    expect(para).toContain('marks a closed task applied whatever its story');
  });

  it('tells the blocked step to give a task no --option', () => {
    const blocked = collapse(skillFile('blocked.md'));
    expect(blocked).toContain('Give a task no `--option`');
    expect(blocked).toContain('every task offers "Retry the story" and "Close the task"');
    expect(blocked).not.toContain('free-text task');
  });

  it('tells a session to leave out the body\'s last full stop when a note is given', () => {
    const answers = answersFile();
    const rule = collapse(answers.slice(answers.indexOf('Close <ID>: nothing to build?'), answers.indexOf('Decide for <ID>:')));
    expect(rule).toContain('leave that one full stop out');
  });
});

describe('story skill: text the owner must supply and the answers', () => {
  it('single-quotes the owner-supply task title', () => {
    const line = lineWith('foreman decide add', '--kind task', 'what the owner must supply');
    expect(line).toContain("--title '<what the owner must supply>'");
    expect(line).not.toContain('"');
  });

  it('holds no apostrophe in any placeholder of the owner\'s answers', () => {
    const answers = answersFile();
    const withApostrophe = [...answers.matchAll(/<[^<>]*>/g)].map((m) => m[0]).filter((s) => s.includes("'"));
    expect(withApostrophe).toEqual([]);
    expect(answers).toContain('<the note from the answer>');
    expect(answers).toContain('<the body of the item>');
  });
});

describe('story skill: the deletes decision', () => {
  const line = () => lineWith('foreman decide add', 'Allow deletes for <ID>?');

  it('asks once, with the two options, a hint each, and single-quoted summary and body', () => {
    expect(optionsOf(line())).toEqual(['Allow the deletes', 'Keep them out']);
    expect(count(line(), '--hint ')).toBe(2);
    expect(line()).toMatch(/--summary '</);
    expect(line()).toMatch(/--body '</);
  });

  it('handles ship exit 10 in step 5, sending a keepOut through a fix round', () => {
    const step5 = skillFile('ship-deletes.md');
    const bullet = step5.slice(step5.indexOf('- **10**'));
    expect(step5).toContain('- **10**');
    expect(bullet).toContain('keepOut');
    expect(bullet).toContain('fix round');
    expect(bullet).toContain('no metadata deletes');
    expect(bullet).toContain('Waiting for the owner to allow deletes');
  });

  it('is applied in the owner\'s answers with foreman sf deletes', () => {
    const answers = answersFile();
    expect(answers).toContain('Allow deletes for <ID>?');
    expect(answers).toContain('foreman sf deletes allow <ID>');
    expect(answers).toContain('foreman sf deletes keep-out <ID>');
    const rule = answers.slice(answers.indexOf('Allow deletes for <ID>?'));
    expect(rule).toContain("foreman story todo <ID> --note 'The owner allowed the deletes.");
    expect(rule).toContain("foreman story todo <ID> --note 'Note for the architect: the owner wants nothing deleted in this story; keep every delete out.");
    expect(rule).toContain('foreman decide applied <item id>');
  });

  it('adds the manual steps to the done note in step 6', () => {
    const step6 = section(text, '## 6. Close the story');
    expect(step6).toContain('manualSteps');
    expect(step6).toContain('Manual steps: ');
  });
});

describe('story skill: a failed Salesforce validation', () => {
  // Ship exit 2, from its bullet to the end of its file.
  const exit2Of = () => {
    const ci = skillFile('ship-ci.md');
    expect(ci.indexOf('- **2**')).toBeGreaterThan(-1);
    return ci.slice(ci.indexOf('- **2**'));
  };

  it('blocks an inherited validation failure under exit 2 before the fix-round bullet, sending nothing to the builder', () => {
    const exit2 = exit2Of();
    const at = exit2.indexOf('`inherited: true`');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(exit2.indexOf('The JSON\'s `stage` is `sf-validate`'));
    const bullet = exit2.slice(at, exit2.indexOf('The JSON\'s `stage` is `sf-validate`'));
    expect(bullet).toContain('send nothing to the builder');
    expect(bullet).toContain('foreman story block <ID>');
    expect(bullet).toContain('foreman decide add --story <ID> --kind task');
    expect(bullet).toContain('cannot pass its own tests');
    expect(bullet).toContain('`blocked`');
    expect(bullet).not.toContain('fix round');
  });

  it("pastes the inherited reason and ship JSON in single quotes, each ' written as '\\''", () => {
    const exit2 = exit2Of();
    const bullet = exit2.slice(exit2.indexOf('`inherited: true`'), exit2.indexOf('The JSON\'s `stage` is `sf-validate`'));
    expect(bullet).toContain("--reason '<the reason>'");
    expect(bullet).toContain("--body '<the ship JSON line>'");
    expect(bullet).toContain("'\\''");
    expect(bullet).not.toContain('--reason "');
  });

  it("pastes a halted release's ship JSON with each ' written as '\\''", () => {
    const release = skillFile('ship-stopped.md');
    const start = release.indexOf('\n- **4 or 5**');
    expect(start).toBeGreaterThan(-1);
    const rest = release.slice(start + 1);
    const bullet = rest.slice(0, rest.slice(1).search(/\n- \*\*/) + 1);
    expect(bullet).toContain("--body '<the ship JSON line>'");
    expect(bullet).toContain("'\\''");
  });

  it("keeps an inherited reason whole through sh once each ' is written as '\\''", () => {
    const reason = "The Salesforce validation on acme-qa failed only in what acme-qa already fails before this story (AcmeServiceTest.sumsTheOrder): not this story's change. `x` $(echo hi)";
    const escaped = reason.replaceAll("'", "'\\''");
    const ok = spawnSync('sh', ['-c', `printf %s '${escaped}'`], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(reason);
    const raw = spawnSync('sh', ['-c', `printf %s '${reason}'`], { encoding: 'utf8' });
    expect(raw.status !== 0 || raw.stdout !== reason).toBe(true);
  });

  it('sends the failures from sf-validate through one fix round under exit 2', () => {
    const exit2 = exit2Of();
    expect(exit2).toContain('`sf-validate`');
    expect(exit2).toContain('`failures`');
    expect(exit2).toContain('{kind, name, message}');
    const bullet = exit2.slice(exit2.indexOf('`sf-validate`'));
    expect(bullet).toContain('blocker');
    expect(bullet).toContain('fix round');
    expect(bullet).toContain('foreman checks --changed');
    expect(bullet).toContain('failed path');
  });
});

describe('story skill: findings from every round', () => {
  it('says how a result and its history go into the findings file', () => {
    const files = section(text, '### The files this run keeps');
    expect(files).toContain('history');
    expect(files).toContain('"round"');
    expect(files).toContain('"resolved": true');
  });

  // The bullet's raw text, from its marker to the next bullet.
  const rawBullet = (from, marker, next) => {
    expect(from.indexOf(marker), marker).toBeGreaterThan(-1);
    return from.slice(from.indexOf(marker), next ? from.indexOf(next, from.indexOf(marker)) : undefined);
  };

  // The whole bullet, from its marker to the next bullet, with each run of whitespace
  // collapsed to one space, so a phrase reads the same wherever the lines wrap. It must
  // name the findings file.
  const findingsBullet = (from, marker, next) => {
    const bullet = rawBullet(from, marker, next).replace(/\s+/g, ' ');
    expect(bullet, marker).toContain('findings file');
    return bullet;
  };

  // Step 3's failed bullet ends at the next blank line or heading.
  const failedBullet = (step3) => {
    const at = step3.indexOf('- **`failed`**');
    expect(at, 'failed bullet').toBeGreaterThan(-1);
    const end = step3.slice(at).search(/\n\s*\n|\n#/);
    return step3.slice(at, end === -1 ? undefined : at + end);
  };

  it("adds the history in step 3's passed and failed results", () => {
    const step3 = section(text, '## 3. Run the pipeline');
    expect(findingsBullet(step3, '- **`passed`**', '- **`blocked`**')).toContain('history');
    const failed = failedBullet(step3).replace(/\s+/g, ' ');
    expect(failed).toContain('findings file');
    expect(failed).toContain('history');
  });

  it("adds the history in a fix round's passed and failed results", () => {
    const round = skillFile('fix-round.md');
    expect(findingsBullet(round, '- `passed`', '- `deferred`')).toContain('history');
    expect(findingsBullet(round, '- `failed`', '\n\n')).toContain('history');
  });

  it("says the passed result's findings are all minor", () => {
    const step3 = section(text, '## 3. Run the pipeline');
    expect(findingsBullet(step3, '- **`passed`**', '- **`blocked`**')).toContain('(all minor)');
  });

  it("keeps step 3's passed and failed bullets inside the wrap width", () => {
    const step3 = section(text, '## 3. Run the pipeline');
    const bullets = [
      rawBullet(step3, '- **`passed`**', '- **`blocked`**'),
      failedBullet(step3),
    ];
    for (const bullet of bullets) {
      for (const line of bullet.split('\n')) expect(line.length, line).toBeLessThanOrEqual(92);
    }
  });
});

describe('story skill: explaining a decision', () => {
  const explaining = () => skillFile('decisions.md');
  const LABELS = ['What this story is for', 'What happened', 'Is anything damaged?', 'Your options', 'Recommendation'];

  it('is read before step 1', () => {
    expect(explaining()).toMatch(/^# Explaining a decision\n/);
    const pointer = text.indexOf('${CLAUDE_SKILL_DIR}/decisions.md');
    expect(pointer).toBeGreaterThan(-1);
    expect(pointer).toBeLessThan(text.indexOf('## 1. Before you start'));
  });

  it('names the five parts, their flags, and keeps the detail in the body', () => {
    const part = explaining();
    for (const label of LABELS) expect(part, label).toContain(label);
    for (const flag of ['--purpose', '--happened', '--damage', '--recommendation', '--hint', '--recommend']) expect(part, flag).toContain(flag);
    expect(part).toMatch(/no file paths/i);
    expect(part).toMatch(/variable names/);
    expect(part).toContain('280');
    expect(part).toContain('--body');
    expect(part).toContain('Details');
    expect(part).toContain('warning:');
    expect(part).toMatch(/single quotes/);
  });

  // The example's lines: each labelled part, and the option lines under Your options.
  const example = () => {
    const rows = explaining().split('\n').map((l) => l.trim());
    const after = (label) => {
      const row = rows.filter((l) => l.startsWith(label));
      expect(row, label).toHaveLength(1);
      return row[0].slice(label.length).trim();
    };
    const options = rows.filter((l) => /^- (Retry with a note to the architect|I'll take it|Drop): /.test(l));
    return {
      purpose: after('What this story is for:'),
      happened: after('What happened:'),
      damage: after('Is anything damaged?'),
      options,
      recommendation: after('Recommendation:'),
      yourOptions: rows.filter((l) => l === 'Your options:'),
    };
  };

  it('rewrites the review failure of ACME-12 as a labelled example', () => {
    const part = explaining();
    expect(part).toContain('ACME-12');
    expect(part).toContain("Keep the factory's own keys out of story workspaces");
    const block = part.slice(part.indexOf('ACME-12'), part.indexOf('The technical finding'));
    expect(block).toContain('Recommendation:');
    expect(block).not.toContain('foreman decide add');
    const ex = example();
    expect(ex.yourOptions).toHaveLength(1);
    expect(ex.options.map((l) => l.slice(2, l.indexOf(': ')))).toEqual(['Retry with a note to the architect', "I'll take it", 'Drop']);
    expect(ex.damage).toMatch(/^No\b/);
    expect(ex.recommendation).toMatch(/^Retry with a note to the architect: /);
    const hints = ex.options.map((l) => l.slice(l.indexOf(': ') + 2));
    for (const t of [ex.purpose, ex.happened, ex.damage, ex.recommendation]) expect(t.length, t).toBeLessThanOrEqual(280);
    for (const h of hints) expect(h.length, h).toBeLessThanOrEqual(100);
    expect(explainProblems({ purpose: ex.purpose, happened: ex.happened, damage: ex.damage, recommendation: ex.recommendation })).toEqual([]);
    for (const h of hints) expect(explainProblems({ happened: h }), h).toEqual([]);
    expect(part).toMatch(/technical finding[^\n]*body[^\n]*Details|technical finding[\s\S]{0,120}under Details/);
  });

  const DECISIONS = {
    review: ['could not pass review'],
    'nothing to build': ['Close <ID>: nothing to build?'],
    'Decide for': ['Decide for <ID>:'],
    depends_on: ['Add depends_on:'],
    deletes: ['Allow deletes for <ID>?'],
  };
  for (const [name, marks] of Object.entries(DECISIONS)) {
    it(`the ${name} decision carries the explanation and a hint per option`, () => {
      const line = lineWith('foreman decide add', ...marks);
      for (const flag of ["--purpose '", "--happened '", "--recommendation '", '--recommend ']) expect(line, flag).toContain(flag);
      expect(count(line, '--hint '), 'hints').toBe(count(line, '--option '));
      expect(count(line, '--hint ')).toBeGreaterThan(0);
    });
  }

  it('the review failure asks about damage and its summary is in plain words', () => {
    const line = lineWith('foreman decide add', 'could not pass review');
    expect(line).toContain("--damage '");
    expect(line).toContain("--summary '<what happened, in plain words, one line, at most 160 characters>'");
    expect(line).toMatch(/--body '<[^']*draft PR url[^']*>'/);
    const failed = skillFile('failed.md');
    expect(failed).toMatch(/leave `--damage` out/i);
  });

  it('the Decide for decision takes the architect\'s explanation, with no double quote', () => {
    const line = lineWith('foreman decide add', 'Decide for <ID>:');
    expect(line).toContain("--purpose '<owner_question.explain.purpose");
    expect(line).toContain("--happened '<owner_question.explain.happened");
    expect(line).toContain("--damage '<owner_question.explain.damage>'");
    expect(line).toContain("--recommendation '<owner_question.explain.recommendation");
    expect(line).not.toMatch(/"/);
  });

  it('the depends_on proposal says what Apply and Ignore do, with a summary and body', () => {
    const line = lineWith('foreman decide add', 'Add depends_on:');
    expect(optionsOf(line)).toEqual(['Apply', 'Ignore']);
    expect(line).toContain("--summary '");
    expect(line).toContain("--body '");
    expect(line).toContain('--recommend "Apply"');
    expect(count(line, "--hint '")).toBe(2);
  });

  it('the deletes decision recommends one of its options', () => {
    const line = lineWith('foreman decide add', 'Allow deletes for <ID>?');
    expect(line).toMatch(/--recommend '<Allow the deletes[^']*Keep them out>'/);
  });
});

describe("story skill: the project's own Foreman files", () => {
  it('"Where you are" says they belong to the owner and Foreman checks go in a scratch repo', () => {
    expect(section(text, '## Where you are')).toContain('${CLAUDE_SKILL_DIR}/owner-files.md');
    expect(section(text, '## Where you are')).not.toMatch(/unset FOREMAN_RUN|variables removed/);
    const where = skillFile('owner-files.md');
    expect(where).toContain('foreman.config.json');
    expect(where).toContain('.env.foreman');
    expect(where).toContain('scratch git repo');
    expect(where).toContain('(cd "$scratch" && foreman settings set workers 1)');
    expect(where).toMatch(/never unset or change/i);
    expect(where).not.toMatch(/unset FOREMAN_RUN|variables removed/);
    expect(where.replace(/\s+/g, ' ')).toContain('every other Foreman command (decide, story, stage, lock, learn and the rest) run inside a scratch repo acts on that repo');
  });
});

describe('story skill: conflicts at release', () => {
  // A bullet of step 5, from its "- **<code>**" line to the next bullet at that level.
  function exitBullet(code) {
    const release = skillFile(code === 6 ? 'ship-conflict.md' : 'ship-stopped.md');
    const start = release.indexOf(`\n- **${code}**`);
    expect(start, `exit ${code}`).toBeGreaterThan(-1);
    const rest = release.slice(start + 1);
    const next = rest.slice(1).search(/\n- \*\*/);
    return (next === -1 ? rest : rest.slice(0, next + 1)).replace(/\s+/g, ' ');
  }

  it('gives each exit 6 a fix round, then checks, a new commit and ship again, up to the rounds setting', () => {
    const six = exitBullet(6);
    expect(six).toContain('`foreman settings get rounds`');
    expect(six).toMatch(/[Ee]ach exit 6 gets a fix round/);
    expect(six).toContain('`foreman checks --changed`');
    expect(six).toMatch(/new commit/);
    expect(six).toContain('`foreman ship --story <ID>`');
    expect(six).not.toContain('A second exit 6 takes the failed path');
  });

  it('keeps the conflict-only merge finding', () => {
    expect(exitBullet(6)).toContain('"merge"');
    expect(exitBullet(6)).toContain("keeping both sides' intent");
  });

  it('names the three ways to the failed path', () => {
    const six = exitBullet(6);
    expect(six).toContain('the failed path');
    expect(six).toMatch(/fix round returns `failed`/);
    expect(six).toMatch(/`foreman checks --changed` fails after the round/);
    expect(six).toMatch(/exit 6 comes back after the last allowed round/);
  });

  it('says main moving without a conflict never counts as a round', () => {
    expect(exitBullet(6)).toMatch(/without a conflict .*never counts as a round/);
  });

  it('ships once more when main kept moving at mergeable-recheck, then blocks the story', () => {
    const one = exitBullet(1);
    expect(one).toContain('`mergeable-recheck`');
    expect(one).toMatch(/run `foreman ship --story <ID>` once more/);
    expect(one).toContain("foreman story block <ID> --reason '");
    expect(one).toMatch(/costs no round/);
  });

  it('gives conflicts the rounds limit in the fix-round section, not a single round', () => {
    const round = skillFile('fix-round.md').replace(/\s+/g, ' ');
    expect(round).not.toContain('a second conflict');
    expect(round).toContain('Each cause gets one fix round');
    expect(round).toMatch(/[Cc]onflicts with `<base>` get up to `rounds` rounds, as `ship-conflict.md` says/);
  });
});

describe('story skill: the commit reuses the tester\'s run of the same tree', () => {
  // A record made under the session env is the same run for every agent of the session, so the
  // commit step prints the tester's run of an unchanged tree and runs the checks when anything
  // changed since (a fix round, a regenerated file). Only a passing result for the exact tree
  // lets a story be committed.
  it('runs foreman checks --changed --reuse in step 4, started and collected, then again the same way', () => {
    const step4 = section(text, '## 4. Commit').replace(/\s+/g, ' ');
    expect(step4.split('`foreman checks --changed --reuse --start`').length - 1).toBe(1);
    expect(step4).toContain('then `foreman checks --wait <id>` until it prints the result');
    expect(step4).toContain('Then run the checks again the same way');
    expect(step4).toContain('never committed without a passing full-suite result for its exact tree');
    expect(step4).not.toContain('Do not add `--reuse`');
    expect(step4).not.toMatch(/agents cannot write/);
    expect(step4).toContain("a story is not committed on a stage's word");
    expect(step4).toContain("Never run a check's command by hand or background it to a file");
  });

  // Across every file of the skill: the fix round, CI, merge-main, conflict and deletes paths
  // keep a plain `foreman checks --changed`, so each re-check after a fix runs fresh.
  it("names --reuse only in step 4, so every re-check after a fix runs the checks", () => {
    const flat = allText();
    expect(flat.split('--reuse').length - 1).toBe(section(text, '## 4. Commit').split('--reuse').length - 1);
    expect(section(text, '## 4. Commit')).toContain('`--reuse` prints the tester');
    for (const file of ['fix-round.md', 'failed.md', 'ship-ci.md', 'ship-conflict.md', 'ship-deletes.md', 'ship-stopped.md', 'modes.md']) {
      expect(skillFile(file)).not.toContain('--reuse');
    }
  });
});

describe('story skill: the release decision', () => {
  it('applies "<ID> could not be released" with the note the supervisor writes', () => {
    const answers = answersFile();
    expect(answers).toContain('could not be released');
    expect(answers).toContain('"Retry the release"');
    expect(answers).toContain(RELEASE_RETRY_NOTE);
  });
});
