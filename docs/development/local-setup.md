# Run Atlas locally

Run commands inside WSL from the Atlas repository. Use the Node version in
`.nvmrc`, pnpm version in `package.json`, and Git available on PATH. The Worker
runs in a Docker container, so Docker must be installed in WSL (see below).

```sh
pnpm install --frozen-lockfile
pnpm worker:login   # once, to log the agent in
pnpm dev
```

Open <http://localhost:5173> in your Windows browser. The combined launcher builds
shared contracts, builds the Worker image `atlas-worker:dev`, and starts the API and
Board natively and the Worker in the container `atlas-worker`. The image is built on
every start, so a change to Worker or contracts code reaches the container on the next
`pnpm dev`; Docker's cache keeps an unchanged rebuild fast. Docker prints a
deprecation notice about the legacy builder on each build; that is expected. The
launcher generates a local Worker token if one is not configured, without printing it.
The API listens on port 4310. The Worker reconnects if it starts before the API is ready.

Commands:

- `pnpm dev`: API and Board natively, Worker in the container.
- `pnpm dev:web`: API and Board only, with no Worker and no Docker. The Board shows
  the Worker as offline and sessions cannot start.
- `pnpm worker:login [claude|codex]`: opens the agent CLI in a container with the login
  volume, once, so the agent is logged in. The default is `claude`.
- `pnpm test:docker`: the Docker test group. It needs Docker and no agent login, and it
  is not part of `pnpm check`.

Default local state is in the ignored `.atlas/` directory:

- `atlas.sqlite`: projects, versions, tasks and operations.
- `projects/`: new project repositories created by the Worker.
- `worker/`: Worker lock and durable command journal. The lock file holds `<pid> <token>`;
  a lock left by a container that was killed hard is taken over on the next start.
- `worker-token`: secret shared by the local API and Worker.

Ctrl+C stops all services, including the container; it does not erase data or
repositories. Restart with `pnpm dev`. Do not run two copies of the same Worker
identity/state directory.

Closing the terminal that runs `pnpm dev`, instead of pressing Ctrl+C, can leave the API,
Board and the `atlas-worker` container running. Clean up with `docker rm -f atlas-worker`
and stop the leftover node processes; check their ownership first. Do not start a second
stack while they run.

## Docker in WSL

Install Docker Engine inside the WSL distribution; Docker Desktop is not needed. On Arch,
which this project was built on, that was `pacman -Syu docker socat`. It is a full system
upgrade; other distributions use their own packages and commands. Without systemd the
Docker service does not start by itself. When `pnpm dev` or `pnpm worker:login` runs as
root without systemd and the service is down, it starts `dockerd` itself and writes its
log to `/var/log/dockerd.log`. Otherwise it prints that the service is not running; start
it with your init system or run `dockerd` yourself, then run the command again.

## Agent login

Agents run as the container user `atlas` (UID 1001). Their login lives in the Docker volume
`atlas-agent-home`, which is the container user's home directory. Run `pnpm worker:login`
once and log in inside the container. The volume holds a real login; never delete it, or you
must log in again. All agents of the Worker share this login.

## Agent sandbox

The Worker wraps every agent in the sandbox runtime `@anthropic-ai/sandbox-runtime`
(`srt`, version 0.0.83) inside the container. The container uses a narrow seccomp profile,
`docker/worker/seccomp.json`; see `docker/worker/README.md`. An agent can write only:

- its task's worktree;
- in the project's main checkout, `.git/objects`, `.git/worktrees/<this worktree>`,
  `.git/refs/heads/atlas` and `.git/logs`;
- its own login and state paths. For Claude these are `~/.claude`, `~/.claude.json` and
  `/tmp/claude`. The Worker creates the folders (`~/.claude` and `/tmp/claude`) before it
  starts the sandbox, because the sandbox can make only an existing folder writable.

It cannot read the Worker state directory and reaches only the servers its profile allows:
for Claude `api.anthropic.com`, `*.anthropic.com`, `claude.ai`, `*.claude.ai` and
`*.claude.com`. Because the sandbox enforces this, Claude starts with
`--dangerously-skip-permissions`, so the Board shows its permission-bypass warning. It still
asks the folder-trust question and real questions about the task; answer them on the Board.
When a session starts, the terminal first shows `Atlas: agent sandbox on...`.

If `srt` or its prerequisites are missing, or the sandbox does not start, the session ends
with a message naming the cause and the agent is not started.

The sandbox puts placeholder files in the worktree for names it protects, which would break
`git add -A`. The Worker therefore gives the agent a Git excludes file, through the agent's
environment, that ignores these eleven names at the worktree root: `.bash_profile`,
`.bashrc`, `.gitconfig`, `.gitmodules`, `.idea`, `.mcp.json`, `.profile`, `.ripgreprc`,
`.vscode`, `.zprofile` and `.zshrc`. Repository files are not modified. The side effect: a new
file with one of these names at the worktree root is not shown by `git status` and is not added
by `git add -A` for the agent; it must be added by name. The same names in subfolders are not
covered.

Codex is in the image but has not been verified under the sandbox. Treat it as unverified.

## Worker settings

Set these in `.env` (see `.env.example`) or the environment; `pnpm dev` passes them to the
container.

| Setting                       | Meaning                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATLAS_AGENT_COMMAND`         | The agent command, split on spaces. Default `claude`. A custom command is wrapped in the sandbox too and may reach no servers unless `ATLAS_AGENT_ALLOWED_DOMAINS` lists them.                                        |
| `ATLAS_AGENT_SANDBOX`         | `required` (default) or `off`. `off` runs the agent unwrapped with its normal permission prompts. It exists for tests with a stand-in agent; no command sets it.                                                      |
| `ATLAS_AGENT_ALLOWED_DOMAINS` | Comma-separated extra hosts the agent may reach, for example `registry.npmjs.org,*.example.com`. Entries are bare host names (wildcards like `*.example.com` allowed), with no scheme, path or spaces. Default empty. |
| `ATLAS_AGENT_GIT_NAME`        | Name for the agent's commits.                                                                                                                                                                                         |
| `ATLAS_AGENT_GIT_EMAIL`       | Email for the agent's commits.                                                                                                                                                                                        |

The container cannot see your `~/.gitconfig`. `pnpm dev` fills in only the values that
are missing, from the host's `git config user.name` and `user.email`. The Worker applies the
identity only when both name and email are set; otherwise Git reports the missing identity when
the agent commits.

## What the sandbox does not protect

- All agents in a Worker share one login folder and can read and write it. One
  task's agent could read the credentials or change the agent settings used by
  the others.
- An agent can read other tasks' worktrees and the main checkout.
- An agent can move or delete another task's `atlas/` branch pointer and can
  damage the shared Git object store.
- The six extra system calls (`clone`, `clone3`, `unshare`, `mount`, `umount2`,
  `pivot_root`) are among the more sensitive ones Docker blocks by default. The
  narrow profile is tighter than no filter and looser than Docker's default.
- The container uses host networking.
- Anyone running the image elsewhere needs the seccomp profile file as well.
- Sessions and their output still live in memory only.

The sandbox is verified only inside the container. A Worker run natively with the sandbox
required is not supported and fails closed.

## Configuration

Optionally copy `.env.example` to `.env` and customize values. The combined
launcher resolves relative database/workspace/state paths from the repository
root. Worker state must remain outside project repository targets. A new local
repository path is relative to the displayed workspace; its parent must already
exist and the final folder must not exist. Existing Git URL mode only records a
URL and never clones it.

For independently started apps (a native Worker without the container, for debugging
only; its sessions need `ATLAS_AGENT_SANDBOX=off`, and the agent then runs unsandboxed as your
own account and can change anything that account can), export the same
`ATLAS_WORKER_TOKEN` to API and Worker, use absolute filesystem paths, and run:

```sh
pnpm --filter @atlas/contracts build
pnpm --filter @atlas/api dev
pnpm --filter @atlas/worker dev
pnpm --filter @atlas/board dev
```

Use three terminals for these commands. Package-specific `.env` files can hold
the independent settings; the combined launcher reads the repository-root `.env`.
Never put the Worker token into Vite/browser environment variables.

All services are local-only. If Windows cannot reach WSL localhost forwarding,
check the Windows/WSL networking configuration; do not expose the API on all
interfaces as a workaround.

## Checks and test protection

`pnpm check` runs lint, formatting checks, type checks, tests and builds.
`pnpm format` formats unprotected source; it does not modify tests, snapshots or
fixtures. `pnpm format:check` still checks those files. Any existing-test change
requires explicit permission, including fixes suggested by a formatter.

Use Conventional Commits such as `feat(board): add task creation` and validate a
commit range with `pnpm check:commits -- <base-commit>`.

Run `pnpm setup:hooks` once after cloning to enable the repository's commit-message
hook. It checks messages without modifying source or tests.

## Browser verification and troubleshooting

Run `pnpm test:e2e` for browser acceptance. Install Playwright Chromium with
`pnpm exec playwright install chromium` if needed; its platform runtime libraries
must also be available. Browser tests use temporary data and separate ports
configured in `playwright.config.ts` and `scripts/e2e-server.mjs`.

The startup helper waits for the API and the intended Worker to be online before
starting the Board. A reachable Board alone does not mean the stack is ready.
Any replacement harness must clean up its child processes and temporary state
on success, failure and interruption. Keep personal `.atlas` data out of tests.

If the Worker is missing or offline:

1. Check API and Worker startup output, then request `/api/v1/workers` on the
   configured API port to inspect registration and availability.
2. Confirm the Worker WebSocket URL points to that API and both processes use
   the same token. Do not print or paste the token into logs or the Board.
3. Check for a duplicate Worker identity or an already-running process using
   its state directory. Inspect ownership before stopping any process; do not
   delete a lock or journal to bypass the problem.
4. Confirm the workspace and state paths are accessible Linux paths, with Worker
   state outside the repository workspace. Preserve journals when investigating
   failed operations or reconnects.

For an occupied test port or missing browser dependency, report the environment
problem separately from application failures. Do not weaken tests to hide it.
