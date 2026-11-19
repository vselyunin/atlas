import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [stage, command, ...args] = process.argv.slice(2);

// Once a package has source or test files, run its real tool with default failure behavior.
const hasSource = existsSync('src') || existsSync('index.html');
const hasTests = existsSync('tests') || existsSync('test') || existsSync('__tests__');
if (!hasSource && !(stage === 'test' && hasTests)) {
  console.log(`Skipping ${stage} for scaffold package ${process.env.npm_package_name}.`);
} else {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
