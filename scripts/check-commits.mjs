import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [base] = args;

if (args.length !== 1 || base.startsWith('-')) {
  console.error('Usage: pnpm check:commits -- <base>');
  process.exit(2);
}

const [from, to = 'HEAD', ...extra] = base.split('..');
if (!from || !to || to.startsWith('-') || extra.length > 0) {
  console.error('Expected a Git base or a base..tip range.');
  process.exit(2);
}
const result = spawnSync('commitlint', ['--from', from, '--to', to], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
