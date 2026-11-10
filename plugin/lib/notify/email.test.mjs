import { describe, expect, it } from 'vitest';
import { buildEmail, cleanReport, markdownToHtml } from './email.mjs';

const project = { name: 'Acme' };
const rollbackHint = 'roll back in Vercel: project acme-app, Deployments, the previous production deployment, Promote.';
const links = { commandCenter: 'https://pages.example/artifact/cc', decisions: 'https://pages.example/artifact/dp' };
const now = new Date('2026-10-14T10:11:00Z');

describe('the factory emails', () => {
  it('a halt says what stopped, where, and exactly how to restart', () => {
    const mail = buildEmail({
      kind: 'halted',
      story: { id: 'P4-04', title: 'Add the rate limits' },
      halt: { stage: 'merge', reason: 'The merge failed.', pr: 'https://github.com/o/r/pull/26' },
      run: { stories: 1, shipped: 0 },
      report: 'The **merge** failed: the pull request conflicts with main.',
      project,
      links,
      now,
    });
    expect(mail.subject).toBe('Factory halted · P4-04 · merge');
    expect(mail.html).toContain('The merge failed.');
    expect(mail.html).toContain('https://github.com/o/r/pull/26');
    expect(mail.html).toContain('rm .factory/HALT');
    expect(mail.html).toContain('<strong>merge</strong>');
    expect(mail.text).toContain('rm .factory/HALT');
    expect(mail.text).toContain('P4-04 · Add the rate limits');
  });

  it('an ordinary stop says nothing is wrong and how the run went', () => {
    const mail = buildEmail({ kind: 'stopped', reason: 'Reached the 2 stories asked for.', run: { stories: 2, shipped: 2 }, project, links, now });
    expect(mail.subject).toBe('Factory stopped · 2 of 2 shipped');
    expect(mail.html).toContain('Reached the 2 stories asked for.');
    expect(mail.text).toContain('Nothing is wrong');
  });

  it('a blocked story says the factory moved on and what it needs', () => {
    const mail = buildEmail({
      kind: 'blocked',
      story: { id: 'P4-11', title: 'Build email-code sign-in' },
      report: 'It needs the **Turnstile keys**.',
      run: { stories: 3, shipped: 2 },
      project,
      links,
      now,
    });
    expect(mail.subject).toBe('P4-11 is blocked · the factory moved on');
    expect(mail.html).toContain('moved on');
    expect(mail.html).toContain(links.decisions);
  });

  it('never lets the factory’s text inject markup', () => {
    const html = markdownToHtml('<script>alert(1)</script> and `<b>`');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toMatch(/<code[^>]*>&lt;b&gt;<\/code>/);
  });

  it('renders the factory’s report as paragraphs and lists, without the noise around it', () => {
    const raw = '⚠ Permission mode bypassPermissions from settings was ignored\nWarning: no stdin data received in 3s\nFirst line.\n\n- one\n- two\n\nFACTORY_RESULT: halted P4-04\n';
    expect(cleanReport(raw)).toBe('First line.\n\n- one\n- two');
    expect(markdownToHtml(cleanReport(raw))).toContain('<ul');
  });

  it('a parked slot names the slot, the story, why, and the buttons', () => {
    const mail = buildEmail({ kind: 'parked', slot: 'w2', story: { id: 'P7-03', title: 'Chat turn' }, reason: 'The session crashed twice on this story.', parkedFor: 'crash', project, links, now });
    expect(mail.subject).toBe('Slot w2 parked · P7-03');
    expect(mail.text).toContain('The session crashed twice on this story.');
    expect(mail.text).toContain('Resume, Restart, Skip story or Take over');
  });

  it('a slot parked for a dirty worktree offers the two cleanup buttons', () => {
    const mail = buildEmail({ kind: 'parked', slot: 'w1', reason: 'Its folder has changes that do not belong to a story.', parkedFor: 'dirty', project, links, now });
    expect(mail.subject).toBe('Slot w1 parked');
    expect(mail.text).toContain('Resume as is');
    expect(mail.text).toContain('Discard and reset');
  });

  it('a slot that is down says to resume once Docker is healthy', () => {
    const mail = buildEmail({ kind: 'down', slot: 'w3', reason: 'Its local database would not start.', project, links, now });
    expect(mail.subject).toBe('Slot w3 is down');
    expect(mail.text).toContain('Its local database would not start.');
    expect(mail.text).toContain('Resume');
  });

  it('an automatic pause says why and how to resume', () => {
    const mail = buildEmail({ kind: 'paused', reason: 'Three stories in a row did not ship.', run: { stories: 5, shipped: 2 }, project, links, now });
    expect(mail.subject).toBe('Factory paused');
    expect(mail.text).toContain('Three stories in a row did not ship.');
    expect(mail.text).toContain('Resume on the command center');
  });

  it('a stop after one story missed three times is worrying', () => {
    const mail = buildEmail({ kind: 'stopped', reason: 'ACME-1 did not ship three times in a row.', run: { stories: 5, shipped: 2 }, project, links, now });
    expect(mail.text).not.toContain('Nothing is wrong.');
    expect(mail.text).toContain('Look at the stories that did not ship');
  });

  it('a stop after three tries with a repeat is worrying', () => {
    const mail = buildEmail({ kind: 'stopped', reason: 'Three tries in a row did not ship: ACME-1 twice and ACME-2.', run: { stories: 5, shipped: 2 }, project, links, now });
    expect(mail.text).not.toContain('Nothing is wrong.');
    expect(mail.text).toContain('Look at the stories that did not ship');
  });

  it('a stop with nothing left to build is still not worrying', () => {
    const mail = buildEmail({ kind: 'stopped', reason: 'Nothing left to build.', run: { stories: 5, shipped: 5 }, project, links, now });
    expect(mail.text).toContain('Nothing is wrong.');
  });

  it('a halt points to the I have fixed it button', () => {
    const mail = buildEmail({ kind: 'halted', halt: { stage: 'deploy', reason: 'Deploy failed.', pr: '' }, project, rollbackHint, links, now });
    expect(mail.text).toContain("I've fixed it");
  });

  it('the header uses the project name upper-cased', () => {
    const mail = buildEmail({ kind: 'stopped', reason: 'x', project: { name: 'Acme' }, links, now });
    expect(mail.html).toContain('ACME · BUILD FACTORY');
    expect(buildEmail({ kind: 'stopped', reason: 'x', project: { name: 'Plain Node' }, now }).html).toContain('PLAIN NODE · BUILD FACTORY');
  });

  it('a deploy halt uses the rollback hint when set and leaves the line out otherwise', () => {
    const halt = { stage: 'deploy', reason: 'Deploy failed.', pr: '' };
    const withHint = buildEmail({ kind: 'halted', halt, project, rollbackHint: 'run ./rollback.sh', now });
    expect(withHint.text).toContain('If the live site is broken, run ./rollback.sh');
    const without = buildEmail({ kind: 'halted', halt, project, now });
    expect(without.text).not.toContain('live site is broken');
    expect(without.text).not.toMatch(/vercel/i);
  });

  it('a watch halt after a rollback says production was rolled back, and skips the manual hint', () => {
    const halt = {
      stage: 'watch',
      reason: 'Production was rolled back with `vercel rollback --yes`. ./check.sh reported a problem after the deploy: 4 new errors',
      pr: '',
      rolledBack: true,
    };
    const mail = buildEmail({ kind: 'halted', halt, project, rollbackHint, links, now });
    expect(mail.subject).toBe('Factory halted · watch');
    expect(mail.text).toContain('Production was rolled back with vercel rollback --yes.');
    expect(mail.html).toContain('Production was rolled back with <code');
    expect(mail.text).toContain('The factory halted at the check after the deploy');
    expect(mail.text).not.toContain('live site is broken');
  });

  it('a halt whose rollback failed says production may be broken, and keeps the manual hint', () => {
    const halt = {
      stage: 'watch',
      reason: 'Rollback failed (`vercel rollback --yes` exited 1); production may be broken. ./check.sh reported a problem after the deploy: 4 new errors',
      pr: '',
      rolledBack: false,
    };
    const mail = buildEmail({ kind: 'halted', halt, project, rollbackHint: 'run ./rollback.sh', now });
    expect(mail.text).toContain('Rollback failed (vercel rollback --yes exited 1); production may be broken.');
    expect(mail.text).toContain('If the live site is broken, run ./rollback.sh');
  });

  it('a deploy halt that was rolled back skips the manual hint too', () => {
    const halt = { stage: 'deploy', reason: 'Production was rolled back with `x`. Deploy failed.', pr: '', rolledBack: true };
    expect(buildEmail({ kind: 'halted', halt, project, rollbackHint: 'run ./rollback.sh', now }).text).not.toContain('live site is broken');
  });

  it('shows the command centre and decisions links only when given', () => {
    const none = buildEmail({ kind: 'blocked', story: { id: 'P1-01' }, project, now });
    expect(none.html).not.toContain('Open the command center');
    expect(none.text).not.toContain('Command center:');
    expect(none.text).not.toContain('Decisions page:');
    const some = buildEmail({ kind: 'blocked', story: { id: 'P1-01' }, project, links: { decisions: 'https://x/d' }, now });
    expect(some.html).toContain('Your decisions page');
    expect(some.html).not.toContain('Open the command center');
  });

  it('a test email from the Set up tab says nothing needs doing, with no run facts', () => {
    const mail = buildEmail({ kind: 'test', project: { name: 'Acme' }, now });
    expect(mail.subject).toBe('Test email');
    expect(mail.text).toContain('Foreman can email you');
    expect(mail.text).toContain('TEST');
    expect(mail.text).toContain('Set up');
    expect(mail.text).not.toContain('This run');
    expect(mail.text).not.toContain('What the factory said');
    expect(mail.html).toContain('Set up tab');
    expect(mail.html).not.toContain('Sent by foreman run');
    const odd = buildEmail({ kind: 'test', project: { name: 'Acme <b>&' }, now });
    expect(odd.html).toContain('ACME &lt;B&gt;&amp;');
    expect(odd.html).not.toContain('<b>&');
  });
});

describe('the stuck email', () => {
  it('says the run is not making progress, why, and that it clears by itself', () => {
    const reason = 'the supervisor fails every loop: ENOENT: no such file or directory';
    const mail = buildEmail({ kind: 'stuck', reason, project, now });
    expect(mail.subject).toBe('Foreman is not making progress');
    expect(mail.text.startsWith('STUCK · Foreman is running but not making progress')).toBe(true);
    expect(mail.text).toContain(`${reason}. The run is still going; this clears by itself when work moves again.`);
    expect(mail.text).toContain('Run foreman status or open the command center: Waiting on you says what it is stuck on.');
    expect(mail.text).toContain('If the same error repeats, fix its cause; stop and start the run if it does not clear.');
    expect(buildEmail({ kind: 'stuck', reason: 'it broke.', project, now }).text).toContain('it broke. The run is still going');
  });
});

describe('the credits email', () => {
  it('says the run switched to the subscription, why, and how to go back to the key', () => {
    const reason = 'Platform credits ran out at 14:32; now using your Claude subscription.';
    const mail = buildEmail({ kind: 'credits', reason, project, now });
    expect(mail.subject).toBe('Platform credits ran out');
    expect(mail.text.startsWith('SWITCHED SIGN-IN · Foreman switched to your subscription')).toBe(true);
    expect(mail.text).toContain(`${reason} The run carries on; nothing else changes.`);
    expect(mail.text).toContain('Top up the credits on console.anthropic.com.');
    expect(mail.text).toContain('Then run foreman claude use-key, or press Use the API key again on the Set up tab.');
    expect(mail.html).toContain('#a86b0c');
  });
});

describe('the credits email for a usage limit', () => {
  it('names the usage limit and says to raise it or wait', () => {
    const reason = 'The Console API key reached its usage limit at 14:32 (access returns 2026-11-01 at 00:00 UTC); now using your Claude subscription.';
    const mail = buildEmail({ kind: 'credits', reason, project, now });
    expect(mail.subject).toBe('The API key reached its usage limit');
    expect(mail.text.startsWith('SWITCHED SIGN-IN · Foreman switched to your subscription')).toBe(true);
    expect(mail.text).toContain(`${reason} The run carries on; nothing else changes.`);
    expect(mail.text).toContain("Raise the key's limit on console.anthropic.com, or wait until access returns.");
    expect(mail.text).not.toContain('Top up');
    expect(mail.text).toContain('Then run foreman claude use-key, or press Use the API key again on the Set up tab.');
  });
});

describe('the standby email', () => {
  it('names what waits and what an answer starts, and says the run stays up', () => {
    const reason = 'Standby: 1 owner task waits on you; finishing ACME-1 starts ACME-2.';
    const mail = buildEmail({ kind: 'standby', reason, story: { id: 'ACME-2', title: 'Use the key' }, project, now });
    expect(mail.subject).toBe('Foreman is on standby: things wait on you');
    expect(mail.text.startsWith('STANDBY · Nothing to build until you answer')).toBe(true);
    expect(mail.text).toContain(`${reason} The run stays up and starts by itself as soon as something can be built.`);
    expect(mail.text).toContain('Open the command center: Waiting on you lists them, the one to do first at the top.');
    expect(mail.text).toContain('Or run foreman decide list in the project.');
    expect(mail.html).toContain('#3d5566');
  });
});

describe('the owner-task email', () => {
  it('names the story the task holds, and says it is told once', () => {
    const reason = 'Owner task ACME-1 "Add the key" has held ACME-2 for 26 h.';
    const mail = buildEmail({ kind: 'owner-task', reason, story: { id: 'ACME-2', title: 'Use the key' }, project, now });
    expect(mail.subject).toBe('An owner task still holds ACME-2');
    expect(mail.text.startsWith('WAITING ON YOU · Your task is holding up ACME-2')).toBe(true);
    expect(mail.text).toContain(`${reason} Foreman tells you this once; the story starts by itself once the task is marked done.`);
    expect(mail.text).toContain('Do the task, then press Mark done on Waiting on you, or run foreman story done <task id>.');
    expect(mail.text).toContain('If the story no longer needs it, take the dependency off the story.');
    expect(mail.html).toContain('#a86b0c');
    expect(buildEmail({ kind: 'owner-task', reason, project, now }).subject).toBe('An owner task still holds a story');
  });
});

describe('the config email', () => {
  it('says the file is invalid, why, and that the run carries on with the last good config', () => {
    const mail = buildEmail({ kind: 'config', reason: 'bogusKey: unknown key', project, now });
    expect(mail.subject).toBe('foreman.config.json is invalid');
    expect(mail.text).toContain('CONFIG INVALID · Foreman is running on the last good config');
    expect(mail.text).toContain('bogusKey: unknown key Foreman keeps building with the config it had before; nothing else changes until the file is fixed.');
    expect(mail.text).toContain('Run foreman config check to see what is wrong, and fix foreman.config.json.');
    expect(mail.text).toContain('The run picks up the fixed file at its next pick; no restart is needed.');
    expect(mail.html).toContain('Config invalid');
  });
});

describe('the unexpected stop email', () => {
  it('says something other than the owner asked the run to stop, who, and how to start it again', () => {
    const reason = 'Stop requested by ACME-9\'s session at 04:01 UTC (pid 4242, in /tmp/acme-check), not from your terminal or the dashboard.';
    const mail = buildEmail({ kind: 'unexpected-stop', reason, project, now });
    expect(mail.subject).toBe('Foreman was asked to stop, not by you');
    expect(mail.text.startsWith('STOPPED, NOT BY YOU · Something other than you asked the factory to stop')).toBe(true);
    expect(mail.text).toContain(`${reason} The run finishes the stories in progress, then stops, and stays stopped until foreman run.`);
    expect(mail.text).toContain('If you did not mean it to stop, run foreman run in the project.');
    expect(mail.text).toContain('See who stopped it in foreman status or on the command center.');
    expect(mail.html).toContain('#c9334f');
  });
});
