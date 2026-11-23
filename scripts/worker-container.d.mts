export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'pipe' | 'inherit';
  logFile?: string;
}

/** Exit code (null when the command could not start) and standard output. */
export interface RunResult {
  code: number | null;
  stdout: string;
}

export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export declare const IMAGE: 'atlas-worker:dev';
export declare const HOME_VOLUME: 'atlas-agent-home';

export declare const runCommand: Run;

export declare function serviceFacts(): { isRoot: boolean; hasSystemd: boolean };

/** Arguments after `docker` that start the Worker container. Variables are passed by name only. */
export declare function runArgs(options: {
  name: string;
  env: Record<string, string | undefined>;
  repoRoot: string;
}): string[];

export declare function ensureDocker(options: {
  run: Run;
  isRoot: boolean;
  hasSystemd: boolean;
  log: (message: string) => void;
}): Promise<void>;

export declare function buildImage(options: { run: Run; repoRoot: string }): Promise<void>;

export declare function hostGitIdentity(options: {
  run: Run;
}): Promise<{ name?: string; email?: string }>;
