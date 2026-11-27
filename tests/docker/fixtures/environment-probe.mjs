// Stand-in agent for the credential isolation test. Plain Node, no dependencies.
// Arguments: the Worker state directory, then a JSON file that the test writes between the two
// sessions: `{ "worker": <pid>, "holder": <pid> }`.
//
// Without that file the agent is the holder: a long-running process that the Worker started with
// the marker variable in its environment. With it, the agent is the prober: it tries to read the
// environment of the Worker and of the holder, scans every process it can see, and lists the
// Worker state directory. It prints `PROBE <name> <result>` lines, and never prints what it read.
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

const [stateDir = '', targetsFile = ''] = process.argv.slice(2);
const MARKER_VARIABLE = 'PROBE_MARKER';
const marker = process.env[MARKER_VARIABLE] ?? '';

if (!existsSync(targetsFile)) {
  console.log('HOLDER READY');
  // Stays alive until the sandbox ends it.
  setInterval(() => {}, 60_000);
} else {
  const targets = JSON.parse(readFileSync(targetsFile, 'utf8'));

  // The sandbox may give an agent a process view of its own, where a pid from outside names
  // another process or none. So a target counts as reachable only when `/proc/<pid>` is a
  // process that really is the target, recognized by its command line; then `ok` means its
  // environment was read and `blocked` means it was refused. A target that cannot be found by
  // that pid is `blocked` too, with the reason in the detail line.
  const refusals = ['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'ENOTDIR'];
  const reason = (error) =>
    error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  async function readEnvironment(name, pid, recognizedBy) {
    let commandLine;
    try {
      commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    } catch (error) {
      console.log(`PROBE ${name} ${refusals.includes(reason(error)) ? 'blocked' : 'failed'}`);
      console.log(`PROBE-DETAIL ${name} not-visible ${reason(error)}`);
      return;
    }
    if (Number(pid) === process.pid || !commandLine.includes(recognizedBy)) {
      console.log(`PROBE ${name} blocked`);
      console.log(`PROBE-DETAIL ${name} not-visible pid-names-another-process`);
      return;
    }
    try {
      await readFile(`/proc/${pid}/environ`);
      console.log(`PROBE ${name} ok`);
    } catch (error) {
      console.log(`PROBE ${name} ${refusals.includes(reason(error)) ? 'blocked' : 'failed'}`);
      console.log(`PROBE-DETAIL ${name} refused ${reason(error)}`);
    }
  }

  // The positive control: the same read works for this process, so a refusal below is not
  // caused by the technique.
  try {
    const own = await readFile('/proc/self/environ', 'utf8');
    console.log(`PROBE read-own-environ ${own.includes(`${MARKER_VARIABLE}=`) ? 'ok' : 'failed'}`);
  } catch {
    console.log('PROBE read-own-environ failed');
  }

  await readEnvironment('read-worker-environ', targets.worker, 'dist/main.js');
  await readEnvironment('read-holder-environ', targets.holder, 'environment-probe.mjs');
  for (const [name, pid] of [
    ['worker', targets.worker],
    ['holder', targets.holder],
  ]) {
    console.log(`PROBE-DETAIL ${name}-pid-listed ${existsSync(`/proc/${pid}`)}`);
  }

  // Every process this one can see: none but this one may show the marker or the Worker token.
  let visible = 0;
  let readable = 0;
  const leaks = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    visible += 1;
    try {
      const environment = await readFile(`/proc/${entry}/environ`, 'utf8');
      readable += 1;
      if (
        (marker && environment.includes(marker)) ||
        /(^|\0)ATLAS_WORKER_TOKEN=/.test(environment)
      ) {
        leaks.push(entry);
      }
    } catch {
      // Not readable: the expected case.
    }
  }
  console.log(`PROBE scan-environ ${leaks.length === 0 ? 'blocked' : 'ok'}`);
  console.log(`PROBE-DETAIL scan-environ visible=${visible} readable=${readable}`);

  try {
    const entries = await readdir(stateDir);
    // The sandbox hides a denied folder behind an empty one, so an empty listing is a refusal.
    console.log(`PROBE list-state-dir ${entries.length === 0 ? 'blocked' : 'ok'}`);
  } catch {
    console.log('PROBE list-state-dir blocked');
  }
  console.log('PROBE done');
}
