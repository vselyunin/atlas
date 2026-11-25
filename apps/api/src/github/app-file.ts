import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const AppSecretsSchema = z.strictObject({
  appId: z.int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  account: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
});
export type AppSecrets = z.infer<typeof AppSecretsSchema>;

// The GitHub App's ID, names and secrets, kept in one file outside SQLite with mode 0600.
// Error messages name the path only: the file's content is secret.
export class AppFile {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  read(): AppSecrets | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw this.unreadable();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw this.unreadable();
    }
    const result = AppSecretsSchema.safeParse(parsed);
    if (!result.success) throw this.unreadable();
    return result.data;
  }

  write(secrets: AppSecrets): void {
    const content = `${JSON.stringify(AppSecretsSchema.parse(secrets), null, 2)}\n`;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(this.path)) {
      throw new Error(`GitHub App file already exists: ${this.path}`);
    }
    const temporary = join(
      directory,
      `.${basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      if (existsSync(this.path)) {
        throw new Error(`GitHub App file already exists: ${this.path}`);
      }
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  isUnder(directory: string): boolean {
    const inside = relative(canonical(directory), canonical(this.path));
    return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  }

  private unreadable() {
    return new Error(`GitHub App file is not readable: ${this.path}`);
  }
}

// Resolves symbolic links in the longest part of the path that exists.
function canonical(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  return join(realpathSync(existing), relative(existing, absolute));
}
