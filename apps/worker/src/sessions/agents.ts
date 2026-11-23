import { basename, join } from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'custom';

export interface AgentProfile {
  kind: AgentKind;
  // Whether the task prompt is passed to the agent as its last argument.
  takesPrompt: boolean;
  // Added only when the Atlas sandbox is on, because the sandbox then enforces the boundary.
  sandboxArgs: string[];
  // Servers the agent needs to reach its model.
  domains: string[];
  // The agent's own login and state paths: its writable directories and files together.
  writablePaths(home: string): string[];
  // The sandbox can make only an existing path writable, so the Worker creates these first.
  writableDirectories(home: string): string[];
  // Writable files; the Worker does not create them.
  writableFiles(home: string): string[];
}

interface WritablePath {
  path: string;
  kind: 'directory' | 'file';
}

type ProfileDefinition = Omit<
  AgentProfile,
  'writablePaths' | 'writableDirectories' | 'writableFiles'
> & { writable: (home: string) => WritablePath[] };

function defineProfile({ writable, ...profile }: ProfileDefinition): AgentProfile {
  const paths = (home: string, kind?: WritablePath['kind']) =>
    writable(home)
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => entry.path);
  return {
    ...profile,
    writablePaths: (home) => paths(home),
    writableDirectories: (home) => paths(home, 'directory'),
    writableFiles: (home) => paths(home, 'file'),
  };
}

const profiles: Record<AgentKind, AgentProfile> = {
  claude: defineProfile({
    kind: 'claude',
    takesPrompt: true,
    sandboxArgs: ['--dangerously-skip-permissions'],
    domains: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', '*.claude.com'],
    writable: (home) => [
      { path: join(home, '.claude'), kind: 'directory' },
      { path: join(home, '.claude.json'), kind: 'file' },
      // Claude exits when it cannot create its temporary folder.
      { path: '/tmp/claude', kind: 'directory' },
    ],
  }),
  // Unverified under the sandbox.
  codex: defineProfile({
    kind: 'codex',
    takesPrompt: true,
    sandboxArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    domains: ['api.openai.com', 'auth.openai.com', 'chatgpt.com', '*.chatgpt.com'],
    writable: (home) => [{ path: join(home, '.codex'), kind: 'directory' }],
  }),
  custom: defineProfile({
    kind: 'custom',
    takesPrompt: false,
    sandboxArgs: [],
    domains: [],
    writable: () => [],
  }),
};

export function agentProfile(command: string[]): AgentProfile {
  const name = basename(command[0] ?? '');
  return name === 'claude' || name === 'codex' ? profiles[name] : profiles.custom;
}

export function agentArgs(
  profile: AgentProfile,
  command: string[],
  prompt: string,
  sandboxed: boolean,
): string[] {
  const args = command.slice(1);
  if (sandboxed) args.push(...profile.sandboxArgs);
  if (prompt && profile.takesPrompt) {
    // A leading dash would be read as a command-line option of the agent.
    args.push(prompt.startsWith('-') ? ` ${prompt}` : prompt);
  }
  return args;
}
