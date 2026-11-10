// Builds the factory's emails to the owner: one layout for every kind (halted, stopped,
// blocked, failed, noresult, and for a slot: parked, down; and paused; config, the run is on the last
// good config because foreman.config.json turned invalid; stuck, the run is going but not making
// progress (the reason is the progress watchdog's); credits, the platform credits ran out or the
// API key reached its usage limit, and the run moved to the subscription (the reason is that
// line); unexpected-stop, something other than the owner asked the run to stop (the reason names
// who); standby, the run has nothing to build while things wait on the owner (the reason is
// console/waiting.mjs standbyNews); owner-task, an owner task has held a story for hours (the
// reason is engine/owner-task-watch.mjs ownerTaskText); and test, the one the Set up tab sends to show email works), as HTML with a plain-text
// copy. Pure: the notify command gathers the facts and a notifier adapter sends; this only turns
// them into words.
//
// Input: { kind, slot?, parkedFor?: 'crash'|'dirty'|'owner', reason?, story?: {id, title}, halt?: {stage, reason, pr, rolledBack?}, run?: {stories,
// shipped}, report?: the factory session's own final message (markdown), project: {name}, rollbackHint?: text for a failed deploy/smoke halt, links?:
// {commandCenter?, decisions?}, now }

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Lines Claude Code prints around the factory's message that mean nothing to the owner.
const NOISE = [/^⚠/, /^Warning: no stdin/, /^FACTORY_RESULT:/, /^Shell cwd was reset/];
export function cleanReport(raw) {
  return String(raw ?? '')
    .split('\n')
    .filter((line) => !NOISE.some((re) => re.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000);
}

const inline = (text) =>
  esc(text)
    .replace(/`([^`]+)`/g, '<code style="font-family:Menlo,Consolas,monospace;font-size:13px;background:#eef3f1;padding:1px 5px;border-radius:4px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" style="color:#0c8f6c">$1</a>');

// Enough markdown for what the factory writes: paragraphs, headings, lists, code, bold, links.
export function markdownToHtml(md) {
  const blocks = String(md ?? '').split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) return '';
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        return `<ul style="margin:0 0 12px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 4px">${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
        return `<ol style="margin:0 0 12px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 4px">${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`;
      }
      const heading = lines[0].match(/^#{1,4}\s+(.*)$/);
      if (heading && lines.length === 1) return `<p style="margin:14px 0 6px;font-weight:700">${inline(heading[1])}</p>`;
      return `<p style="margin:0 0 12px">${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

const STAGE_WORDS = {
  start: 'start',
  push: 'push',
  'pull-request': 'pull request step',
  'merge-main': 'step that brings in the latest main',
  ci: 'CI step',
  'hosted-db': 'live database step',
  merge: 'merge step',
  deploy: 'production deployment',
  smoke: 'live-site check',
  watch: 'check after the deploy',
};

// Stages after which the live site may be broken; their halt email adds the rollback hint,
// unless the runner already rolled production back.
const LIVE_STAGES = ['deploy', 'smoke', 'watch'];

const TONE = {
  halted: { label: 'Halted', color: '#c9334f', wash: '#fdecef' },
  failed: { label: 'Failed review', color: '#c9334f', wash: '#fdecef' },
  blocked: { label: 'Blocked', color: '#a86b0c', wash: '#fdf3e1' },
  noresult: { label: 'No result', color: '#a86b0c', wash: '#fdf3e1' },
  stopped: { label: 'Stopped', color: '#3d5566', wash: '#eef3f1' },
  parked: { label: 'Parked', color: '#a86b0c', wash: '#fdf3e1' },
  down: { label: 'Down', color: '#c9334f', wash: '#fdecef' },
  paused: { label: 'Paused', color: '#a86b0c', wash: '#fdf3e1' },
  config: { label: 'Config invalid', color: '#a86b0c', wash: '#fdf3e1' },
  stuck: { label: 'Stuck', color: '#c9334f', wash: '#fdecef' },
  'unexpected-stop': { label: 'Stopped, not by you', color: '#c9334f', wash: '#fdecef' },
  credits: { label: 'Switched sign-in', color: '#a86b0c', wash: '#fdf3e1' },
  standby: { label: 'Standby', color: '#3d5566', wash: '#eef3f1' },
  'owner-task': { label: 'Waiting on you', color: '#a86b0c', wash: '#fdf3e1' },
  test: { label: 'Test', color: '#0c8f6c', wash: '#e6f6f0' },
};

// The buttons a parked slot offers, by why it was parked (scheduler.mjs actionsFor).
const PARKED_TODO = {
  crash: 'On the command center, choose Resume, Restart, Skip story or Take over for this slot.',
  dirty: 'On the command center, choose Resume as is (keep the changes) or Discard and reset for this slot.',
  owner: 'On the command center, choose Unpark for this slot when you want it back.',
};

function content({ rollbackHint = '', kind, slot = '', parkedFor = 'crash', reason = '', story, halt, run = { stories: 0, shipped: 0 } }) {
  const id = story?.id ?? '';
  const where = halt?.stage ? STAGE_WORDS[halt.stage] ?? halt.stage : '';
  const runLine = `${run.stories} ${run.stories === 1 ? 'story' : 'stories'} this run, ${run.shipped} shipped`;

  if (kind === 'halted') {
    const todo = halt
      ? ['Read what happened below.', 'Fix the cause.', "Press **I've fixed it** on the command center. The Mac checks the live site and the live database, then ships what was held. (On the Mac, `rm .factory/HALT` also clears it.)"]
      : ['Read what happened below and fix the cause.', 'Start again: ask Claude in VS Code to start the factory'];
    if (halt && LIVE_STAGES.includes(halt.stage) && rollbackHint && halt.rolledBack !== true) {
      todo.splice(1, 0, `If the live site is broken, ${rollbackHint}`);
    }
    return {
      subject: ['Factory halted', id, halt?.stage].filter(Boolean).join(' · '),
      headline: where ? `The factory halted at the ${where}` : 'The factory halted',
      lead: halt
        ? `${halt.reason} Nothing after that step happened, and the factory will not start another story until you clear the halt.`
        : `${reason || 'It stopped before going further.'} It will not continue on its own.`,
      todo,
    };
  }
  if (kind === 'parked') {
    return {
      subject: [`Slot ${slot} parked`, id].filter(Boolean).join(' · '),
      headline: `Slot ${slot} is parked`,
      lead: `${reason || 'It needs you before it can go on.'} The other slots carry on.`,
      todo: [PARKED_TODO[parkedFor] ?? PARKED_TODO.crash],
    };
  }
  if (kind === 'down') {
    return {
      subject: `Slot ${slot} is down`,
      headline: `Slot ${slot} is down`,
      lead: `${reason || 'Its local stack would not start.'} It tried to repair itself twice. The other slots carry on.`,
      todo: ['Check Docker (Colima) on the Mac.', 'Once it is healthy, press Resume for this slot on the command center.'],
    };
  }
  if (kind === 'paused') {
    return {
      subject: 'Factory paused',
      headline: 'The factory paused itself',
      lead: `${reason} Stories already being built finish first. ${runLine[0].toUpperCase()}${runLine.slice(1)}.`,
      todo: ['Look at what did not ship on the command center.', 'Resume on the command center when ready.'],
    };
  }
  if (kind === 'config') {
    return {
      subject: 'foreman.config.json is invalid',
      headline: 'Foreman is running on the last good config',
      lead: `${reason} Foreman keeps building with the config it had before; nothing else changes until the file is fixed.`,
      todo: ['Run `foreman config check` to see what is wrong, and fix foreman.config.json.', 'The run picks up the fixed file at its next pick; no restart is needed.'],
    };
  }
  if (kind === 'stuck') {
    return {
      subject: 'Foreman is not making progress',
      headline: 'Foreman is running but not making progress',
      lead: `${String(reason).replace(/\.+$/, '')}. The run is still going; this clears by itself when work moves again.`,
      todo: ['Run `foreman status` or open the command center: Waiting on you says what it is stuck on.', 'If the same error repeats, fix its cause; stop and start the run if it does not clear.'],
    };
  }
  if (kind === 'unexpected-stop') {
    return {
      subject: 'Foreman was asked to stop, not by you',
      headline: 'Something other than you asked the factory to stop',
      lead: `${reason} The run finishes the stories in progress, then stops, and stays stopped until \`foreman run\`.`,
      todo: ['If you did not mean it to stop, run `foreman run` in the project.', 'See who stopped it in `foreman status` or on the command center.'],
    };
  }
  if (kind === 'credits') {
    // The reason is claude-fallback.mjs creditsOutFyi: it names a usage limit when that was why.
    const usage = /usage limit/i.test(reason);
    return {
      subject: usage ? 'The API key reached its usage limit' : 'Platform credits ran out',
      headline: 'Foreman switched to your subscription',
      lead: `${reason} The run carries on; nothing else changes.`,
      todo: [usage ? "Raise the key's limit on console.anthropic.com, or wait until access returns." : 'Top up the credits on console.anthropic.com.', 'Then run `foreman claude use-key`, or press Use the API key again on the Set up tab.'],
    };
  }
  if (kind === 'standby') {
    return {
      subject: 'Foreman is on standby: things wait on you',
      headline: 'Nothing to build until you answer',
      lead: `${reason} The run stays up and starts by itself as soon as something can be built.`,
      todo: ['Open the command center: Waiting on you lists them, the one to do first at the top.', 'Or run `foreman decide list` in the project.'],
    };
  }
  if (kind === 'owner-task') {
    return {
      subject: `An owner task still holds ${id || 'a story'}`,
      headline: `Your task is holding up ${id || 'a story'}`,
      lead: `${reason} Foreman tells you this once; the story starts by itself once the task is marked done.`,
      todo: ['Do the task, then press Mark done on Waiting on you, or run `foreman story done <task id>`.', 'If the story no longer needs it, take the dependency off the story.'],
    };
  }
  if (kind === 'test') {
    return {
      subject: 'Test email',
      headline: 'Foreman can email you',
      lead: 'You sent this from the Set up tab, to check that Foreman can reach you. From now on it emails you here when a story ships, fails or needs an answer.',
      todo: ['Nothing to do: this was only a test.'],
    };
  }
  if (kind === 'blocked') {
    return {
      subject: `${id} is blocked · the factory moved on`,
      headline: `${id} is blocked`,
      lead: 'The factory could not take this story forward and has moved on to the next one. The reason is below.',
      todo: ['If it needs something from you, it is on your decisions page.', 'Once that is done, the factory picks the story up again by itself.'],
    };
  }
  if (kind === 'failed') {
    return {
      subject: `${id} did not pass review · parked as a draft`,
      headline: `${id} did not pass review`,
      lead: 'It was still rejected after three build rounds, so it is parked as a draft pull request with the open findings. The factory has moved on.',
      todo: ['Read the findings below or on the draft pull request.', 'Decide whether to rework the story note or fix it by hand.'],
    };
  }
  if (kind === 'noresult') {
    return {
      subject: 'Factory: a story ended without a result',
      headline: 'A story ended without a result',
      lead: 'The session for this story finished without saying what happened. The factory has moved on. Its last words are below.',
      todo: ['Check the story on the command center and in the tracker.', 'If something was left half done, tell Claude in a session.'],
    };
  }
  const worrying = /three (?:stories|times|tries) in a row|would not start|interrupted/i.test(reason);
  return {
    subject: `Factory stopped · ${run.shipped} of ${run.stories} shipped`,
    headline: 'The factory stopped',
    lead: `${reason}${worrying ? '' : ' Nothing is wrong.'} ${runLine[0].toUpperCase()}${runLine.slice(1)}.`,
    todo: worrying
      ? ['Look at the stories that did not ship on the command center.', 'Start again when ready: ask Claude in VS Code to start the factory']
      : ['Start again when you are ready: ask Claude in VS Code to start the factory'],
  };
}

export function buildEmail(input) {
  const { kind, story, halt, run = { stories: 0, shipped: 0 }, report = '', links = {}, project = {}, now = new Date() } = input;
  const tone = TONE[kind] ?? TONE.stopped;
  const c = content(input);
  const pr = halt?.pr || input.pr || '';
  const facts = [
    input.slot && ['Slot', input.slot],
    story && ['Story', `${story.id} · ${story.title ?? ''}`.trim()],
    halt?.stage && ['Stopped at', STAGE_WORDS[halt.stage] ?? halt.stage],
    pr && ['Pull request', pr],
    kind !== 'test' && ['This run', `${run.stories} ${run.stories === 1 ? 'story' : 'stories'}, ${run.shipped} shipped`],
    ['When', now.toUTCString()],
  ].filter(Boolean);
  const cleaned = cleanReport(report);

  const button = (href, label, primary) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;${primary ? 'background:#0b1220;color:#3fe9ff' : 'background:#eef3f1;color:#0b1220'}">${esc(label)}</a>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f1f2e;font-size:15px;line-height:1.55">
<tr><td style="background:#0b1220;padding:16px 24px">
  <span style="font-family:Menlo,Consolas,monospace;font-size:11px;letter-spacing:3px;color:#3fe9ff">${esc(String(project.name ?? 'Foreman').toUpperCase())} · BUILD FACTORY</span>
  <span style="float:right;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${tone.color};background:${tone.wash};padding:3px 10px;border-radius:999px">${esc(tone.label)}</span>
</td></tr>
<tr><td style="padding:24px 24px 8px">
  <h1 style="margin:0 0 8px;font-size:22px;line-height:1.25">${esc(c.headline)}</h1>
  <p style="margin:0 0 16px;color:#3d5566">${inline(c.lead)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #dbe6e1;margin:0 0 18px;font-size:14px">
    ${facts.map(([k, v]) => `<tr><td style="padding:7px 12px 7px 0;color:#54677a;white-space:nowrap;vertical-align:top;border-bottom:1px solid #dbe6e1">${esc(k)}</td><td style="padding:7px 0;border-bottom:1px solid #dbe6e1;word-break:break-word">${/^https?:\/\//.test(v) ? `<a href="${esc(v)}" style="color:#0c8f6c">${esc(v)}</a>` : esc(v)}</td></tr>`).join('')}
  </table>
  <div style="border-left:4px solid ${tone.color};background:${tone.wash};padding:12px 16px;border-radius:0 8px 8px 0;margin:0 0 18px">
    <p style="margin:0 0 6px;font-weight:700">What to do</p>
    <ol style="margin:0;padding-left:20px">${c.todo.map((t) => `<li style="margin:0 0 4px">${inline(t)}</li>`).join('')}</ol>
  </div>
  <p style="margin:0 0 10px">${links.commandCenter ? button(links.commandCenter, 'Open the command center', true) : ''}${pr ? button(pr, 'Open the pull request') : ''}${links.decisions ? button(links.decisions, 'Your decisions page') : ''}</p>
</td></tr>
${cleaned ? `<tr><td style="padding:8px 24px 20px">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#54677a">What the factory said</p>
  <div style="background:#f6f9f8;border:1px solid #dbe6e1;border-radius:8px;padding:14px 16px;font-size:14px">${markdownToHtml(cleaned)}</div>
</td></tr>` : ''}
<tr><td style="padding:14px 24px;background:#f6f9f8;color:#54677a;font-size:12px">${kind === 'test' ? "Sent from the Set up tab of Foreman's dashboard." : "Sent by foreman run. The full transcript is in the state folder's logs/."}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${tone.label.toUpperCase()} · ${c.headline}`,
    '',
    c.lead.replace(/`/g, ''),
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    'What to do:',
    ...c.todo.map((t, i) => `${i + 1}. ${t.replace(/`/g, '')}`),
    '',
    ...(links.commandCenter ? [`Command center: ${links.commandCenter}`] : []),
    ...(links.decisions ? [`Decisions page: ${links.decisions}`] : []),
    ...(cleaned ? ['', '— What the factory said —', cleaned] : []),
  ].join('\n');

  return { subject: c.subject, html, text };
}
