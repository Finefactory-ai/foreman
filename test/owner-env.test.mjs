// test/owner-env.mjs builds the owner's shape of environment from scratch in a temporary Acme
// project, never from the live session's variables.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerProject } from './owner-env.mjs';
import { main } from '../plugin/lib/cli/main.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const KEYS = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const inside = (child, parent) => {
  const rel = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const isRepo = (dir, env) => spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env, encoding: 'utf8' });

describe('ownerProject', () => {
  it('builds its env from scratch, whatever the live session has set', () => {
    const live = ['FOREMAN_RUN', 'FOREMAN_STORY', 'FOREMAN_STATE_DIR', 'ACME_SENTINEL'];
    const saved = Object.fromEntries(live.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { FOREMAN_RUN: '1', FOREMAN_STORY: 'S-1', FOREMAN_STATE_DIR: '/acme/.foreman', ACME_SENTINEL: 'acme' });
    let project;
    try {
      project = ownerProject();
      expect(Object.keys(project.env).sort()).toEqual([...KEYS].sort());
      expect(Object.keys(project.env).filter((key) => key.startsWith('FOREMAN_'))).toEqual([]);
      expect(project.env).not.toHaveProperty('ACME_SENTINEL');
      expect(project.env).not.toBe(process.env);
      expect(project.env).toMatchObject({ PATH: process.env.PATH, HOME: project.home, XDG_CONFIG_HOME: project.home, GIT_AUTHOR_NAME: 'Acme', GIT_AUTHOR_EMAIL: 'acme@example.com' });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      project?.remove();
    }
  });

  it('makes a temporary Acme git repo outside this repo', () => {
    const project = ownerProject();
    try {
      expect(inside(project.dir, os.tmpdir())).toBe(true);
      expect(inside(project.dir, REPO)).toBe(false);
      expect(path.dirname(project.dir)).toBe(project.tmp);
      expect(JSON.parse(fs.readFileSync(path.join(project.dir, 'foreman.config.json'), 'utf8'))).toEqual({ version: 1, project: { name: 'Acme' }, slots: 2 });
      const top = isRepo(project.dir, project.env);
      expect(top.status).toBe(0);
      expect(fs.realpathSync(top.stdout.trim())).toBe(fs.realpathSync(project.dir));
      expect(spawnSync('git', ['log', '--format=%an', '-1'], { cwd: project.dir, env: project.env, encoding: 'utf8' }).stdout.trim()).toBe('Acme');
    } finally {
      project.remove();
    }
  });

  it('makes a plain folder with git false, and takes the config it is given', () => {
    const project = ownerProject({ git: false, config: { version: 1, project: { name: 'Acme' }, slots: 1 } });
    try {
      expect(isRepo(project.dir, project.env).status).not.toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(project.dir, 'foreman.config.json'), 'utf8')).slots).toBe(1);
    } finally {
      project.remove();
    }
  });

  it("is where an owner's control works: stop writes the temp project's STOP", async () => {
    const project = ownerProject();
    try {
      let err = '';
      const code = await main(['stop'], { cwd: project.dir, env: project.env, stdout: { write: () => {} }, stderr: { write: (s) => { err += s; } } });
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(project.dir, '.foreman', 'STOP'), 'utf8'))).toMatchObject({ via: 'cli', run: false, story: null, slot: null });
    } finally {
      project.remove();
    }
  });

  it("is where an owner's settings change: settings set writes the temp project's local settings", async () => {
    const project = ownerProject();
    try {
      let err = '';
      const code = await main(['settings', 'set', 'workers', '1'], { cwd: project.dir, env: project.env, stdout: { write: () => {} }, stderr: { write: (s) => { err += s; } } });
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(project.dir, '.foreman', 'settings.json'), 'utf8'))).toEqual({ workers: 1 });
    } finally {
      project.remove();
    }
  });

  it('remove deletes the whole temporary folder', () => {
    const project = ownerProject();
    expect(fs.existsSync(project.tmp)).toBe(true);
    project.remove();
    expect(fs.existsSync(project.tmp)).toBe(false);
  });
});
