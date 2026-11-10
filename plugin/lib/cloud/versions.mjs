// What a cloud run installs: Foreman from its own repository at the tag of this version, and
// the Claude Code CLI at a pinned version (npm's `stable` tag when this release was cut).
// The runner image (runner/Dockerfile) pins the same Claude Code version.
//
//   runnerImage(config)   this version's runner image, the -salesforce one for that pack

import { readFileSync } from 'node:fs';

export const FOREMAN_SOURCE = 'finefactory-ai/foreman';
export const CLAUDE_CODE_VERSION = '2.1.292';

export function foremanVersion() {
  return JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
}

export function runnerImage(config) {
  return `ghcr.io/${FOREMAN_SOURCE}-runner:${foremanVersion()}${config?.pack === 'salesforce' ? '-salesforce' : ''}`;
}
