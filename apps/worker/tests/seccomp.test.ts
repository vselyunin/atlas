import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { narrowProfile } from '../../../scripts/seccomp.mjs';

const sandboxRule = {
  names: ['clone', 'clone3', 'unshare', 'mount', 'umount2', 'pivot_root'],
  action: 'SCMP_ACT_ALLOW',
};

async function readProfile(name: string): Promise<{ syscalls: unknown[] }> {
  const text = await readFile(new URL(`../../../docker/worker/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as { syscalls: unknown[] };
}

describe('Worker seccomp profile', () => {
  it('equals the profile derived from the Docker default', async () => {
    const defaultProfile = await readProfile('seccomp-default.json');
    const profile = await readProfile('seccomp.json');

    expect(profile).toEqual(narrowProfile(defaultProfile));
  });

  it('differs from the Docker default by exactly one appended allow rule', async () => {
    const defaultProfile = await readProfile('seccomp-default.json');
    const profile = await readProfile('seccomp.json');

    expect(profile.syscalls).toHaveLength(defaultProfile.syscalls.length + 1);
    expect(profile.syscalls.at(-1)).toEqual(sandboxRule);
    expect({ ...profile, syscalls: profile.syscalls.slice(0, -1) }).toEqual(defaultProfile);
  });

  it('leaves the default profile it derives from unchanged', async () => {
    const defaultProfile = await readProfile('seccomp-default.json');
    const copy = structuredClone(defaultProfile);

    narrowProfile(defaultProfile);

    expect(defaultProfile).toEqual(copy);
  });
});
