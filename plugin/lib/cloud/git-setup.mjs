// Git on a fresh cloud machine: pushes signed in with GH_TOKEN through gh's credential helper
// (`gh auth setup-git`), so every worktree of the project can push; and, when git has no
// identity, the token account's name and its GitHub no-reply address, set in the project's
// own config. A token with no user account (an app's) gets "Foreman".
//
//   setUpGit({ root, sh, auth = true }) -> { identity: 'kept' | <name>, warnings: [...] }
//       auth: false leaves out `gh auth setup-git`, for a caller that ran it already

const why = (r) => String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200);

export function setUpGit({ root, sh, auth = true }) {
  const warnings = [];
  if (auth) {
    const r = sh('gh', ['auth', 'setup-git']);
    if (r.status !== 0) warnings.push(`\`gh auth setup-git\` failed, so git pushes may not be signed in: ${why(r)}`);
  }

  const email = sh('git', ['config', 'user.email'], { cwd: root });
  if (email.status === 0 && String(email.stdout).trim()) return { identity: 'kept', warnings };

  let name = 'Foreman';
  let address = 'foreman@localhost';
  const user = sh('gh', ['api', 'user', '--jq', '.login + " " + (.id | tostring)']);
  const m = String(user.stdout).trim().match(/^([A-Za-z0-9-]+(?:\[bot\])?) (\d+)$/);
  if (user.status === 0 && m) {
    name = m[1];
    address = `${m[2]}+${m[1]}@users.noreply.github.com`;
  } else {
    warnings.push(`could not read the token's account (${why(user) || 'no answer'}); commits are made as Foreman <foreman@localhost>`);
  }
  sh('git', ['config', 'user.name', name], { cwd: root });
  sh('git', ['config', 'user.email', address], { cwd: root });
  return { identity: name, warnings };
}
