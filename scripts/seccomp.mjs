import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

// bubblewrap needs these to build the agent sandbox; Docker's default allows them only with
// CAP_SYS_ADMIN, which the Worker container does not get.
const sandboxRule = {
  names: ['clone', 'clone3', 'unshare', 'mount', 'umount2', 'pivot_root'],
  action: 'SCMP_ACT_ALLOW',
};

/** Returns Docker's default seccomp profile plus the one rule the agent sandbox needs. */
export function narrowProfile(defaultProfile) {
  const profile = structuredClone(defaultProfile);
  profile.syscalls = [...profile.syscalls, structuredClone(sandboxRule)];
  return profile;
}

const defaultPath = new URL('../docker/worker/seccomp-default.json', import.meta.url);
const profilePath = new URL('../docker/worker/seccomp.json', import.meta.url);

async function main(mode) {
  const derived = narrowProfile(JSON.parse(await readFile(defaultPath, 'utf8')));
  if (mode === '--write') {
    // Write the profile as the repository formatter would, so the format check stays clean.
    const prettier = await import('prettier');
    const filepath = fileURLToPath(profilePath);
    const options = await prettier.resolveConfig(filepath);
    await writeFile(
      profilePath,
      await prettier.format(JSON.stringify(derived), { ...options, filepath }),
    );
    return 0;
  }
  const current = JSON.parse(await readFile(profilePath, 'utf8'));
  if (isDeepStrictEqual(current, derived)) return 0;
  console.error(
    'docker/worker/seccomp.json differs from the profile derived from seccomp-default.json.',
  );
  console.error('Run `node scripts/seccomp.mjs --write` to regenerate it.');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--write', '--check'].includes(mode)) {
    console.error('Usage: node scripts/seccomp.mjs --write|--check');
    process.exit(2);
  }
  process.exitCode = await main(mode);
}
