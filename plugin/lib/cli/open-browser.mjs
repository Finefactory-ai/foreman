// Opens an address in the default browser, without waiting for it. Used by `foreman jira login`
// and `foreman setup`, which print the address as well.

import { spawn } from 'node:child_process';

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The address is printed as well, so a missing opener is not fatal.
  }
}
