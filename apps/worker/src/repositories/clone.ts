import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CREDENTIAL_REPLY_TIMEOUT_MS, RepositoryCloneCommandSchema } from '@atlas/contracts';
import type { CommandOutcome, RepositoryCloneCommand } from '@atlas/contracts';
import { isLoopbackUrl } from '../config.js';
import { childEnvironment } from '../git-environment.js';
import type { JournalEntry } from '../state/journal.js';
import { CredentialRefused, CredentialUnavailable } from './credential.js';
import type { CredentialRequester, GrantedCredential } from './credential.js';
import { recoverCommand } from './initialize.js';
import type { ExecutionContext } from './initialize.js';
import { resolveTarget } from './paths.js';

/**
 * The credential helper, next to this module both in `src` and in `dist` (the build copies it).
 * Git runs it with `/bin/sh`, so it needs no executable bit.
 */
export const credentialHelperPath = fileURLToPath(
  new URL('./git-credential-helper.sh', import.meta.url),
);

// The only variable that carries the token, read by the helper in the network Git processes.
const TOKEN_VARIABLE = 'ATLAS_GIT_TOKEN';
const NETWORK_TIME_LIMIT_MS = 30 * 60_000;
const LOCAL_TIME_LIMIT_MS = 10 * 60_000;
const MAX_OUTPUT = 64 * 1024;

export interface CloneContext extends ExecutionContext {
  gitHostUrl: string;
  requestCredential: CredentialRequester;
  /** Aborted when the Worker stops: the running Git process is ended. */
  signal: AbortSignal;
  /** How long to wait for a credential reply; tests shorten it. */
  credentialTimeoutMs?: number;
}

const failure = (code: string, message: string, attention = false): CommandOutcome => ({
  status: attention ? 'needs_attention' : 'failed',
  error: { code, message },
});

const uncertain = (target: string) =>
  failure('recovery_uncertain', `Inspect the preserved target before retrying: ${target}`, true);

class GitFailure extends Error {
  constructor(
    message: string,
    readonly reason: 'exit' | 'aborted' | 'timeout' | 'spawn',
  ) {
    super(message);
  }
}

/**
 * The repository's address on the Git host, built with URL resolution from encoded segments.
 * Returns null for a name the address cannot carry safely, such as a `.` or `..` segment.
 */
export function repositoryAddress(gitHostUrl: string, fullName: string): URL | null {
  const [owner, name, ...rest] = fullName.split('/');
  if (!owner || !name || rest.length > 0) return null;
  if ([owner, name].some((segment) => segment === '.' || segment === '..')) return null;
  const base = new URL(gitHostUrl);
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  const address = new URL(`${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, base);
  if (address.origin !== base.origin || address.pathname !== `${base.pathname}${owner}/${name}`)
    return null;
  return address;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The environment for every Git process of a clone: the Worker's child environment without any
 * Git variable that could redirect the repository, enable tracing or supply credentials, with
 * user-level configuration off, no terminal prompts and no LFS smudging.
 */
function cloneEnvironment(root: string): Record<string, string> {
  const env = childEnvironment(root);
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') && name !== 'GIT_CEILING_DIRECTORIES') delete env[name];
  }
  delete env.SSH_ASKPASS;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

// Command-line configuration shared by every Git process of a clone.
const commonConfig = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'submodule.recurse=false',
];

/**
 * Configuration for the processes that hold the token and talk to the Git host. They run without
 * system configuration (GIT_CONFIG_NOSYSTEM), so the target is trusted from the command line,
 * where Git honours safe.directory. Background maintenance is off: it would inherit the token.
 */
function networkConfig(host: URL, target: string): string[] {
  const protocol = host.protocol.slice(0, -1);
  const helper = `!/bin/sh ${[credentialHelperPath, protocol, host.host].map(shellQuote).join(' ')}`;
  return [
    `safe.directory=${target}`,
    // An empty value clears any other helper; only ours remains.
    'credential.helper=',
    `credential.helper=${helper}`,
    'core.askPass=',
    'http.sslVerify=true',
    // An empty value clears any extra header.
    'http.extraHeader=',
    'http.followRedirects=false',
    'maintenance.auto=false',
    'gc.auto=0',
    'fetch.writeCommitGraph=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    ...(protocol === 'http' && isLoopbackUrl(host) ? ['protocol.http.allow=always'] : []),
    'fetch.recurseSubmodules=false',
    ...commonConfig,
  ];
}

// Processes without the token never reach the network.
const localConfig = ['protocol.allow=never', ...commonConfig];

const withConfig = (config: string[], args: string[]) => [
  ...config.flatMap((entry) => ['-c', entry]),
  ...args,
];

function scrub(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  return result.trim().slice(-1_000);
}

/**
 * Runs Git in its own process group so that ending it also ends its helpers. The signal and the
 * time limit kill the whole group. Standard error is scrubbed of the secrets before it is used.
 */
function runGit(
  git: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
    secrets?: string[];
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new GitFailure('The clone was stopped', 'aborted'));
      return;
    }
    const child = spawn(git, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let reason: 'aborted' | 'timeout' | undefined;
    let settled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT);
    });
    const kill = (why: 'aborted' | 'timeout') => {
      reason ??= why;
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    const onAbort = () => kill('aborted');
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);
    const finish = (error: GitFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.on('error', (error) =>
      finish(new GitFailure(scrub(error.message, options.secrets ?? []), 'spawn')),
    );
    child.on('close', (code) => {
      if (reason === 'aborted') finish(new GitFailure('The clone was stopped', 'aborted'));
      else if (reason === 'timeout') finish(new GitFailure('Git took too long', 'timeout'));
      else if (code === 0) finish(null);
      else finish(new GitFailure(scrub(stderr, options.secrets ?? []), 'exit'));
    });
  });
}

/** Waits for the credential at most the reply timeout, and no longer than the command runs. */
async function requestCredential(
  context: CloneContext,
  commandId: string,
): Promise<GrantedCredential> {
  const timeout = AbortSignal.timeout(context.credentialTimeoutMs ?? CREDENTIAL_REPLY_TIMEOUT_MS);
  const signal = AbortSignal.any([context.signal, timeout]);
  return new Promise<GrantedCredential>((resolve, reject) => {
    const onAbort = () =>
      reject(
        new CredentialUnavailable(
          context.signal.aborted
            ? 'The command was stopped'
            : 'No credential reply arrived in time',
        ),
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    context
      .requestCredential(commandId, signal)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function defaultBranch(lsRemote: string): string | null {
  for (const line of lsRemote.split('\n')) {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Clones a GitHub repository into a new folder in the workspace. The folder is made and journaled
 * first, then a credential is requested over the Worker socket. The token reaches Git only
 * through the environment of the processes that talk to the Git host, read by the credential
 * helper; checking out happens in processes without it. The journal records `cloned` only after
 * every Git step exited successfully, so recovery can tell a finished clone from a partial one.
 */
export async function cloneRepository(
  command: RepositoryCloneCommand,
  context: CloneContext,
): Promise<CommandOutcome> {
  if (!RepositoryCloneCommandSchema.safeParse(command).success) {
    return failure('invalid_command', 'Invalid repository clone request');
  }
  const previous = context.journal.get(command.commandId);
  // Stopped before this clone began: leave no journal entry, folder or acceptance behind, so the
  // API dispatches it again after the next connection.
  if (!previous && context.signal.aborted) {
    return failure('clone_interrupted', 'The Worker stopped before the clone began', true);
  }
  if (previous) {
    if (!isDeepStrictEqual(previous.command.payload, command.payload)) {
      throw new Error('A command id cannot be reused with a different payload');
    }
    // A clone without an outcome that never reached `cloned` may be partial.
    const outcome =
      previous.outcome || previous.stage === 'cloned'
        ? await recoverCommand(previous, context)
        : uncertain(previous.target);
    context.journal.write({ ...previous, stage: 'finished', outcome });
    return outcome;
  }

  const { repository, relativePath } = command.payload;
  const finishEarly = (target: string, outcome: CommandOutcome) => {
    context.journal.write({
      command,
      target,
      stage: 'finished',
      identity: null,
      outcome,
      acknowledged: false,
    });
    return outcome;
  };
  let target: string;
  try {
    target = await resolveTarget(context.root, relativePath);
  } catch (error) {
    return finishEarly(
      relativePath,
      failure('invalid_target', error instanceof Error ? error.message : 'Invalid repository path'),
    );
  }
  const address = repositoryAddress(context.gitHostUrl, repository);
  if (!address) {
    return finishEarly(
      target,
      failure('invalid_repository', `Cannot clone a repository named ${repository}`),
    );
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

  const git = context.git ?? 'git';
  const env = cloneEnvironment(context.root);
  const preserved = `The folder ${target} was preserved.`;
  let outcome: CommandOutcome;
  try {
    try {
      await mkdir(target);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'mkdir_failed';
      throw Object.assign(
        new Error(`Could not create ${target}. Existing folders are preserved.`),
        {
          outcomeCode: code,
        },
      );
    }
    const info = await lstat(target);
    entry = { ...entry, stage: 'created', identity: { dev: info.dev, ino: info.ino } };
    context.journal.write(entry);
    await runGit(git, withConfig(localConfig, ['init', '--quiet', '--', target]), {
      env,
      signal: context.signal,
      timeoutMs: LOCAL_TIME_LIMIT_MS,
    });

    let credential: GrantedCredential;
    try {
      credential = await requestCredential(context, command.commandId);
    } catch (error) {
      if (error instanceof CredentialRefused) return finish(failure(error.code, error.message));
      return finish(
        failure(
          context.signal.aborted ? 'clone_interrupted' : 'credential_unavailable',
          `${error instanceof Error ? error.message : 'No credential arrived'}. ${preserved}`,
          true,
        ),
      );
    }
    if (credential.repository !== repository) {
      return finish(
        failure(
          'repository_renamed',
          `The repository ${repository} is now ${credential.repository}. Link the project again. ${preserved}`,
        ),
      );
    }
    const token = credential.token;
    if (!/^[\x21-\x7e]+$/.test(token)) {
      return finish(
        failure('invalid_credential', `The API sent an unusable credential. ${preserved}`),
      );
    }

    // The two processes that hold the token: read the default branch, then fetch every branch
    // with the tags that point into them. Neither writes the address or the token anywhere.
    const secrets = [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
    const network = {
      cwd: target,
      // No system configuration: it could weaken TLS, add headers or add credential helpers.
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', [TOKEN_VARIABLE]: token },
      signal: context.signal,
      timeoutMs: NETWORK_TIME_LIMIT_MS,
      secrets,
    };
    const config = networkConfig(address, target);
    const head = await runGit(
      git,
      withConfig(config, ['ls-remote', '--symref', '--', address.href, 'HEAD']),
      network,
    );
    await runGit(
      git,
      withConfig(config, [
        'fetch',
        '--quiet',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--',
        address.href,
        '+refs/heads/*:refs/remotes/origin/*',
      ]),
      network,
    );

    // Without the token: record origin, then check out the default branch with hooks off.
    const local = { cwd: target, env, signal: context.signal, timeoutMs: LOCAL_TIME_LIMIT_MS };
    await runGit(git, withConfig(localConfig, ['remote', 'add', 'origin', address.href]), local);
    const branches = (
      await runGit(
        git,
        withConfig(localConfig, [
          'for-each-ref',
          '--format=%(refname:lstrip=3)',
          'refs/remotes/origin/',
        ]),
        local,
      )
    )
      .split('\n')
      .filter(Boolean);
    const branch = defaultBranch(head);
    const usable = (name: string | null): name is string =>
      name !== null && !name.startsWith('-') && !name.includes('..');
    if (branches.length === 0) {
      // An empty repository: nothing to check out. Point HEAD at the host's default if known.
      if (usable(branch))
        await runGit(
          git,
          withConfig(localConfig, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]),
          local,
        );
    } else {
      if (!usable(branch) || !branches.includes(branch)) {
        return finish(
          failure('default_branch_unknown', `Could not tell the default branch. ${preserved}`),
        );
      }
      await runGit(git, withConfig(localConfig, ['remote', 'set-head', 'origin', branch]), local);
      await runGit(
        git,
        withConfig(localConfig, [
          'checkout',
          '--quiet',
          '--no-recurse-submodules',
          '--track',
          '-b',
          branch,
          `refs/remotes/origin/${branch}`,
        ]),
        local,
      );
    }
    entry = { ...entry, stage: 'cloned' };
    context.journal.write(entry);
    outcome = { status: 'succeeded', localPath: target };
  } catch (error) {
    if (error instanceof GitFailure && error.reason === 'aborted') {
      outcome = failure(
        'clone_interrupted',
        `The clone was stopped. Inspect the preserved target before retrying: ${target}`,
        true,
      );
    } else {
      const code =
        error instanceof Error && 'outcomeCode' in error
          ? String(error.outcomeCode)
          : error instanceof GitFailure && error.reason === 'timeout'
            ? 'clone_timeout'
            : 'git_failed';
      const detail = error instanceof Error ? error.message : '';
      outcome = failure(
        code,
        code === 'git_failed' || code === 'clone_timeout'
          ? `Could not clone ${repository} into ${target}. ${preserved} ${detail}`.trim()
          : detail,
      );
    }
  }
  return finish(outcome);

  function finish(result: CommandOutcome): CommandOutcome {
    context.journal.write({ ...entry, stage: 'finished', outcome: result });
    return result;
  }
}
