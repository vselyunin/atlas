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
  // The agent's own login and state paths.
  writablePaths(home: string): string[];
}

const profiles: Record<AgentKind, AgentProfile> = {
  claude: {
    kind: 'claude',
    takesPrompt: true,
    sandboxArgs: ['--dangerously-skip-permissions'],
    domains: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', '*.claude.com'],
    writablePaths: (home) => [join(home, '.claude'), join(home, '.claude.json'), '/tmp/claude'],
  },
  // Unverified under the sandbox.
  codex: {
    kind: 'codex',
    takesPrompt: true,
    sandboxArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    domains: ['api.openai.com', 'auth.openai.com', 'chatgpt.com', '*.chatgpt.com'],
    writablePaths: (home) => [join(home, '.codex')],
  },
  custom: {
    kind: 'custom',
    takesPrompt: false,
    sandboxArgs: [],
    domains: [],
    writablePaths: () => [],
  },
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
