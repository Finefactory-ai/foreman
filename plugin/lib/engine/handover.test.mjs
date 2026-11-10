import { describe, expect, it } from 'vitest';
import { adoptable, adoptedPids, handoverSessions, keptText, leftOut, resultArrived, sessionAlive } from './handover.mjs';

const entry = (extra = {}) => ({ child: {}, pid: 501, id: 'ACME-1', mode: '', startedAt: 1_000, log: '/tmp/acme/logs/w1.log', usedKey: false, holderPid: 400, stop: null, adopted: false, ...extra });

describe('handoverSessions', () => {
  it('keeps what the next process needs, in slot order', () => {
    const list = handoverSessions(
      [
        ['w1', entry()],
        ['w2', entry({ pid: 502, id: 'ACME-2', mode: 'fresh', log: '/tmp/acme/logs/w2.log', usedKey: true, holderPid: undefined })],
      ],
      900,
    );
    expect(list).toEqual([
      { slot: 'w1', id: 'ACME-1', mode: '', pid: 501, startedAt: 1_000, log: '/tmp/acme/logs/w1.log', usedKey: false, holderPid: 400 },
      { slot: 'w2', id: 'ACME-2', mode: 'fresh', pid: 502, startedAt: 1_000, log: '/tmp/acme/logs/w2.log', usedKey: true, holderPid: 900 },
    ]);
  });

  it('leaves out a session being stopped', () => {
    expect(handoverSessions([['w1', entry({ stop: 'watchdog' })], ['w2', entry({ id: 'ACME-2' })]], 900).map((s) => s.id)).toEqual(['ACME-2']);
  });
});

describe('adoptable', () => {
  const good = { slot: 'w1', id: 'ACME-1', mode: '', pid: 501, startedAt: 1_000, log: '/tmp/w1.log', usedKey: false, holderPid: 400 };
  it('keeps well-formed entries for known slots', () => {
    expect(adoptable([good, { ...good, slot: 'w2', id: 'ACME-2', pid: 502 }], ['w1', 'w2'])).toEqual([good, { ...good, slot: 'w2', id: 'ACME-2', pid: 502 }]);
  });

  it('drops unknown slots, a second entry for a slot and malformed entries', () => {
    const list = [
      { ...good, slot: 'w9' },
      good,
      { ...good, id: 'ACME-9', pid: 509 },
      { ...good, slot: 'w2', pid: 1.5 },
      { ...good, slot: 'w2', pid: -3 },
      { ...good, slot: 'w2', holderPid: 0 },
      { ...good, slot: 'w2', log: undefined },
      { ...good, slot: 'w2', id: 7 },
      { ...good, slot: 'w2', startedAt: 'yesterday' },
      null,
      'w2',
    ];
    expect(adoptable(list, ['w1', 'w2'])).toEqual([good]);
  });

  it('is empty for anything but a list', () => {
    for (const v of [null, undefined, {}, 'w1', 3]) expect(adoptable(v, ['w1'])).toEqual([]);
  });
});

describe('leftOut', () => {
  const good = { slot: 'w1', id: 'ACME-1', mode: '', pid: 501, startedAt: 1_000, log: '/tmp/w1.log', usedKey: false, holderPid: 400 };
  it('gives the entries adoptable did not keep: an unknown slot and a second entry for a slot', () => {
    const unknown = { ...good, slot: 'w9', id: 'ACME-9', pid: 509 };
    const second = { ...good, id: 'ACME-2', pid: 502 };
    const other = { ...good, slot: 'w2', id: 'ACME-3', pid: 503 };
    const list = [unknown, good, second, other];
    const kept = adoptable(list, ['w1', 'w2']);
    expect(kept).toEqual([good, other]);
    expect(leftOut(list, kept)).toEqual([unknown, second]);
  });

  it('compares by identity, not by value', () => {
    expect(leftOut([good], [{ ...good }])).toEqual([good]);
  });

  it('leaves out entries with no string id or no positive-integer pid, and null', () => {
    const list = [{ ...good, id: 7 }, { ...good, pid: 0 }, { ...good, pid: 1.5 }, { ...good, pid: '501' }, { ...good, id: undefined }, null, 'w1', 3];
    expect(leftOut(list, [])).toEqual([]);
  });

  it('is empty for anything but a list', () => {
    for (const v of [null, undefined, {}, 'w1', 3]) expect(leftOut(v, [])).toEqual([]);
  });
});

describe('adoptedPids', () => {
  it('gives each supervisor pid once', () => {
    expect(adoptedPids(400, [{ holderPid: 400 }, { holderPid: 300 }, { holderPid: 300 }, { holderPid: 'x' }, {}])).toEqual([400, 300]);
    expect(adoptedPids(null, [{ holderPid: 300 }])).toEqual([300]);
    expect(adoptedPids(400, undefined)).toEqual([400]);
  });
});

describe('sessionAlive', () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const ps = (stdout, extra = {}) => {
    const asked = [];
    const fn = (cmd, args) => {
      asked.push([cmd, ...args]);
      return { status: 0, stdout, ...extra };
    };
    fn.asked = asked;
    return fn;
  };

  it('is false when the process is gone', () => {
    const p = ps('node claude -p /foreman:story ACME-1');
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => { throw err('ESRCH'); }, ps: p })).toBe(false);
    expect(p.asked).toEqual([]);
  });

  it('is true for the story session, even under another user', () => {
    const p = ps('node /usr/local/bin/claude -p /foreman:story ACME-1 --output-format stream-json\n');
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => { throw err('EPERM'); }, ps: p })).toBe(true);
    expect(p.asked).toEqual([['ps', '-p', '501', '-o', 'command=']]);
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('claude -p /foreman:story ACME-1') })).toBe(true);
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('claude -p /foreman:story ACME-1 fresh') })).toBe(true);
  });

  it('is false when the pid now belongs to another program', () => {
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('/usr/bin/vim notes.txt') })).toBe(false);
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('claude -p /foreman:story ACME-12') })).toBe(false);
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('', { status: 1 }) })).toBe(false);
  });

  it('lets the kill check decide when ps cannot run', () => {
    expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: () => ({ error: err('ENOENT'), status: null, stdout: '' }), procStat: () => null })).toBe(true);
  });

  describe('when ps cannot run, /proc/<pid>/stat', () => {
    const noPs = () => ({ error: err('ENOENT'), status: null, stdout: '' });
    const stat = (text) => {
      const asked = [];
      const fn = (pid) => {
        asked.push(pid);
        return text;
      };
      fn.asked = asked;
      return fn;
    };

    it('says a zombie has ended', () => {
      const procStat = stat('501 (claude) Z 1 501 501 0 -1 4194560');
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: noPs, procStat })).toBe(false);
      expect(procStat.asked).toEqual([501]);
    });

    it('reads the state after the last ), whatever the command name holds', () => {
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: noPs, procStat: stat('501 (a) b) X 1') })).toBe(false);
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: noPs, procStat: stat('501 (a Z) S 1') })).toBe(true);
    });

    it('says a running or sleeping process is alive', () => {
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: noPs, procStat: stat('501 (node) S 1 501 501 0 -1') })).toBe(true);
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: noPs, procStat: stat('501 (node) R 1') })).toBe(true);
    });

    it('leaves it to the kill check when there is no /proc', () => {
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: noPs, procStat: stat(null) })).toBe(true);
    });

    it('is never read when ps runs', () => {
      const procStat = stat('501 (claude) Z 1');
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('claude -p /foreman:story ACME-1'), procStat })).toBe(true);
      expect(sessionAlive({ pid: 501, id: 'ACME-1' }, { kill: () => true, ps: ps('/usr/bin/vim'), procStat })).toBe(false);
      expect(procStat.asked).toEqual([]);
    });
  });
});

describe('keptText', () => {
  it('names the kept sessions in slot order, whatever order they started in', () => {
    const list = [
      { id: 'ACME-2', slot: 'w2', pid: 502 },
      { id: 'ACME-1', slot: 'w1', pid: 501 },
    ];
    expect(keptText(list, ['w1', 'w2', 'w3'])).toBe('Kept 2 running across the restart: ACME-1 (w1), ACME-2 (w2).');
    expect(list.map((s) => s.id)).toEqual(['ACME-2', 'ACME-1']);
  });

  it('puts a session in a slot it does not know last, and counts one session as one', () => {
    expect(keptText([{ id: 'ACME-9', slot: 'w9' }, { id: 'ACME-1', slot: 'w1' }], ['w1'])).toBe('Kept 2 running across the restart: ACME-1 (w1), ACME-9 (w9).');
    expect(keptText([{ id: 'ACME-1', slot: 'w1' }], ['w1', 'w2'])).toBe('Kept 1 running across the restart: ACME-1 (w1).');
  });
});

describe('resultArrived', () => {
  const resultEvent = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'acme' });
  const bg = (tasks) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks });
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Building ACME-1.' }] } });
  const reading = (...lines) => ({ tail: () => `${lines.join('\n')}\n` });

  it('is true when the log ends with a result carrying FACTORY_RESULT', () => {
    expect(resultArrived(entry(), reading(assistant, resultEvent('Done.\nFACTORY_RESULT: shipped ACME-1')))).toBe(true);
  });

  it('is false while the log has no result yet', () => {
    expect(resultArrived(entry(), reading(assistant))).toBe(false);
    expect(resultArrived(entry(), reading(assistant, resultEvent('The pipeline is running.')))).toBe(false);
  });

  it('is false when a background task is still open after the result', () => {
    expect(resultArrived(entry(), reading(bg([{ id: 't-1' }]), resultEvent('FACTORY_RESULT: shipped ACME-1')))).toBe(false);
  });

  it('is false with no log to read', () => {
    expect(resultArrived(entry(), { tail: () => '' })).toBe(false);
    expect(resultArrived(entry({ log: '/nonexistent/acme/w1.log' }))).toBe(false);
    expect(resultArrived(entry({ log: undefined }))).toBe(false);
  });

  it('reads the session\'s own log', () => {
    const seen = [];
    resultArrived(entry({ log: '/tmp/acme/w9.log' }), { tail: (file) => (seen.push(file), '') });
    expect(seen).toEqual(['/tmp/acme/w9.log']);
  });
});
