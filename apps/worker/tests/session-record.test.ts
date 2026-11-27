import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProfile, sessionArgs } from '../src/sessions/agents.js';
import {
  RUN_NOTICES,
  chooseRun,
  conversationExists,
  readRecord,
  writeRecord,
} from '../src/sessions/record.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-session-record-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('round-trips a record with owner-only modes', async () => {
  const record = { agentSessionId: randomUUID(), delivered: true };
  await writeRecord(dir, 'key-1', record);
  expect(await readRecord(dir, 'key-1')).toEqual(record);
  expect((await stat(join(dir, 'session-records', 'key-1.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, 'session-records'))).mode & 0o777).toBe(0o700);
});

it('reads a missing, malformed or wrongly shaped record as null', async () => {
  expect(await readRecord(dir, 'missing')).toBeNull();
  await mkdir(join(dir, 'session-records'), { recursive: true });
  const write = (name: string, text: string) =>
    writeFile(join(dir, 'session-records', `${name}.json`), text);
  await write('bad-json', '{nope');
  await write('bad-id', JSON.stringify({ agentSessionId: 'x', delivered: true }));
  await write('bad-flag', JSON.stringify({ agentSessionId: randomUUID(), delivered: 'yes' }));
  await write('array', '[]');
  await write('huge', ' '.repeat(70 * 1024));
  for (const name of ['bad-json', 'bad-id', 'bad-flag', 'array', 'huge']) {
    expect(await readRecord(dir, name)).toBeNull();
  }
});

it('does not read a record through a symlink', async () => {
  const target = join(dir, 'target.json');
  await writeFile(target, JSON.stringify({ agentSessionId: randomUUID(), delivered: true }));
  await mkdir(join(dir, 'session-records'), { recursive: true });
  await symlink(target, join(dir, 'session-records', 'linked.json'));
  expect(await readRecord(dir, 'linked')).toBeNull();
});

it('chooses the run from the record and the conversation', () => {
  const id = randomUUID();
  expect(chooseRun(null, false)).toBe('first');
  expect(chooseRun({ agentSessionId: id, delivered: false }, false)).toBe('first');
  expect(chooseRun({ agentSessionId: id, delivered: true }, true)).toBe('resume');
  expect(chooseRun({ agentSessionId: id, delivered: true }, false)).toBe('fresh');
  expect(chooseRun({ agentSessionId: id, delivered: false }, true)).toBe('resume');
  expect(chooseRun(null, true)).toBe('first');
});

it('finds a conversation file only when it is a regular file', async () => {
  const id = randomUUID();
  expect(await conversationExists(dir, id)).toBe(false);
  await mkdir(join(dir, '.claude', 'projects', 'x', `${id}.jsonl`), { recursive: true });
  expect(await conversationExists(dir, id)).toBe(false);

  const other = randomUUID();
  await writeFile(join(dir, '.claude', 'projects', 'x', 'real.jsonl'), '{}\n');
  await symlink(
    join(dir, '.claude', 'projects', 'x', 'real.jsonl'),
    join(dir, '.claude', 'projects', 'x', `${other}.jsonl`),
  );
  expect(await conversationExists(dir, other)).toBe(false);

  const third = randomUUID();
  await mkdir(join(dir, '.claude', 'projects', 'y'), { recursive: true });
  await writeFile(join(dir, '.claude', 'projects', 'y', `${third}.jsonl`), '{}\n');
  expect(await conversationExists(dir, third)).toBe(true);
});

it('words one notice per run mode', () => {
  expect(Object.keys(RUN_NOTICES).sort()).toEqual(['first', 'fresh', 'resume']);
  expect(RUN_NOTICES.first).toBe('Atlas: first run, the task prompt was sent.\r\n');
});

const id = '11111111-1111-4111-8111-111111111111';
const claude = ['claude', '--model', 'x'];
const base = {
  profile: agentProfile(claude),
  command: claude,
  prompt: 'do it',
  sandboxed: false,
  agentSessionId: id,
  hookSettings: null,
};

it('builds the Claude arguments for each run mode', () => {
  expect(sessionArgs({ ...base, mode: 'first' })).toEqual([
    '--model',
    'x',
    '--session-id',
    id,
    'do it',
  ]);
  expect(sessionArgs({ ...base, mode: 'resume' })).toEqual(['--model', 'x', '--resume', id]);
  expect(sessionArgs({ ...base, mode: 'fresh' })).toEqual(['--model', 'x', '--session-id', id]);
});

it('adds sandbox arguments and hook settings before the mode part', () => {
  const input = { ...base, sandboxed: true, hookSettings: '{"hooks":{}}', prompt: '-rf' };
  expect(sessionArgs({ ...input, mode: 'first' })).toEqual([
    '--model',
    'x',
    '--dangerously-skip-permissions',
    '--settings',
    '{"hooks":{}}',
    '--session-id',
    id,
    ' -rf',
  ]);
  expect(sessionArgs({ ...input, mode: 'resume' })).toEqual([
    '--model',
    'x',
    '--dangerously-skip-permissions',
    '--settings',
    '{"hooks":{}}',
    '--resume',
    id,
  ]);
});

it('keeps the Codex and custom arguments free of IDs and settings', () => {
  const codex = ['codex', '--foo'];
  const input = {
    ...base,
    profile: agentProfile(codex),
    command: codex,
    hookSettings: '{"x":1}',
  };
  expect(sessionArgs({ ...input, mode: 'first' })).toEqual(['--foo', 'do it']);
  expect(sessionArgs({ ...input, mode: 'resume' })).toEqual(['--foo']);
  expect(sessionArgs({ ...input, mode: 'fresh' })).toEqual(['--foo']);
  const custom = ['my-agent', 'a'];
  const customInput = { ...input, profile: agentProfile(custom), command: custom };
  expect(sessionArgs({ ...customInput, mode: 'first' })).toEqual(['a']);
});
