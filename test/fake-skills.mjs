// A made-up skills repository for tests, shaped like the Salesforce skills repository: each
// skill is skills/<name>/SKILL.md plus any other files. Git runs with no global or system
// config, so a developer's hooks, signing or identity never change a result. Automatic
// maintenance and gc are off: a commit otherwise starts `git maintenance run --auto --detach`,
// which can still be writing into .git when a test removes its temp dir.
//
//   makeSkillsSource(dir, versions)   a real git repo at `dir` with one commit and tag per
//                                     version, in order. versions is
//                                     { '<tag>': { '<skill>': { '<relative path>': text } } };
//                                     a text of { link: target } makes a symlink, and a version
//                                     of null has no skills/ folder. Returns the absolute path.
//   writeInstalled(root, skills, source, { ref })
//                                     what `foreman sf skills` leaves in a project: the files in
//                                     .agents/skills, the .claude/skills symlinks and a
//                                     skills-lock.json with real hashes. ref null leaves it out.
//   gitIn(cwd, ...args)               runs git there and returns its trimmed stdout, or throws.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashSkillDir, sourceType } from '../plugin/packs/salesforce/skills.mjs';

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[key];

// The shell the code under test gets: real git, without the developer's config.
export const gitSh = (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: ENV, cwd: opts.cwd, timeout: opts.timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function gitIn(cwd, ...args) {
  const r = gitSh('git', ['-c', 'user.name=Acme', '-c', 'user.email=acme@example.com', ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeTree(base, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text !== null && typeof text === 'object') fs.symlinkSync(text.link, file);
    else fs.writeFileSync(file, text);
  }
}

export function makeSkillsSource(dir, versions) {
  const repo = path.resolve(dir);
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  for (const [tag, skills] of Object.entries(versions)) {
    fs.rmSync(path.join(repo, 'skills'), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo, 'README.md'), `Acme skills ${tag}\n`);
    for (const [name, files] of Object.entries(skills ?? {})) writeTree(path.join(repo, 'skills', name), files);
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '--allow-empty', '-m', `Acme skills ${tag}`);
    gitIn(repo, 'tag', tag);
  }
  return repo;
}

export function writeInstalled(root, skills, source, { ref = '1.66.0' } = {}) {
  const lock = { version: 1, skills: {} };
  for (const name of Object.keys(skills).sort()) {
    const real = path.join(root, '.agents', 'skills', name);
    writeTree(real, skills[name]);
    const link = path.join(root, '.claude', 'skills', name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.join('..', '..', '.agents', 'skills', name), link, 'dir');
    lock.skills[name] = {
      source,
      sourceType: sourceType(source),
      ...(ref === null ? {} : { ref }),
      skillPath: `skills/${name}/SKILL.md`,
      computedHash: hashSkillDir(real, fs),
    };
  }
  fs.writeFileSync(path.join(root, 'skills-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
