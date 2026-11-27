import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendFile, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STATUS_FILE_BYTES, watchStatus } from '../src/sessions/status.js';
import type { AgentActivity } from '../src/sessions/status.js';

let base: string;
const seen: AgentActivity[] = [];
const stops: (() => void)[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'atlas-status-long-')));
  seen.length = 0;
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await rm(base, { recursive: true, force: true });
});

function watch(file: string): void {
  const watcher = watchStatus(file, (activity) => seen.push(activity), 10);
  stops.push(() => watcher.stop());
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL = { timeout: 5_000, interval: 10 };

it('keeps reporting while a long session appends past the size limit in small lines', async () => {
  const file = join(base, 'status');
  await writeFile(file, '');
  watch(file);
  // About 8 KiB per append, each read before the next, like the hook's line per tool call.
  const lines = ['working -\n', 'needs_input -\n'];
  let round = 0;
  while ((await stat(file)).size <= MAX_STATUS_FILE_BYTES * 2) {
    const line = lines[round % 2] ?? 'working -\n';
    await appendFile(file, line.repeat(Math.floor(8_192 / line.length)));
    round += 1;
    await expect.poll(() => seen.length, POLL).toBe(round);
  }
  await appendFile(file, 'idle -\n');
  await expect.poll(() => seen.at(-1), POLL).toEqual({ activity: 'idle', detail: null });
  await appendFile(file, 'error rate_limit\n');
  await expect.poll(() => seen.at(-1), POLL).toEqual({ activity: 'error', detail: 'rate_limit' });
});

it('skips an oversized burst unread and still reads the lines after it', async () => {
  const file = join(base, 'status');
  await writeFile(file, 'working -\n');
  watch(file);
  await expect.poll(() => seen.length, POLL).toBe(1);
  await appendFile(file, 'idle -\n'.repeat(Math.ceil((MAX_STATUS_FILE_BYTES * 4) / 7)));
  await sleep(60);
  expect(seen).toEqual([{ activity: 'working', detail: null }]);
  await appendFile(file, 'needs_input asked_in_text\n');
  await expect.poll(() => seen.length, POLL).toBe(2);
  expect(seen[1]).toEqual({ activity: 'needs_input', detail: 'asked_in_text' });
});

it('drops the tail of a line cut by a skipped burst', async () => {
  const file = join(base, 'status');
  await writeFile(file, '');
  watch(file);
  // The burst ends in the middle of a line, so its rest must not be taken as a new line.
  await appendFile(file, `${'x'.repeat(MAX_STATUS_FILE_BYTES + 1)}`);
  await sleep(60);
  await appendFile(file, 'idle -\n');
  await sleep(60);
  expect(seen).toEqual([]);
  await appendFile(file, 'error unknown\n');
  await expect.poll(() => seen.length, POLL).toBe(1);
  expect(seen[0]).toEqual({ activity: 'error', detail: 'unknown' });
});
