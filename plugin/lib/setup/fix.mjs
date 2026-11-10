// withFix(check): the doctor check with its set-up step filled in on every result that is not
// ok. The check's `step` defaults to 'project'. A result that is not ok gets
// fix: { step: <the check's step>, ...its own fix }, so a result's own fix.step wins: the env
// check uses that to point at the step that owns a missing key. An ok result passes through
// unchanged. A synchronous run stays synchronous; a promise is chained. Imports nothing.

export function withFix(check) {
  const step = check.step ?? 'project';
  const mark = (r) => (r && r.ok === false ? { ...r, fix: { step, ...(r.fix ?? {}) } } : r);
  return {
    ...check,
    step,
    run(ctx) {
      const r = check.run(ctx);
      return r && typeof r.then === 'function' ? r.then(mark) : mark(r);
    },
  };
}
