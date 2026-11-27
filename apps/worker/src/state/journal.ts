import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CommandOutcomeSchema,
  RepositoryCloneCommandSchema,
  RepositoryInitCommandSchema,
} from '@atlas/contracts';

// Entries written before clones existed hold an init command and never the `cloned` stage.
// A clone is journaled `cloned` only after every Git step of the clone has exited successfully.
const EntrySchema = z.object({
  command: z.union([RepositoryInitCommandSchema, RepositoryCloneCommandSchema]),
  target: z.string(),
  stage: z.enum(['queued', 'created', 'cloned', 'finished']),
  identity: z.object({ dev: z.number(), ino: z.number() }).nullable(),
  outcome: CommandOutcomeSchema.nullable(),
  acknowledged: z.boolean(),
});
export type JournalEntry = z.infer<typeof EntrySchema>;

export class Journal {
  private readonly directory: string;
  constructor(stateDir: string) {
    this.directory = join(stateDir, 'commands');
    mkdirSync(this.directory, { recursive: true });
  }
  private path(id: string): string {
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  get(id: string): JournalEntry | null {
    try {
      return EntrySchema.parse(JSON.parse(readFileSync(this.path(id), 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  write(entry: JournalEntry): void {
    const value = EntrySchema.parse(entry);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path(value.command.commandId));
    const directoryFd = openSync(this.directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
  entries(): JournalEntry[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        EntrySchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8'))),
      );
  }
  acknowledge(id: string): void {
    const entry = this.get(id);
    if (entry?.stage === 'finished') this.write({ ...entry, acknowledged: true });
  }
}
