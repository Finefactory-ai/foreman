// Merges the story branch into a later stage's own branch, for that stage's first ship step
// (sf-deploy-<stage> or ci-deploy-watch-<stage>). The story branch is what is merged, never the
// previous stage's branch, so the stage gets this story and nothing else that waits upstream.
// merge.keepBranch (config.mjs defaults) keeps the story branch, local and on the remote, after
// the pull request merged, so it can be fetched here.
//
// mergeIntoStage(ctx, stage), where stage is a layout stage, refuses first, with no git call, a
// story or stage branch that is not a branch name and a stage branch that is productionBranch.
// Then it fetches both branches from the remote. The merge is pinned to the head that was
// reviewed: the local story branch head, which the push step pushed and the pull request, CI and
// review saw. A missing local story branch, or a remote story branch that moved since (a commit
// pushed after review), is refused with nothing merged. A story already on the stage branch is
// not merged again, so a resumed run gives the same commit. Otherwise, in a temporary worktree
// of the stage branch, never the project's own checkout, it merges the pinned sha with --no-ff,
// and pushes the merge to the stage branch. A conflict is aborted and names the files; nothing
// is pushed. The worktree is removed on every path, and git's record of it is pruned when the
// remove fails.
//
// Returns { ok: true, sha, merged } (sha: the stage branch head that holds the story) or
// { ok: false, reason }, and never throws for an expected failure. A message names only
// branches, shas, the story id and file paths, plus git's own first line, redacted
// (lib/secrets/redact.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRANCH, layout } from './config.mjs';
import { redact } from '../../lib/secrets/redact.mjs';
import { removeTempTree } from './temp-tree.mjs';

const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'git gave no reason';
const fail = (reason) => ({ ok: false, reason });
const isBranch = (v) => typeof v === 'string' && BRANCH.test(v);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function mergeIntoStage(ctx, stage) {
  const story = ctx.branch;
  const into = stage?.branch;
  if (!isBranch(story)) return fail('the story branch is not known, so it cannot be merged into a later stage');
  if (!isBranch(into)) return fail(`stage ${stage?.name ?? 'unknown'} has no branch to merge ${story} into`);
  const production = layout(ctx.config?.salesforce, ctx.config).productionBranch;
  if (production && into === production) return fail(`${into} is the production branch; nothing merges into production`);

  const remote = ctx.config?.remote ?? 'origin';
  const root = ctx.root;
  const git = (args, cwd = root) => ctx.sh('git', args, { cwd }) ?? {};
  const intoRef = `refs/remotes/${remote}/${into}`;
  const storyRef = `refs/remotes/${remote}/${story}`;
  const said = (r) => redact(firstLine(r.stderr || r.stdout), { env: ctx.env ?? process.env });
  const shaOf = (ref) => {
    const r = git(['rev-parse', '--verify', ref]);
    const sha = r.status === 0 ? String(r.stdout ?? '').trim() : '';
    return SHA.test(sha) ? sha : '';
  };

  for (const branch of [into, story]) {
    const fetched = git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    if (fetched.status !== 0) return fail(`could not fetch ${branch} from ${remote}: ${said(fetched)}`);
  }

  const pinned = shaOf(`refs/heads/${story}`);
  if (!pinned) return fail(`${story} is not in this checkout, so the head that was reviewed is not known; ${into} was not changed`);
  const remoteSha = shaOf(storyRef);
  if (remoteSha !== pinned) return fail(`${story} on ${remote} is at ${remoteSha.slice(0, 7) || 'an unknown commit'}, not ${pinned.slice(0, 7)} that was reviewed; nothing unreviewed is merged into ${into}`);

  if (git(['merge-base', '--is-ancestor', pinned, intoRef]).status === 0) {
    const head = git(['rev-parse', '--verify', intoRef]);
    const sha = head.status === 0 ? String(head.stdout ?? '').trim() : '';
    if (!sha) return fail(`could not read the head of ${into}`);
    return { ok: true, sha, merged: false };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-stage-'));
  const tree = path.join(tmp, 'tree');
  try {
    if (git(['worktree', 'add', '--detach', tree, intoRef]).status !== 0) return fail(`could not check out ${into} to merge ${story} into it`);
    const merged = git(['merge', '--no-ff', '--no-edit', '-m', `Merge ${story} into ${into} for ${ctx.story}`, pinned], tree);
    if (merged.status !== 0) {
      const listed = git(['diff', '--name-only', '--diff-filter=U'], tree);
      git(['merge', '--abort'], tree);
      const files = String(listed.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (!files.length) return fail(`could not merge ${story} into ${into}: ${said(merged)}; ${into} was not changed`);
      return fail(`${story} conflicts with ${into} in: ${files.join(', ')}; merge it by hand`);
    }
    const head = git(['rev-parse', 'HEAD'], tree);
    const sha = head.status === 0 ? String(head.stdout ?? '').trim() : '';
    if (!sha) return fail(`could not read the merge of ${story} into ${into}; ${into} was not changed`);
    const pushed = git(['push', '--quiet', remote, `HEAD:refs/heads/${into}`], tree);
    if (pushed.status !== 0) return fail(`could not push the merge of ${story} to ${into}, so ${into} was not changed: ${said(pushed)}`);
    return { ok: true, sha, merged: true };
  } finally {
    removeTempTree(git, tree, tmp);
  }
}
