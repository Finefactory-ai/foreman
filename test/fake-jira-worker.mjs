// The worker thread behind startFakeJira() in test/fake-jira.mjs: a fake Atlassian whose
// issue store is read from a JSON file on every request, and written back after a change.

import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { startFakeAtlassian } from './fake-atlassian.mjs';
import { installJiraRoutes } from './fake-jira.mjs';

const log = [];
let fake = null;
const load = () => JSON.parse(fs.readFileSync(workerData.file, 'utf8'));
const save = (store) => {
  fs.writeFileSync(`${workerData.file}.w.tmp`, JSON.stringify(store));
  fs.renameSync(`${workerData.file}.w.tmp`, workerData.file);
};

parentPort.on('message', async ({ id, type }) => {
  let value = null;
  if (type === 'start') {
    fake = await startFakeAtlassian();
    installJiraRoutes(fake, load, log, save);
    value = { url: fake.url, cloudId: fake.sites[0].id, tokens: fake.issueTokens() };
  } else if (type === 'requests') {
    value = log;
  } else if (type === 'close') {
    await fake?.close();
  }
  parentPort.postMessage({ id, value });
});
