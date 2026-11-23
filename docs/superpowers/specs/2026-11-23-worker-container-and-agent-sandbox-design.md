# Worker container and agent sandbox

Status: written design approved by the user on 2026-11-23.

## Intent and scope

Atlas runs an agent CLI per task in a Git worktree and shows its terminal on the
Board. Today that agent runs as the user's own WSL account and can read and
write anything the user can. The user wants agents sandboxed to their task's
worktree, and wants the work on the `spike/agent-terminal` branch (worktrees,
sessions, the Board terminal) turned from a spike into tested code.

This design does three things:

1. Packages the Worker as a Docker image and runs it in a container, so the
   container is the wall between agents and the user's machine.
2. Has the Worker wrap every agent process in a sandbox that confines it to its
   task's worktree, so tasks in one Worker are kept apart.
3. Adds automated tests for the session and worktree behavior the spike built,
   and for the new container and sandbox behavior.

The longer-term picture is several Workers on different machines. This round
stops at one containerized Worker on the user's machine, built so that nothing
in the image assumes that machine.

## Goals

- A misbehaving agent cannot write outside its own worktree, apart from the
  specific Git and login paths listed below.
- An agent cannot read the Worker token or the Worker's state directory.
- The user's machine exposes only the workspace folder and the Worker state
  folder to the container.
- An agent never runs unsandboxed by accident. If the sandbox cannot start, the
  session fails with a clear message.
- The everyday development stack runs agents the same way a deployed Worker
  would: in the container, sandboxed. Board and API work stays possible without
  Docker.
- Session, worktree, sandbox and container behavior is covered by tests.

## Non-goals

- Remote Workers: an API reachable from other machines, per-Worker tokens,
  cloning from a Git URL, pushing task branches, choosing a Worker on the Board.
- A container per task.
- Hiding one task's files from another task's agent. Reads across worktrees are
  allowed this round.
- Persisting sessions across Worker or API restarts.
- Changes to the Worker protocol or shared contracts. None are needed; if the
  builder finds one is, stop and raise it with the user.

## Anti-goals

- A sandbox that silently degrades. Running an agent with weaker protection than
  configured, without failing or saying so, is worse than not starting.
- Describing tasks as isolated from each other. The container is the strong
  wall; the per-agent sandbox is a second layer with the known gaps listed under
  "Known limits".
- Mounting the user's home directory, personal Claude or Codex login, or the
  Docker socket into the container.

## Approaches

Three decisions were made in conversation, each from tested alternatives.

**Where the wall goes.** The user first proposed one container per agent.
Mounting a worktree alone breaks Git, because a worktree keeps its history in
the main checkout's `.git` folder; the alternatives were mounting the main
`.git` too (leaky), having the Worker commit from outside (agent loses Git), or
replacing worktrees with clones. Per-task containers also require the Worker to
control Docker, a large permission on a remote server. The user chose to put
the Worker itself in a container and confine each agent inside it with a
lighter sandbox. This keeps the worktree and session code and makes a Worker
one image that can be started anywhere.

**How an agent is held to its worktree.** Two ways were tested with a real,
logged-in Claude inside a container:

- A: each agent's own sandbox mode. Claude confines its shell commands; file
  edits are held only by permission rules, each agent is configured differently,
  and it cannot be tested without a real logged-in agent.
- B: the Worker wraps the whole agent process in Anthropic's sandbox runtime
  (`@anthropic-ai/sandbox-runtime`, command `srt`). File edits and shell
  commands are both stopped by the system, it is the same for any agent, and a
  stand-in program can try to break out in automated tests. The agent must be
  able to write its own login folder, and Atlas maintains the list of servers
  the agent may reach.

The user chose B.

**How the container permits the sandbox.** The sandbox needs system calls that
Docker's default seccomp filter refuses. The alternatives were turning the
filter off, a custom profile, or not sandboxing inside the container. The user
chose a custom narrow profile, with the filter turned off as a fallback only if
the profile proved unworkable. It did not: the profile works.

Other decisions by the user:

- `pnpm dev` runs the Worker in the container, and a separate command runs the
  API and Board without a Worker. Keeping a native Worker with the sandbox off
  as the everyday stack was rejected.
- Finish line "A": one containerized Worker locally, ready to move; no second
  machine this round.
- Agents log in separately from the user's personal account. The login lives in
  a Docker volume and is created by logging in once inside the container.
- Docker Engine runs inside the user's Arch WSL distro, started by hand (no
  systemd), not Docker Desktop.

## What was verified before this design

These were run in a throwaway image (`node:22-bookworm-slim`, bubblewrap 0.8.0,
Claude Code 2.1.330, Docker 29.10 in WSL2). They are evidence, not tests; the
builder turns the relevant ones into tests.

- `node-pty` builds and spawns in the image.
- In a default container the sandbox cannot start, as root or as a normal user.
- With Docker's default seccomp profile plus an unconditional allow rule for
  `clone`, `clone3`, `unshare`, `mount`, `umount2` and `pivot_root`, the sandbox
  starts as a non-root user. Without `pivot_root` it fails. Root was not made to
  work and is not needed.
- With write access to the worktree and to `<main>/.git/objects`,
  `<main>/.git/worktrees/<name>`, `<main>/.git/refs/heads/atlas` and
  `<main>/.git/logs`, commits from the worktree work, and writes to
  `<main>/.git/hooks`, `<main>/.git/config`, the main checkout, another worktree
  and anywhere else are refused. Allowing only the task's own branch file is not
  enough, because Git creates a lock file beside it.
- Real Claude wrapped by `srt` runs non-interactively and interactively through
  a PTY, reaches its model through the sandbox's network filter with
  `api.anthropic.com`, `*.anthropic.com`, `claude.ai`, `*.claude.ai` and
  `*.claude.com` allowed, and needs `~/.claude`, `~/.claude.json` and
  `/tmp/claude` writable. Its file-edit tool is refused outside the worktree by
  the system.
- The sandbox places placeholder device files in the working directory for
  names it protects (`.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`,
  `.vscode`, `.idea` and others). They vanish when the command ends, but while
  it runs `git add -A` fails on them. Adding files by name works.

Not verified: Codex in the sandbox, Claude's interactive UI with permission
prompts disabled, the Git-ignore fix for the placeholder files, and the sandbox
when the Worker runs natively in WSL as root.

## Design

### Worker image

A Dockerfile in the repository builds one image that contains:

- the built Worker and its production dependencies, including a compiled
  `node-pty`;
- Node 22, Git, bubblewrap, socat and ripgrep;
- the `claude` and `codex` CLIs and `@anthropic-ai/sandbox-runtime`, with
  pinned versions;
- a non-root user, UID 1001, that runs the Worker and the agents. The existing
  `atlas-agent-home` volume holds a Claude login owned by UID 1001; keeping
  that UID lets the user avoid logging in again. If the builder has to change
  it, say so, because the user must then repeat the login.

The image takes all configuration from the existing `ATLAS_*` environment
variables. It contains no token, no paths from the user's machine and no login.

### Running the container

The container is started with:

- the workspace root and the Worker state directory bind-mounted at the same
  absolute paths they have on the host. Existing worktrees record absolute
  paths, so a different mount point would break them. Nothing else from the
  host is mounted.
- a named Docker volume, `atlas-agent-home`, as the container user's home
  directory, holding the agent logins.
- the narrow seccomp profile, checked into the repository as a JSON file. It is
  Docker's default profile plus one allow rule for the six system calls above.
  Record which Docker version the default was taken from, and add a test or
  script that shows the file equals that default plus the one rule, so a later
  update is mechanical.
- no added capabilities, no `--privileged`, no Docker socket.
- host networking, so the Worker reaches the API at `127.0.0.1` and the
  Worker's local-address check stays as it is. This is the author's call. It
  means a process that escaped both the agent sandbox and stayed inside the
  container could reach other local services in WSL. The agent sandbox's own
  network filter is what keeps agents off the local network. Revisit it with
  remote Workers, which need real network authentication anyway.

The Worker's existing state-directory lock already prevents a native Worker and
a containerized Worker from running against the same state at once. The
containerized Worker uses the same Worker ID, journal and workspace as the
native one did, so existing projects and worktrees carry over.

> Found during final review (2026-11-23): the lock does not do this. It decides
> liveness with a PID probe, which cannot see across PID namespaces, so a native
> Worker and a containerized Worker on the same state directory can each treat
> the other's lock as stale and take it over. Two containers sharing a state
> directory with the same PID also take over each other's lock. This is
> documented as a known limit in `docs/development/local-setup.md`; a lock that
> does not depend on PIDs is a planned follow-up.

The existing integration and end-to-end test helpers start their own native
Worker and are not changed by this design; the Worker package's own `dev` and
`start` scripts remain for them and for debugging.

The workspace must be writable by the container user. On the user's machine the
workspace is on a Windows drive under WSL, where that holds. If it is not
writable, the Worker should fail at startup with a message that says so.

### Commands

- `pnpm dev` changes: it starts the API and Board natively and the Worker in
  the container. The user chose this because the container is the real way
  agents run, and developing against anything else would hide problems. It
  builds the image when needed, including after Worker or contracts source
  changes. If the Docker service is not running, it starts it when it can (the
  user's WSL runs as root without systemd) and otherwise prints what to run.
  Stopping the command stops the container.
- A new root command starts only the API and Board, with no Worker, for Board
  and API work without Docker. The Board then shows the Worker as offline and
  sessions cannot start. No everyday command runs a Worker natively.
- A new root command opens an interactive agent CLI in a container with the
  login volume, so the user can log in to Claude or Codex once.
- A new root command runs the Docker test group.

Names are left to the builder; follow the existing `dev` and `test:*` style.

### Agent sandbox

The Worker wraps each agent process in `srt` when it spawns it. The PTY is
attached to the wrapped process, so the Board terminal behaves as today.

For each session the Worker writes a sandbox settings file outside anything the
agent can write, and passes it to `srt`. Pass the agent command and its
arguments to `srt` as separate arguments, not as one shell string, so a task
title or description cannot be interpreted by a shell.

Writable paths:

- the task's worktree;
- in the project's main checkout: `.git/objects`, `.git/worktrees/<this
worktree>`, `.git/refs/heads/atlas` and `.git/logs`;
- the agent's own login and state paths. For Claude these are `~/.claude`,
  `~/.claude.json` and its temporary folder (`/tmp/claude`); for Codex, its
  equivalent, to be determined by the builder;
- nothing else.

Unreadable paths: the Worker state directory. The sandbox gives the agent a
separate process view, so it also cannot read the Worker's environment. The
existing removal of `ATLAS_*` variables from the agent's environment stays.

Network: only the servers the agent needs to reach its model, as a per-agent
default list, plus any hosts named in a new Worker setting for extra allowed
domains (for example a package registry). The default extra list is empty.

Because the sandbox enforces the boundary, the agent is started with its
permission prompts turned off (`--dangerously-skip-permissions` for Claude, the
equivalent for Codex), so it does not ask before each command or edit. It still
asks the user real questions about the task. The agent's own nested sandbox is
left off. This default is the author's proposal, accepted by the user in
conversation as part of choosing B; it applies only when the Atlas sandbox is
on.

A Worker setting controls the sandbox with two values:

- required (the Worker's default wherever it runs): if `srt` or its
  prerequisites are missing or the sandbox fails to start, the session ends
  with a message naming the cause. The agent is not started.
- off: the agent runs as it does on the spike branch today, with the agent's
  normal permission prompts. This exists for tests with a stand-in agent and
  for a user who knowingly sets it. It must be an explicit setting, and no root
  command sets it.

The sandbox is designed and verified for the container only. A Worker run
natively on the user's machine with the sandbox required is not a supported
setup this round: the user's WSL runs as root, where the sandbox was not made to
work, and the agent would use the user's personal login. Such a session fails
closed like any other where the sandbox cannot start.

When a session starts, the Worker writes one line to the terminal saying
whether the sandbox is on, before the agent's own output. This needs no
protocol change.

The Worker also makes Git ignore the sandbox's placeholder files for the agent,
so `git add -A` works. The intended way is a Git excludes file supplied through
the agent's environment, so the user's repository is not modified. The builder
verifies this works under the sandbox; if it does not, find another way that
does not edit files inside the user's repository, or raise it.

Claude asks whether to trust a folder the first time it opens a new worktree.
This round the user answers that on the Board. Pre-approving it is left to the
builder if it is simple and does not weaken the sandbox.

### Agents

Claude is the default agent and the only one this round must support and verify
under the sandbox. Codex is not a blocking part of this round (the author's
call): the CLI is in the image, and the builder may wire its server list, login
path and flags if that is quick, but should not plan a checkpoint that waits on
a Codex login. Unless it has been seen working, document Codex as unverified
under the sandbox. A custom `ATLAS_AGENT_COMMAND` is wrapped the same way, with
no model servers allowed by default.

### Git identity for agent commits

The container does not see the user's `~/.gitconfig`, so commits made by an
agent need an identity from somewhere. The Worker gets two new settings, a name
and an email for agent commits, and passes them to the agent through Git's
environment variables. The container start command fills them from the host
user's `git config user.name` and `user.email` when they are not set, so task
branches carry the user's identity as they do today. If neither a setting nor a
host identity exists, the Worker leaves Git to report the missing identity. This
is the author's call.

### What stays from the spike

The spike's code is kept: `SessionManager`, the worktree logic, `SessionHub`,
the Board session socket, the Board terminal, the session contracts and the
`agent.session` capability. The work continues on the `spike/agent-terminal`
branch. Defects that the new tests expose are fixed in production code.

Task branch names stay `atlas/task-<task id>`. Giving each task its own branch
folder would stop one agent moving another task's branch pointer, but agents
share a writable object store anyway, so the gain is small and it would add a
third naming scheme. This is the author's call.

## Tests

The project rule stands: existing test files are not modified without the
user's explicit permission. All tests below go in new files. If a change to an
existing test, test helper or test configuration turns out to be necessary,
stop and ask the user, naming the file, the exact change and the reason.

Fast group, part of `pnpm check`, with a stand-in agent program and the
sandbox off. It must not need Docker, bubblewrap or a logged-in agent.

- Contracts: session message schemas, limits, and the two accepted capability
  lists.
- Worker sessions and worktrees, with real Git and a real PTY: worktree and
  branch naming by full task ID; reuse of an existing worktree including the
  older 8-character form; the empty-repository initial commit leaving the
  user's index and hooks alone; two first starts at once; Stop while starting;
  a start that finishes preparing after the Worker stops does not spawn; forced
  kill of an agent that ignores the hangup; refusal of project folders or
  worktree parents that are links or not real directories; `ATLAS_*` variables
  absent from the agent's environment; a prompt beginning with a dash not read
  as an option; re-announcing a running session under a new run ID; reporting
  a missing session as exited.
- Worker sandbox wiring: the generated sandbox settings and agent arguments for
  a given project, task and agent kind; required mode refusing to start when
  the sandbox is unavailable; off mode running unwrapped.
- API session hub and socket: start refused for an unknown task, a project
  without a local checkout, an offline Worker and a Worker without the
  capability; messages with a stale run ID ignored; the replay buffer limit;
  snapshot and replay on connect; the Origin check; forwarding of input,
  resize and stop.
- Board: the session section toggle, the idle and disconnected states, the
  status line and buttons per state, and Esc inside the terminal not closing
  the task panel. The terminal library may be replaced by a test double.
- Integration: API and Worker together with the stand-in agent, driven through
  the Board socket: start, output, input, reattach with replay, stop, and
  reattach after an API restart.

Docker group, its own command, not part of `pnpm check`. It needs Docker and no
agent login.

- The image builds, and the Worker in a container registers with a test API.
- A session with a stand-in agent runs end to end through the Board socket with
  the sandbox required.
- A stand-in agent inside the sandbox can write its worktree and commit, and
  cannot: write the main checkout, another worktree, the main repository's
  hooks or config, or a path outside the workspace; read the Worker state
  directory; reach a host that is not allowed.
- `git add -A` works inside the sandbox.
- With the default seccomp profile instead of the narrow one, a session in
  required mode fails with the expected message and no agent runs.

Manual checks with a real logged-in Claude are added to
`docs/development/acceptance.md`: a session starts in the container, the agent
edits and commits in its worktree, cannot write outside it, and the interactive
UI works on the Board with permission prompts off.

## Documentation

- `docs/development/local-setup.md`: installing and starting Docker in WSL, the
  one-time agent login, the new commands, the sandbox setting and the extra
  allowed-domains setting.
- `docs/development/protocol.md`: remove the statement that sessions have no
  automated tests once that is true. No message changes.
- `AGENTS.md`: update the command list for the changed `pnpm dev`, the
  Worker-less command and the Docker test group.

## Known limits

- All agents in a Worker share one login folder and can read and write it. One
  task's agent could read the credentials or change the agent settings used by
  the others.
- An agent can read other tasks' worktrees and the main checkout.
- An agent can move or delete another task's `atlas/` branch pointer and can
  damage the shared Git object store.
- The six extra system calls are among the more sensitive ones Docker blocks by
  default. The narrow profile is tighter than no filter and looser than
  Docker's default.
- The container uses host networking.
- Anyone running the image elsewhere needs the seccomp profile file as well.
- Sessions and their output still live in memory only.

## Deferred: isolating agent logins

The user decided to keep one shared login folder this round and research the
login topic separately before changing it. This design must not attempt it. What
was learned, for that later work:

- A copy of the login folder per task would stop cross-task tampering, but
  several copies refreshing one login may invalidate each other. Not tested.
- An empty settings folder per task (`CLAUDE_CONFIG_DIR`) gives an agent a
  clean, logged-out state; this was seen working. A long-lived token from
  `claude setup-token`, handed to each agent at start, would then log it in
  without shared writable state. That step was not tested, and a leaked
  long-lived token stays usable far longer than a normal access token.
- A credential proxy run by the Worker, so the agent never holds the token, is
  the strongest option. It is known to suit a pay-per-use API key; whether it
  works with a subscription login is unknown.

## Left to the builder

- File layout, command names, setting names, and whether `srt` is used as a
  command or as a library.
- How the image is built from the workspace (for example a multi-stage build).
- The exact per-agent server lists and login paths, found by running the agent.
- How the Docker tests provide an API, a workspace and a stand-in agent.
- Pinned versions of the agent CLIs and the sandbox runtime.
