import { pathToFileURL } from 'node:url';
import { loadConfig, prepareConfig } from './config.js';
import type { WorkerConfigInput } from './config.js';
import { acquireLock } from './state/lock.js';
import { Journal } from './state/journal.js';
import { connect } from './connection.js';
import { workspaceProblem } from './repositories/permissions.js';

export function startWorker(input: WorkerConfigInput): { stop(): Promise<void> } {
  const config = prepareConfig(input);
  const release = acquireLock(config.stateDir);
  try {
    const journal = new Journal(config.stateDir);
    const connection = connect(config, journal);
    return {
      async stop() {
        try {
          await connection.stop();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig(process.env);
    const worker = startWorker(config);
    // Sessions on existing repositories still work in such a workspace, so the Worker keeps
    // running and says at once why new repositories and clones will be refused.
    void workspaceProblem(config.root).then((problem) => {
      if (problem) console.error(`Warning: ${problem} New repositories and clones are refused.`);
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void worker.stop().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : 'Worker shutdown failed');
        process.exitCode = 1;
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker failed to start');
    process.exitCode = 1;
  }
}
