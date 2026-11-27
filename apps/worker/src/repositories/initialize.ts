import { execFile } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';
import type { CommandOutcome, RepositoryInitCommand } from '@atlas/contracts';
import { RepositoryInitCommandSchema } from '@atlas/contracts';
import { childEnvironment } from '../git-environment.js';
import type { JournalEntry } from '../state/journal.js';
import type { Journal } from '../state/journal.js';
import { resolveTarget } from './paths.js';

const run = promisify(execFile);
export interface ExecutionContext {
  root: string;
  journal: Journal;
  git?: string;
  onAccepted?: () => void;
}
const failure = (code: string, message: string, attention = false): CommandOutcome => ({
  status: attention ? 'needs_attention' : 'failed',
  error: { code, message },
});

export async function recoverCommand(
  entry: JournalEntry,
  context: ExecutionContext,
): Promise<CommandOutcome> {
  if (entry.outcome) return entry.outcome;
  try {
    const target = await resolveTarget(context.root, entry.command.payload.relativePath);
    if (target !== entry.target) throw new Error('Worker workspace changed');
    const info = await lstat(target);
    if (
      !entry.identity ||
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.dev !== entry.identity.dev ||
      info.ino !== entry.identity.ino
    )
      throw new Error('Folder ownership is uncertain');
    const gitInfo = await lstat(resolve(target, '.git'));
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink())
      throw new Error('Git initialization is incomplete');
    const { stdout } = await run(context.git ?? 'git', ['rev-parse', '--show-toplevel'], {
      cwd: target,
      timeout: 10_000,
      env: childEnvironment(context.root),
    });
    if (stdout.trim() !== target) throw new Error('Unexpected Git working directory');
    return { status: 'succeeded', localPath: target };
  } catch {
    return failure(
      'recovery_uncertain',
      `Inspect the preserved target before retrying: ${entry.target}`,
      true,
    );
  }
}

export async function initializeRepository(
  command: RepositoryInitCommand,
  context: ExecutionContext,
): Promise<CommandOutcome> {
  if (!RepositoryInitCommandSchema.safeParse(command).success) {
    return failure('invalid_command', 'Invalid repository initialization request');
  }
  const previous = context.journal.get(command.commandId);
  if (previous) {
    if (!isDeepStrictEqual(previous.command.payload, command.payload)) {
      throw new Error('A command id cannot be reused with a different payload');
    }
    const outcome = await recoverCommand(previous, context);
    context.journal.write({ ...previous, stage: 'finished', outcome });
    return outcome;
  }
  let target: string;
  try {
    target = await resolveTarget(context.root, command.payload.relativePath);
  } catch (error) {
    const outcome = failure(
      'invalid_target',
      error instanceof Error ? error.message : 'Invalid repository path',
    );
    context.journal.write({
      command,
      target: command.payload.relativePath,
      stage: 'finished',
      identity: null,
      outcome,
      acknowledged: false,
    });
    return outcome;
  }
  let entry: JournalEntry = {
    command,
    target,
    stage: 'queued',
    identity: null,
    outcome: null,
    acknowledged: false,
  };
  context.journal.write(entry);
  context.onAccepted?.();
  let outcome: CommandOutcome;
  try {
    await mkdir(target);
    const info = await lstat(target);
    entry = { ...entry, stage: 'created', identity: { dev: info.dev, ino: info.ino } };
    context.journal.write(entry);
    await run(context.git ?? 'git', ['init', '--quiet', '--', target], {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: childEnvironment(context.root),
    });
    outcome = { status: 'succeeded', localPath: target };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'git_failed';
    outcome = failure(
      code,
      `Could not initialize ${target}. Existing or partial folders were preserved. ${error instanceof Error ? error.message : ''}`,
    );
  }
  context.journal.write({ ...entry, stage: 'finished', outcome });
  return outcome;
}
