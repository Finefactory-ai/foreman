// The checks every story source must pass. A source's own test file calls
// storySourceContract({ name, make }) to register them. `make()` builds a fresh, empty
// source and returns { source, addStory(frontmatterObj, body?), progressHeading?,
// ownerTaskTitle, dependsOnLine(ids), id(n) }: `addStory` puts one story into it using the source's
// own storage; `ownerTaskTitle` is a title this source treats as an owner task;
// `id(n)` makes the nth story id in this source's id pattern;
// `dependsOnLine(ids)` gives the extra frontmatter that makes a story depend on those ids.
// Passing `keepsFiles: true` says the source keeps status outside the story files, which
// must then never change. Passing `creates: true` says the source has the optional
// `create({ title, what, doneWhen, dependsOn, origin, priority? }) -> { id, path }`, and runs its
// checks. `priority` is an optional priority name (Foreman sends "Low" for the follow-ups it
// creates by itself); a source without priorities ignores it.
//
// Passing `notes: true` says the source has the optional `note(id, { kind, title, summary, text })
// -> boolean` (the story note engine/story-notes.mjs posts): true for a known story, false for an
// unknown id, and it never throws.
//
// A story may also carry `followUpOf`, a string: the id of the story it follows up ('' or absent
// for none). When a source has it, a story made by create() with an origin carries that origin.
// A source may also have an optional `followUpOf(id) -> string`: the origin of any one story by
// id, even one list() leaves out ('' for none).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const STATUSES = ['todo', 'in-progress', 'blocked', 'ready-to-promote', 'done', 'retired'];

export function storySourceContract({ name, make, keepsFiles = false, creates = false, notes = false }) {
  describe(`story source contract: ${name}`, () => {
    const fresh = () => {
      const fx = make();
      const id = fx.id ?? ((n) => `C-${n}`);
      fx.addStory({ id: id(1), title: 'First', status: 'todo' }, `# ${id(1)}\n`);
      fx.addStory({ id: id(2), title: 'Second', status: 'todo' }, `# ${id(2)}\n`);
      return { ...fx, id };
    };

    it('lists valid stories', () => {
      const { source, id } = fresh();
      const stories = source.list();
      expect(stories.map((s) => s.id).sort()).toEqual([id(1), id(2)]);
      for (const s of stories) {
        expect(STATUSES).toContain(s.status);
        expect(typeof s.title).toBe('string');
        expect(Array.isArray(s.dependsOn)).toBe(true);
        expect(Array.isArray(s.resources)).toBe(true);
        expect(typeof s.ownerTask).toBe('boolean');
        expect(typeof s.order).toBe('number');
        for (const k of ['id', 'ref', 'group', 'groupName', 'blockedBy']) expect(typeof s[k]).toBe('string');
        if (s.followUpOf !== undefined) expect(typeof s.followUpOf).toBe('string');
      }
    });

    it('detects owner tasks by their title', () => {
      const { source, addStory, ownerTaskTitle, id } = fresh();
      addStory({ id: id(3), title: ownerTaskTitle, status: 'todo' });
      const byId = Object.fromEntries(source.list().map((s) => [s.id, s.ownerTask]));
      expect(byId).toEqual({ [id(1)]: false, [id(2)]: false, [id(3)]: true });
    });

    it('parses dependsOn from a frontmatter list', () => {
      const { source, addStory, dependsOnLine, id } = fresh();
      addStory({ id: id(3), title: 'Third', status: 'todo', ...dependsOnLine([id(1), id(2)]) });
      expect(source.list().find((s) => s.id === id(3)).dependsOn).toEqual([id(1), id(2)]);
    });

    it('update with a status changes what list returns', () => {
      const { source, id } = fresh();
      expect(source.update(id(1), { status: 'done' })).toBe(true);
      const byId = Object.fromEntries(source.list().map((s) => [s.id, s.status]));
      expect(byId).toEqual({ [id(1)]: 'done', [id(2)]: 'todo' });
    });

    it('update with ready-to-promote changes what list returns', () => {
      const { source, id } = fresh();
      expect(source.update(id(1), { status: 'ready-to-promote', note: 'ready to promote: click Promote', event: 'parked' })).toBe(true);
      const byId = Object.fromEntries(source.list().map((s) => [s.id, s.status]));
      expect(byId).toEqual({ [id(1)]: 'ready-to-promote', [id(2)]: 'todo' });
      expect(byId[id(1)]).not.toBe('done');
    });

    it('update with a blocked status and reason changes what list returns', () => {
      const { source, id } = fresh();
      expect(source.update(id(2), { status: 'blocked', fields: { blockedBy: 'needs a key' } })).toBe(true);
      expect(source.list().find((s) => s.id === id(2))).toMatchObject({ status: 'blocked', blockedBy: 'needs a key' });
      expect(source.list().find((s) => s.id === id(1))).toMatchObject({ status: 'todo', blockedBy: '' });
    });

    it('update with a note adds exactly one dated line under the progress heading', () => {
      const { source, id, progressHeading = '## Progress notes' } = fresh();
      expect(source.update(id(1), { note: 'Did a thing.' })).toBe(true);
      const lines = readFileSync(source.brief(id(1)).path, 'utf8').split('\n');
      const heading = lines.indexOf(progressHeading);
      expect(heading).toBeGreaterThan(-1);
      const dated = lines.filter((l) => /^- \*\*\d{4}-\d{2}-\d{2}\*\* — /.test(l));
      expect(dated).toHaveLength(1);
      expect(lines.indexOf(dated[0])).toBeGreaterThan(heading);
      expect(dated[0]).toMatch(/Did a thing\.$/);
    });

    it('brief returns a readable path', () => {
      const { source, id } = fresh();
      const brief = source.brief(id(2));
      expect(readFileSync(brief.path, 'utf8')).toContain(id(2));
    });

    if (keepsFiles) {
      it('leaves the story files byte for byte', () => {
        const fx = fresh();
        const files = fx.source.list().map((s) => s.ref);
        const before = files.map((f) => readFileSync(f));
        fx.source.update(fx.id(1), { status: 'blocked', fields: { blockedBy: 'x', started: '2026-10-15' }, note: 'Blocked: x' });
        fx.source.update(fx.id(2), { status: 'done', note: 'Done.' });
        fx.source.brief(fx.id(1));
        expect(files.map((f) => readFileSync(f))).toEqual(before);
      });
    }

    if (creates) {
      describe('create (optional)', () => {
        const make1 = (source, id, extra = {}) =>
          source.create({ title: 'Follow-ups', what: '- fix the thing', doneWhen: 'The thing is fixed.', dependsOn: [id(2)], origin: id(1), ...extra });

        it('creates a todo story that list then shows, with its id in the id pattern', () => {
          const { source, id } = fresh();
          const made = make1(source, id);
          expect(new RegExp(`^(?:${source.idPattern})$`).test(made.id)).toBe(true);
          const story = source.list().find((s) => s.id === made.id);
          expect(story).toMatchObject({ id: made.id, title: 'Follow-ups', status: 'todo', dependsOn: [id(2)] });
          expect(source.list()).toHaveLength(3);
          if (story.followUpOf !== undefined) expect(story.followUpOf).toBe(id(1));
        });

        it('brief shows what to do and when it is done', () => {
          const { source, id } = fresh();
          const made = make1(source, id);
          const text = readFileSync(source.brief(made.id).path, 'utf8');
          expect(readFileSync(made.path, 'utf8')).toBe(text);
          for (const part of [made.id, '- fix the thing', 'The thing is fixed.']) expect(text).toContain(part);
        });

        it('gives each new story its own id', () => {
          const { source, id } = fresh();
          const a = make1(source, id);
          const b = make1(source, id, { dependsOn: [] });
          expect(a.id).not.toBe(b.id);
          expect(source.list().find((s) => s.id === b.id).dependsOn).toEqual([]);
        });

        it('update works on a created story', () => {
          const { source, id } = fresh();
          const made = make1(source, id);
          expect(source.update(made.id, { status: 'blocked', fields: { blockedBy: 'x' } })).toBe(true);
          expect(source.list().find((s) => s.id === made.id)).toMatchObject({ status: 'blocked', blockedBy: 'x' });
        });

        if (keepsFiles) {
          it('leaves the existing story files byte for byte', () => {
            const fx = fresh();
            const files = fx.source.list().map((s) => s.ref);
            const before = files.map((f) => readFileSync(f));
            make1(fx.source, fx.id);
            expect(files.map((f) => readFileSync(f))).toEqual(before);
          });
        }
      });
    }

    if (notes) {
      describe('note (optional)', () => {
        const NOTE = { kind: 'design', title: 'design', summary: 'The architect chose the developer builder.', text: 'It changes the one file.\n\nAt 2026-10-31 14:05 UTC.' };
        it('is true for a known story and false for an unknown id', () => {
          const { source, id } = fresh();
          expect(source.note(id(1), NOTE)).toBe(true);
          expect(source.note(`${id(9)}9`, NOTE)).toBe(false);
        });

        it('never throws, whatever it is given', () => {
          const { source, id } = fresh();
          expect(() => source.note(id(1), {})).not.toThrow();
          expect(() => source.note(id(1))).not.toThrow();
        });
      });
    }

    it('returns false or null for an unknown id', () => {
      const { source, id } = fresh();
      expect(source.update(`${id(9)}9`, { status: 'done' })).toBe(false);
      expect(source.brief(`${id(9)}9`)).toBeNull();
    });
  });
}
