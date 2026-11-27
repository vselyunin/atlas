export function childEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Git hooks and the agent must not inherit the Worker token or other Atlas settings.
    if (value !== undefined && !name.startsWith('ATLAS_')) env[name] = value;
  }
  // Git must never fall through to a repository above the workspace, such as the Atlas checkout.
  env.GIT_CEILING_DIRECTORIES = root;
  return env;
}
