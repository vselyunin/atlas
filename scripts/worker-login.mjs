import { fileURLToPath } from 'node:url';
import {
  HOME_VOLUME,
  IMAGE,
  buildImage,
  ensureDocker,
  runCommand,
  serviceFacts,
} from './worker-container.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const clis = ['claude', 'codex'];
const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--');
const cli = args[0] ?? 'claude';
if (args.length > 1 || !clis.includes(cli)) {
  console.error(`Usage: pnpm worker:login [${clis.join('|')}]`);
  process.exit(2);
}

try {
  await ensureDocker({
    run: runCommand,
    ...serviceFacts(),
    log: (message) => console.log(message),
  });
  await buildImage({ run: runCommand, repoRoot: root });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const login = await runCommand(
  'docker',
  ['run', '-it', '--rm', '-v', `${HOME_VOLUME}:/home/atlas`, '--entrypoint', cli, IMAGE],
  { stdio: 'inherit' },
);
process.exit(login.code ?? 1);
