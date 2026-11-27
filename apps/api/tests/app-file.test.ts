import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppFile } from '../src/github/app-file.js';
import type { AppSecrets } from '../src/github/app-file.js';

const SECRETS: AppSecrets = {
  appId: 7,
  slug: 'atlas-file',
  name: 'Atlas file',
  account: 'octo',
  clientId: 'Iv1.file',
  clientSecret: 'file-client-secret',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfile\n-----END RSA PRIVATE KEY-----\n',
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-app-file-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('AppFile', () => {
  it('writes the secrets with mode 0600 and reads them back', async () => {
    const path = join(directory, 'nested', 'github-app.json');
    const file = new AppFile(path);
    file.write(SECRETS);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(file.read()).toEqual(SECRETS);
  });

  it('reads a missing file as null', () => {
    expect(new AppFile(join(directory, 'missing.json')).read()).toBeNull();
  });

  it('names the path, and nothing from the file, when the file does not parse', async () => {
    const path = join(directory, 'github-app.json');
    await writeFile(path, '{');
    expect(() => new AppFile(path).read()).toThrow(`GitHub App file is not readable: ${path}`);
  });

  it('refuses a file that parses but lacks fields, without echoing its content', async () => {
    const path = join(directory, 'github-app.json');
    await writeFile(path, JSON.stringify({ ...SECRETS, appId: 'nope' }));
    let message = '';
    try {
      new AppFile(path).read();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`GitHub App file is not readable: ${path}`);
    expect(message).not.toContain(SECRETS.clientSecret);
  });

  it('refuses to replace an existing file', async () => {
    const path = join(directory, 'github-app.json');
    await writeFile(path, 'existing');
    const file = new AppFile(path);
    expect(() => file.write(SECRETS)).toThrow();
    expect(() => file.read()).toThrow('GitHub App file is not readable');
  });

  it('tells whether the file lies under a directory', () => {
    const file = new AppFile(join(directory, 'state', 'github-app.json'));
    expect(file.isUnder(directory)).toBe(true);
    expect(file.isUnder(join(directory, 'state'))).toBe(true);
    expect(file.isUnder(join(directory, 'state', '..', 'state'))).toBe(true);
    expect(file.isUnder(join(directory, 'stat'))).toBe(false);
    expect(file.isUnder(join(directory, 'other'))).toBe(false);
    const dotted = new AppFile(join(directory, '..atlas', 'github-app.json'));
    expect(dotted.isUnder(directory)).toBe(true);
    expect(new AppFile(join(directory, '..', 'github-app.json')).isUnder(directory)).toBe(false);
  });
});
