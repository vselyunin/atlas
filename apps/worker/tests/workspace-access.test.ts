import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, chown, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareConfig } from '../src/config.js';

const run = promisify(execFile);
const configModule = new URL('../src/config.ts', import.meta.url).href;
const otherUid = 1001;
const isRoot = process.getuid?.() === 0;
const hasModes = process.platform !== 'win32';

// Runs prepareConfig in a child Node process as UID/GID 1001, because access checks always pass
// for root. Resolves with the error message, or undefined when prepareConfig succeeded.
async function prepareAsOtherUser(root: string, stateDir: string): Promise<string | undefined> {
  const script = `
    const { prepareConfig } = await import(${JSON.stringify(configModule)});
    try {
      prepareConfig({ apiUrl: 'ws://127.0.0.1:4310/api/v1/workers/connect', token: 't',
        id: 'atlas:test', name: 'Test', root: ${JSON.stringify(root)},
        stateDir: ${JSON.stringify(stateDir)} });
      console.log(JSON.stringify({}));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    uid: otherUid,
    gid: otherUid,
    cwd: '/',
    env: { PATH: process.env.PATH ?? '' },
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { error?: string };
  return result.error;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-workspace-access-'));
  await chmod(dir, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!isRoot)(
  'workspace access as another user (tests run as root)',
  { timeout: 20_000 },
  () => {
    it('accepts a workspace and state directory the Worker user owns', async () => {
      const root = join(dir, 'root');
      const stateDir = join(dir, 'state');
      await mkdir(root);
      await mkdir(stateDir);
      await chown(root, otherUid, otherUid);
      await chown(stateDir, otherUid, otherUid);
      await expect(prepareAsOtherUser(root, stateDir)).resolves.toBeUndefined();
    });

    it('fails at startup when the workspace belongs to another user', async () => {
      const root = join(dir, 'root');
      const stateDir = join(dir, 'state');
      await mkdir(root, { mode: 0o755 });
      await mkdir(stateDir);
      await chown(stateDir, otherUid, otherUid);
      await expect(prepareAsOtherUser(root, stateDir)).resolves.toBe(
        `The workspace ${root} is not writable by the Worker user (uid ${otherUid})`,
      );
    });

    it('fails at startup when the state directory belongs to another user', async () => {
      const root = join(dir, 'root');
      const stateDir = join(dir, 'state');
      await mkdir(root);
      await chown(root, otherUid, otherUid);
      await mkdir(stateDir, { mode: 0o755 });
      await expect(prepareAsOtherUser(root, stateDir)).resolves.toBe(
        `The state directory ${stateDir} is not writable by the Worker user (uid ${otherUid})`,
      );
    });
  },
);

// Without root the current user cannot drop privileges, but a read-only folder it owns shows the
// same check. Windows has no POSIX modes.
describe.skipIf(isRoot || !hasModes)('workspace access as the current user', () => {
  it('fails at startup when the workspace is read-only', async () => {
    const root = join(dir, 'root');
    await mkdir(root, { mode: 0o555 });
    expect(() =>
      prepareConfig({
        apiUrl: 'ws://127.0.0.1:4310/api/v1/workers/connect',
        token: 't',
        id: 'atlas:test',
        name: 'Test',
        root,
        stateDir: join(dir, 'state'),
      }),
    ).toThrow(`The workspace ${root} is not writable by the Worker user`);
  });
});
