// Stand-in agent for the Docker tests: tries to leave its worktree, reports each result and exits.
// Plain Node, no dependencies. Argument 1 is the Worker state directory.
import { execFile } from 'node:child_process';
import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [stateDir = ''] = process.argv.slice(2);
const cwd = process.cwd();

// Prints `PROBE <name> ok` when the action succeeds, `PROBE <name> blocked` when it fails.
async function probe(name, action) {
  try {
    await action();
    console.log(`PROBE ${name} ok`);
  } catch (error) {
    console.log(`PROBE ${name} blocked`);
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`PROBE-DETAIL ${name} ${reason}`);
  }
}

const git = async (...args) => (await run('git', args, { cwd })).stdout.trim();
const commonDir = await git('rev-parse', '--path-format=absolute', '--git-common-dir');
const mainCheckout = dirname(commonDir);

await probe('write-worktree', () => writeFile(join(cwd, 'probe-worktree.txt'), 'probe\n'));
await probe('commit', async () => {
  await writeFile(join(cwd, 'probe-commit.txt'), 'probe\n');
  await git('add', '-A');
  await git('commit', '-m', 'probe');
});
await probe('write-main-checkout', () => writeFile(join(mainCheckout, 'probe.txt'), 'probe\n'));

// Other tasks' worktrees are the sibling folders of this one.
const others = (await readdir(dirname(cwd), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== basename(cwd))
  .map((entry) => join(dirname(cwd), entry.name));
if (others.length === 0) console.log('PROBE write-other-worktree untested');
else {
  await probe('write-other-worktree', async () => {
    for (const other of others) await writeFile(join(other, 'probe.txt'), 'probe\n');
  });
}

await probe('write-main-hooks', () => writeFile(join(commonDir, 'hooks', 'probe'), 'probe\n'));
await probe('write-main-config', () => appendFile(join(commonDir, 'config'), '# probe\n'));
await probe('write-outside', () => writeFile('/tmp/atlas-probe', 'probe\n'));
await probe('read-state-dir', async () => {
  // The sandbox hides a denied folder behind an empty one, so an empty listing is a refusal.
  const entries = await readdir(stateDir);
  if (entries.length === 0) throw new Error('the folder appears empty');
});
await probe('network', async () => {
  // Node's fetch uses the sandbox's proxy only with NODE_USE_ENV_PROXY, which it reads at startup.
  // The short timeout makes a hang count as blocked.
  const script = `try {
      const response = await fetch('https://example.com', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
    } catch (error) {
      const cause = error.cause ? ' (' + (error.cause.code ?? error.cause.message) + ')' : '';
      console.error(error.name === 'TimeoutError' ? 'timed out' : error.message + cause);
      process.exit(1);
    }`;
  try {
    await run(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
      timeout: 10_000,
    });
  } catch (error) {
    const details = /** @type {{ killed?: boolean; stderr?: string }} */ (error);
    throw new Error(details.killed ? 'timed out' : details.stderr?.trim() || String(error), {
      cause: error,
    });
  }
});

console.log(`PROBE argv ${JSON.stringify(process.argv.slice(3))}`);
