// Stand-in agent for Worker tests. Plain Node, no dependencies.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);

if (flag('--ignore-hup') !== -1) {
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => {});
}

const slowStart = flag('--slow-start');
if (slowStart !== -1) {
  await new Promise((resolve) => setTimeout(resolve, Number(args[slowStart + 1] ?? 0)));
}

console.log(`READY ${process.cwd()}`);
console.log(`ARGS ${JSON.stringify(args)}`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'env') {
    const names = Object.keys(process.env).filter(
      (name) => name.startsWith('ATLAS_') || name.startsWith('GIT_'),
    );
    console.log(`ENV ${JSON.stringify(names)}`);
  } else if (line === 'commit') {
    const git = (...gitArgs) =>
      execFileSync(
        'git',
        ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...gitArgs],
        { stdio: 'ignore' },
      );
    writeFileSync('agent.txt', 'work\n');
    git('add', '-A');
    git('commit', '-m', 'agent work');
    console.log('COMMITTED');
  } else if (line.startsWith('exit ')) {
    process.exit(Number(line.slice(5)));
  } else {
    console.log(`ECHO ${line}`);
  }
});
