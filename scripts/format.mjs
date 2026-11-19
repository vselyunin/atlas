import { spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (process.argv.length > 3 || (mode && !['--check', '--list'].includes(mode))) {
  console.error('Usage: node scripts/format.mjs [--check|--list]');
  process.exit(2);
}

const listing = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
});
if (listing.status !== 0) {
  console.error(listing.error?.message ?? listing.stderr);
  process.exit(2);
}

const protectedDirectory =
  /^(?:__.*(?:test|spec|snapshot|fixture|mock).*__|e2e|tests?|specs?|snapshots?|fixtures?)$/i;
const protectedFile = /(?:^|[._-])(?:e2e|tests?|specs?|snapshots?|fixtures?)(?:[._-]|$)|\.snap$/i;
const testConfig = /^(?:vitest|playwright|jest)(?:[.-].*)?\.(?:config|workspace)\./i;
const rootPath = await realpath(root);
const candidates = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
let failures = 0;

for (const file of candidates) {
  if (file === 'pnpm-lock.yaml' || file.startsWith('docs/superpowers/')) continue;
  const segments = file.split('/');
  const protectedPath =
    segments.slice(0, -1).some((segment) => protectedDirectory.test(segment)) ||
    protectedFile.test(segments.at(-1)) ||
    testConfig.test(segments.at(-1));
  if (mode !== '--check' && protectedPath) continue;

  const path = resolve(root, file);
  const target = await realpath(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (target !== path || !target.startsWith(rootPath + sep)) continue;

  const info = await prettier.getFileInfo(path);
  if (info.ignored || !info.inferredParser) continue;
  if (mode === '--list') {
    console.log(file);
    continue;
  }

  const source = await readFile(path, 'utf8');
  const options = await prettier.resolveConfig(path);
  const formatted = await prettier.format(source, { ...options, filepath: path });
  if (source === formatted) continue;
  if (mode === '--check') {
    console.error(file);
    failures++;
  } else {
    await writeFile(path, formatted);
  }
}

if (failures > 0) {
  console.error(`Formatting differs in ${failures} file(s).`);
  process.exitCode = 1;
}
