import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionActivityDetailSchema } from '@atlas/contracts';
import { agentProfile } from '../src/sessions/agents.js';
import { sandboxSettings } from '../src/sessions/sandbox.js';
import type { Worktree } from '../src/sessions/worktree.js';
import {
  MAX_STATUS_FILE_BYTES,
  hookSettings,
  parseStatus,
  watchStatus,
  writeHookScript,
} from '../src/sessions/status.js';
import type { AgentActivity } from '../src/sessions/status.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'atlas-status-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('parseStatus', () => {
  it('reads valid lines', () => {
    expect(parseStatus('working -\nneeds_input asked_in_text\nidle -\nerror rate_limit\n')).toEqual(
      [
        { activity: 'working', detail: null },
        { activity: 'needs_input', detail: 'asked_in_text' },
        { activity: 'idle', detail: null },
        { activity: 'error', detail: 'rate_limit' },
      ],
    );
  });

  it('drops junk, unknown values and over-long lines', () => {
    const long = `error ${'x'.repeat(70)}`;
    const text = ['junk', 'working', 'sleeping -', 'error nonsense', long, 'idle - extra', 'idle -']
      .concat('')
      .join('\n');
    expect(parseStatus(text)).toEqual([{ activity: 'idle', detail: null }]);
  });
});

describe('hook script', () => {
  async function runHook(event: string, input: string): Promise<{ lines: string; stdout: string }> {
    const script = await writeHookScript(base);
    const file = join(base, 'status');
    const result = spawnSync('node', [script, event, file], { input, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = await readFile(file, 'utf8').catch(() => '');
    return { lines, stdout: result.stdout };
  }

  it('is created read-only and only once', async () => {
    const script = await writeHookScript(base);
    expect(script).toBe(join(base, 'hook.cjs'));
    expect((await stat(script)).mode & 0o777).toBe(0o444);
    expect(await writeHookScript(base)).toBe(script);
  });

  it('writes needs_input asked_in_text for a message ending in a question', async () => {
    const message = 'SECRET-TEXT should I continue?  ';
    const { lines, stdout } = await runHook(
      'Stop',
      JSON.stringify({ last_assistant_message: message }),
    );
    expect(lines).toBe('needs_input asked_in_text\n');
    expect(`${lines}${stdout}`).not.toContain('SECRET-TEXT');
  });

  it('writes idle for any other message', async () => {
    const { lines, stdout } = await runHook(
      'Stop',
      JSON.stringify({ last_assistant_message: 'SECRET-TEXT done.' }),
    );
    expect(lines).toBe('idle -\n');
    expect(`${lines}${stdout}`).not.toContain('SECRET-TEXT');
  });

  it.each([
    ['UserPromptSubmit', 'working -\n'],
    ['PostToolUse', 'working -\n'],
    ['PreToolUse', 'needs_input -\n'],
    ['PermissionRequest', 'needs_input -\n'],
  ])('maps %s', async (event, line) => {
    expect((await runHook(event, '{}')).lines).toBe(line);
  });

  it('takes the failure kind from error, then error_type, else unknown', async () => {
    for (const [input, detail] of [
      [{ error: 'rate_limit' }, 'rate_limit'],
      [{ error_type: 'billing_error' }, 'billing_error'],
      [{ error: 'rate_limit', error_type: 'server_error' }, 'rate_limit'],
      [{ error: 'bogus; rm -rf' }, 'unknown'],
      [{}, 'unknown'],
    ] as const) {
      await rm(join(base, 'status'), { force: true });
      expect((await runHook('StopFailure', JSON.stringify(input))).lines).toBe(`error ${detail}\n`);
    }
  });

  it('exits 0 and writes a safe line for malformed input', async () => {
    expect((await runHook('Stop', 'not json')).lines).toBe('idle -\n');
    await rm(join(base, 'status'), { force: true });
    expect((await runHook('Stop', '')).lines).toBe('idle -\n');
  });

  it('exits 0 for an unknown event or an unwritable file', async () => {
    expect((await runHook('Other', '{}')).lines).toBe('');
    const script = await writeHookScript(base);
    const result = spawnSync('node', [script, 'Stop', join(base, 'missing', 'status')], {
      input: '{}',
    });
    expect(result.status).toBe(0);
  });

  it('only writes lines that parseStatus accepts, for every detail code', async () => {
    for (const detail of SessionActivityDetailSchema.options) {
      await rm(join(base, 'status'), { force: true });
      const { lines } = await runHook('StopFailure', JSON.stringify({ error: detail }));
      expect(parseStatus(lines)).toEqual([{ activity: 'error', detail }]);
    }
  });
});

describe('hookSettings', () => {
  it('registers the events with the fixed matchers', () => {
    const settings = JSON.parse(hookSettings('/tmp/a/hook.cjs', '/tmp/b/status')) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'Stop',
      'StopFailure',
      'UserPromptSubmit',
    ]);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion');
    for (const event of ['PermissionRequest', 'PostToolUse', 'Stop', 'StopFailure']) {
      expect(settings.hooks[event]?.[0]).not.toHaveProperty('matcher');
    }
    expect(settings.hooks.Stop?.[0]?.hooks).toEqual([
      { type: 'command', command: "node '/tmp/a/hook.cjs' Stop '/tmp/b/status'" },
    ]);
  });

  it('quotes or refuses unsafe paths', () => {
    const quoted = hookSettings("/tmp/it's here/hook.cjs", '/tmp/$(x)/status');
    expect(quoted).toContain(String.raw`'/tmp/it'\\''s here/hook.cjs'`);
    expect(quoted).toContain("'/tmp/$(x)/status'");
    expect(() => hookSettings('/tmp/a\nb/hook.cjs', '/tmp/s')).toThrow();
    expect(() => hookSettings('/tmp/a/hook.cjs', 'relative/status')).toThrow();
  });
});

describe('watchStatus', () => {
  const seen: AgentActivity[] = [];
  const stops: (() => void)[] = [];

  beforeEach(() => {
    seen.length = 0;
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  function watch(file: string): void {
    const watcher = watchStatus(file, (a) => seen.push(a), 10);
    stops.push(() => watcher.stop());
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('waits for a missing file, then reports the last valid line of each read', async () => {
    const file = join(base, 'status');
    watch(file);
    await sleep(40);
    expect(seen).toEqual([]);
    await writeFile(file, 'working -\njunk\nidle -\n');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toEqual({ activity: 'idle', detail: null });
    await appendFile(file, 'needs_input asked_in_text\n');
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]).toEqual({ activity: 'needs_input', detail: 'asked_in_text' });
  });

  it('waits for the end of a partial line', async () => {
    const file = join(base, 'status');
    await writeFile(file, 'idle');
    watch(file);
    await sleep(40);
    expect(seen).toEqual([]);
    await appendFile(file, ' -\n');
    await expect.poll(() => seen.length).toBe(1);
  });

  it('ignores a symlink', async () => {
    const target = join(base, 'target');
    await writeFile(target, 'working -\n');
    const link = join(base, 'link');
    await symlink(target, link);
    watch(link);
    await sleep(60);
    expect(seen).toEqual([]);
  });

  it('does not block on a named pipe and never reads it', async () => {
    const file = join(base, 'status');
    execFileSync('mkfifo', [file]);
    watch(file);
    await sleep(60);
    expect(seen).toEqual([]);
    // The event loop is still free to run the timers.
    await rm(file);
    await writeFile(file, 'idle -\n');
    await sleep(60);
    expect(seen).toEqual([]);
  });

  it('stops for good past the size limit', async () => {
    const file = join(base, 'status');
    watch(file);
    await writeFile(file, 'working -\n');
    await expect.poll(() => seen.length).toBe(1);
    await appendFile(file, `${'idle -\n'.repeat(Math.ceil(MAX_STATUS_FILE_BYTES / 7))}`);
    await sleep(60);
    expect(seen.length).toBe(1);
    await writeFile(file, 'error unknown\n');
    await sleep(60);
    expect(seen.length).toBe(1);
  });

  it('stops when asked', async () => {
    const file = join(base, 'status');
    const watcher = watchStatus(file, (a) => seen.push(a), 10);
    watcher.stop();
    await writeFile(file, 'working -\n');
    await sleep(60);
    expect(seen).toEqual([]);
  });
});

describe('sandboxSettings extraWritable', () => {
  const worktree: Worktree = {
    path: '/w/path',
    gitDir: '/w/git',
    commonDir: '/w/common',
  } as unknown as Worktree;
  const input = {
    worktree,
    stateDir: '/state',
    home: '/home/u',
    profile: agentProfile(['claude']),
    allowedDomains: [],
  };

  it('appends the folders to allowWrite only when given', () => {
    const plain = sandboxSettings(input);
    expect(sandboxSettings({ ...input, extraWritable: undefined })).toEqual(plain);
    const extra = sandboxSettings({ ...input, extraWritable: ['/tmp/status/key'] });
    expect(extra.filesystem.allowWrite).toEqual([
      ...plain.filesystem.allowWrite,
      '/tmp/status/key',
    ]);
    expect(extra.filesystem.denyRead).toEqual(plain.filesystem.denyRead);
    expect(extra.filesystem.denyWrite).toEqual(plain.filesystem.denyWrite);
  });
});
