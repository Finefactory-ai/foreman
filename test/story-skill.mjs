// The story skill's files, for the doc tests. SKILL.md holds the main path; each rare path
// sits in its own file next to it, read by the session only when that path happens.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = fileURLToPath(new URL('../plugin/skills/story/', import.meta.url));

export const RARE = [
  'answers.md',
  'blocked.md',
  'decisions.md',
  'deferred.md',
  'failed.md',
  'fix-round.md',
  'modes.md',
  'owner-files.md',
  'ship-ci.md',
  'ship-conflict.md',
  'ship-deletes.md',
  'ship-stopped.md',
  'rethink.md',
  'resume.md',
];

export const skillFile = (name = 'SKILL.md') => readFileSync(`${SKILL_DIR}${name}`, 'utf8');

// SKILL.md then every rare file, as one text.
export const allText = () => ['SKILL.md', ...RARE].map((name) => skillFile(name)).join('\n\n');
