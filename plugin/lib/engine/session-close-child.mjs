// The child of session-close.mjs runSessionClose: node session-close-child.mjs <request.json>
// <answer.json>. It reads the request, closes the session (closeSession) and writes the answer
// through <answer>.tmp and a rename. On an error it writes the message to stderr and exits 1.

import { readFileSync } from 'node:fs';
import { closeSession, writeAnswer } from './session-close.mjs';

try {
  const [requestFile, answerFile] = process.argv.slice(2);
  writeAnswer(answerFile, closeSession(JSON.parse(readFileSync(requestFile, 'utf8'))));
} catch (err) {
  process.stderr.write(`${String(err?.stack ?? err?.message ?? err)}\n`);
  process.exit(1);
}
