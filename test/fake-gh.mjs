// A fake shell for the cloud runner's set-up: the gh and git calls that lib/cloud/actions.mjs,
// the cloud doctor's local checks and lib/setup/cloud.mjs make, answered for the Acme repo.
//
//   fakeGh({ root, repo, remote, secrets, push, listError, setError, pulls, tracked })
//     a sh(cmd, args, opts) -> { status, stdout, stderr }. sh.calls records { cmd, args, opts }
//     for each call; sh.secrets is the Set of secret names on the fake GitHub.
//       root       git check-ignore answers from root/.gitignore: 0 when a line is the file,
//                  /file, file/ or /file/, else 1
//       repo       'acme/app'
//       remote     the URL `git remote get-url` prints; null makes it fail
//       secrets    the names already set
//       push       what `gh api repos/<repo> --jq .permissions.push` prints (true)
//       listError  a stderr line: `gh secret list` fails with it
//       setError   name -> (value) => stderr: `gh secret set <name>` fails with that line
//       pulls      the newest pull request number (5), or '' for none
//       tracked    the files git tracks: `git ls-files -- <file>` prints the file when it is
//                  one of them, else nothing ([])
//     `gh secret set` takes the value from opts.input only, as gh does from a piped stdin.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ACME_REPO = 'acme/app';

export function fakeGh({ root, repo = ACME_REPO, remote = `https://github.com/${repo}.git`, secrets = [], push = true, listError = null, setError = {}, pulls = '5', tracked = [] } = {}) {
  const calls = [];
  const names = new Set(secrets);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const no = (stderr) => ({ status: 1, stdout: '', stderr: `${stderr}\n` });

  const ignored = (file) => {
    const gitignore = root ? join(root, '.gitignore') : null;
    const text = gitignore && existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    const same = [file, `/${file}`, `${file}/`, `/${file}/`];
    return text.split(/\r?\n/).some((line) => same.includes(line.trim()));
  };

  const sh = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: [...args], opts });
    const line = [cmd, ...args].join(' ');
    if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return remote ? ok(`${remote}\n`) : no(`error: No such remote '${args[2]}'`);
    if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--') return ok(tracked.includes(args[2]) ? `${args[2]}\n` : '');
    if (cmd === 'git' && args[0] === 'check-ignore') return { status: ignored(args.at(-1)) ? 0 : 1, stdout: '', stderr: '' };
    if (cmd === 'gh' && args[0] === 'secret' && args[1] === 'list') {
      if (listError) return no(listError);
      return ok(`${JSON.stringify([...names].map((name) => ({ name })))}\n`);
    }
    if (cmd === 'gh' && args[0] === 'secret' && args[1] === 'set') {
      const name = args[2];
      if (Object.hasOwn(setError, name)) return no(setError[name](opts.input));
      if (typeof opts.input !== 'string' || opts.input === '') return no('no value on stdin');
      names.add(name);
      return ok('');
    }
    if (line === 'gh api user --jq .login') return ok('acme-owner\n');
    if (line === `gh api repos/${repo} --jq .permissions.push`) return ok(`${push}\n`);
    if (line.startsWith(`gh api repos/${repo}/pulls?state=all&per_page=1`)) return ok(`${pulls}\n`);
    if (line.startsWith('gh pr view ')) return ok(JSON.stringify({ statusCheckRollup: [] }));
    return ok('');
  };
  sh.calls = calls;
  sh.secrets = names;
  return sh;
}
