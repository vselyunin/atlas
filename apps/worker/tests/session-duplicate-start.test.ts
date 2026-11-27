import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHarness, startPayload } from './support/sessions.js';
import type { Harness } from './support/sessions.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The stand-in agent prints one `READY <cwd>` line when its process starts.
const processes = (h: Harness, sessionId: string) =>
  h
    .output(sessionId)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('READY ')).length;

it('runs one agent for two starts of a task while the first is starting or running', async () => {
  const h = (harness = await createHarness({ agentArgs: ['--slow-start', '200'] }));
  await h.initRepository('app');
  const sessionId = randomUUID();

  // Two starts in one tick: the second arrives while the first is still starting.
  const first = startPayload(sessionId, 'app');
  const second = startPayload(sessionId, 'app');
  await Promise.all([h.manager.start(first), h.manager.start(second)]);
  await h.waitForOutput(sessionId, 'READY ');

  // A third start while the agent runs attaches to it instead of starting another.
  const third = startPayload(sessionId, 'app');
  await h.manager.start(third);
  await sleep(400);

  expect(processes(h, sessionId)).toBe(1);
  const started = h.events.filter(
    (event) => event.type === 'session.started' && event.payload.sessionId === sessionId,
  );
  expect(started.map((event) => event.payload.runId)).toEqual([first.runId, third.runId]);
  expect(h.events.some((event) => event.type === 'session.exit')).toBe(false);
});
