import { expect, it } from 'vitest';

it('sleeps 400 ms', async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(true).toBe(true);
});
