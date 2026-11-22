# Worker Container and Agent Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Atlas Worker in a Docker container, wrap every agent in a
sandbox that confines it to its task worktree, and cover the session spike with
automated tests.

**Architecture:** The Worker gains an `agent` settings block and wraps each
agent PTY in `srt` (Anthropic's sandbox runtime) using a per-session settings
file. One image built from the workspace runs the Worker as a non-root user
under a narrow seccomp profile; `pnpm dev` starts that container beside a native
API and Board. Tests come in a fast group (stand-in agent, sandbox off, part of
`pnpm check`) and a Docker group (`pnpm test:docker`).

**Tech Stack:** TypeScript, Node 22, pnpm workspace, vitest, node-pty, zod,
Docker Engine, bubblewrap, `@anthropic-ai/sandbox-runtime`.

**Spec:**
`docs/superpowers/specs/2026-11-23-worker-container-and-agent-sandbox-design.md`.
Read it first; this plan argues from it.

## Global Constraints

- Run every command in WSL from the repository root. Git, pnpm and Docker all
  run there.
- Existing tests are protected. Do not edit, move, skip or reformat: anything
  under `apps/*/tests/`, `packages/contracts/tests/`, `tests/e2e/`,
  `tests/integration/reconnect.test.ts`, `scripts/e2e-server.mjs`,
  `playwright.config.*` or any vitest configuration. If a change there seems
  necessary, stop and ask the user, naming the file, the change and the reason.
  New test files and new fixture files are fine.
- No change to `packages/contracts/src` or to Worker protocol messages. If one
  seems needed, stop and raise it.
- `WorkerConfig` literals in protected tests have exactly the fields `apiUrl`,
  `token`, `id`, `name`, `root`, `stateDir`. They must keep type-checking and
  running, so every new config field is optional on input.
- Tests in Tasks 1, 3, 5, 6 and 7 pin behavior that already exists. They are
  expected to pass when first run. A failing one has found a defect: fix the
  production code, never the expectation, unless the expectation contradicts
  the spec.
- Use read-only checks: `pnpm lint`, `pnpm format:check`. Format only files you
  created, with `pnpm exec prettier --write <file>`. Run `pnpm format --list`
  before any broader format.
- After touching `packages/contracts`, run
  `pnpm --filter @atlas/contracts build` before `pnpm check`.
- Commit after each task with a Conventional Commit; scopes are `board`, `api`,
  `worker`, `contracts`, `repo`. End messages with
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Never amend.
- Container user: name `atlas`, UID 1001, home `/home/atlas`. Login volume:
  `atlas-agent-home`. Image tag: `atlas-worker:dev`.
- Seccomp profile: Docker's default plus one unconditional allow rule for
  exactly `clone`, `clone3`, `unshare`, `mount`, `umount2`, `pivot_root`.
- Do not implement anything from the spec's "Deferred: isolating agent logins".

## Review Focus

1. A task title or description containing quotes, `$(...)`, backticks or `;`
   reaches the agent as one literal argument and runs nothing. Pinned in Task 4
   (argument array) and Task 10 (through the real sandbox).
2. A workspace or project path containing a space works for worktrees, sandbox
   settings and `docker run` mounts. Pinned in Task 4 and Task 10.
3. Docker is missing or its service is stopped when `pnpm dev` starts: the
   command exits with one clear message and leaves no API or Board running.
   Pinned in Task 9.
4. A task whose worktree was made under the older 8-character name starts under
   the sandbox, with that worktree's real Git folder writable. Pinned in Task 4.
5. A session is stopped, or the Worker stops, while the sandbox check is still
   running: no agent starts afterwards. Pinned in Task 4.

---

### Task 1: Contract tests for session messages

**Files:**

- Test: `packages/contracts/tests/sessions.test.ts` (new)

- [ ] **Step 1: Write the tests**

  Cover, using `WorkerToApiMessageSchema`, `ApiToWorkerMessageSchema`,
  `BoardToApiSessionMessageSchema`, `ApiToBoardSessionMessageSchema`:
  - `worker.register` accepts `['repository.init']` and
    `['repository.init','agent.session']`; rejects `['agent.session']`,
    `['agent.session','repository.init']` and `[]`.
  - Each of `session.start`, `session.input`, `session.resize`, `session.stop`,
    `session.started`, `session.output`, `session.exit` parses with a valid
    payload and is rejected without `runId`, without `sessionId`, and with an
    unknown extra key.
  - `session.input` data of `MAX_SESSION_INPUT_CHARS` parses and one more
    character is rejected; the same for `session.output` with
    `MAX_SESSION_OUTPUT_CHARS` and `session.start` prompt with
    `MAX_SESSION_PROMPT_CHARS`.
  - Board messages: `start` and `resize` need `cols` and `rows`; `input` needs
    `data`; an unknown `type` is rejected. `session` state accepts exactly
    `none`, `starting`, `running`, `exited`.
  - `taskSessionPath(<a UUID>)` equals `/api/v1/tasks/<that UUID>/session`.
    Pin the current output only; contract source is not to change in this
    plan.

- [ ] **Step 2: Run** `pnpm --filter @atlas/contracts test`. Expected: PASS.
- [ ] **Step 3: Commit** `test(contracts): cover session messages`.

---

### Task 2: Agent settings in the Worker configuration

**Files:**

- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/main.ts`, `apps/worker/src/connection.ts`,
  `apps/worker/src/sessions/manager.ts` (constructor only)
- Test: `apps/worker/tests/agent-config.test.ts` (new)

**Interfaces:**

- Produces, from `apps/worker/src/config.ts`:

  ```ts
  export interface AgentSettings {
    command: string[]; // default ['claude']
    sandbox: 'required' | 'off'; // default 'required'
    allowedDomains: string[]; // default []
    gitName?: string;
    gitEmail?: string;
  }
  export type WorkerConfigInput = z.input<typeof configSchema>; // agent optional
  export type WorkerConfig = z.infer<typeof configSchema>; // agent present
  export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfigInput;
  export function prepareConfig(input: WorkerConfigInput): WorkerConfig;
  ```

- `startWorker(input: WorkerConfigInput)` in `main.ts`.
- `new SessionManager(config: WorkerConfig, emit, options?: { stopGraceMs?: number })`.
  It no longer reads `process.env.ATLAS_AGENT_COMMAND`.

- [ ] **Step 1: Write the failing tests**
  - `loadConfig` with only a token: `prepareConfig` result has
    `agent` equal to
    `{ command: ['claude'], sandbox: 'required', allowedDomains: [] }`.
  - `ATLAS_AGENT_COMMAND='node  /x/agent.mjs --flag'` gives
    `['node', '/x/agent.mjs', '--flag']`.
  - `ATLAS_AGENT_SANDBOX='off'` gives `'off'`; `'OFF'`, `'false'` and `''` make
    `prepareConfig` throw (an unknown value must not silently mean anything).
  - `ATLAS_AGENT_ALLOWED_DOMAINS='registry.npmjs.org, *.example.com'` gives
    `['registry.npmjs.org', '*.example.com']`; an entry containing `/`, a space
    or a scheme throws.
  - `ATLAS_AGENT_GIT_NAME` and `ATLAS_AGENT_GIT_EMAIL` map to `gitName` and
    `gitEmail`; unset leaves them undefined.
  - A config literal with only the six original fields is accepted by
    `prepareConfig` and yields the defaults.

- [ ] **Step 2: Run** `pnpm --filter @atlas/worker test agent-config`.
      Expected: FAIL (no `agent` on the config).
- [ ] **Step 3: Implement.** Add the `agent` object to `configSchema` with zod
      defaults; parse the environment in `loadConfig`. Thread `config` into
      `SessionManager`; add `stopGraceMs` (default `5_000`) replacing the
      constant.
- [ ] **Step 4: Run** `pnpm --filter @atlas/worker test` and `pnpm typecheck`.
      Expected: PASS, including the untouched `config.test.ts`.
- [ ] **Step 5: Commit** `feat(worker): add agent settings to configuration`.

---

### Task 3: Worktree and session tests with a stand-in agent

**Files:**

- Create: `apps/worker/src/sessions/worktree.ts` (move `ensureWorktree`,
  `childEnvironment`, `requireRealDirectory` out of `manager.ts`, unchanged in
  behavior)
- Modify: `apps/worker/src/sessions/manager.ts` (import from `worktree.ts`)
- Create: `apps/worker/tests/fixtures/agent.mjs`
- Create: `apps/worker/tests/support/sessions.ts`
- Test: `apps/worker/tests/worktrees.test.ts`,
  `apps/worker/tests/sessions.test.ts` (new)

**Interfaces:**

- Produces, from `worktree.ts`:

  ```ts
  export interface Worktree {
    path: string;
    branch: string;
    gitDir: string; // absolute `git rev-parse --absolute-git-dir` of the worktree
    commonDir: string; // absolute Git common dir of the main checkout
  }
  export function ensureWorktree(
    root: string,
    repository: string,
    payload: SessionStartPayload,
  ): Promise<Worktree>;
  export function childEnvironment(root: string): Record<string, string>;
  ```

- `agent.mjs` behavior (plain Node, no dependencies): prints `READY <cwd>` and
  a line `ARGS <JSON of process.argv.slice(2)>`; then for each input line:
  `env` prints `ENV <JSON of names starting ATLAS_ or GIT_>`; `exit <n>` exits
  with that code; anything else is echoed as `ECHO <line>`. With `--ignore-hup`
  it ignores `SIGHUP` and `SIGTERM`. With `--slow-start <ms>` it waits before
  `READY`.
- `support/sessions.ts`:
  `createHarness(options?: { agentArgs?: string[]; stopGraceMs?: number }): Promise<{ root; stateDir; manager; events: SessionEvent[]; waitFor(type, sessionId): Promise<SessionEvent>; output(sessionId): string; initRepository(relativePath): Promise<string>; cleanup(): Promise<void> }>`.
  It builds a config with `sandbox: 'off'` and
  `command: [process.execPath, <agent.mjs>, ...agentArgs]`.

- [ ] **Step 1: Move the worktree code** into `worktree.ts` and add `gitDir`
      and `commonDir` to its result. Run `pnpm --filter @atlas/worker test`.
      Expected: PASS.

- [ ] **Step 2: Write `worktrees.test.ts`** (real Git in a temp directory):
  - New task `1b2c-…` (use a UUID): path ends
    `.atlas-worktrees/<encodeURIComponent(relativePath)>/<task id>`, branch is
    `atlas/task-<task id>`, `gitDir` is inside `<repo>/.git/worktrees/`.
  - A second call for the same task returns the same path without error.
  - Legacy reuse: pre-create a worktree at
    `.atlas-worktrees/<relativePath with / as __>/<first 8 id chars without dashes>`
    on branch `atlas/task-<those 8 chars>`; `ensureWorktree` returns that path
    and branch, and its `gitDir` is that worktree's own.
  - Empty repository: after the call `git log --oneline` in the repository has
    one commit `chore: initial commit`; a file staged beforehand is still
    staged and not committed; a `pre-commit` hook that writes a marker file did
    not run.
  - Nested `relativePath` `a/b` and a project named `a__b` get different
    worktree folders.
  - A project folder that is a symlink is rejected with
    `The project folder must be a real directory, not a link`; a
    `.atlas-worktrees` that is a symlink is rejected with
    `The worktree folder must be a real directory, not a link`.
  - A project folder that is a subfolder of another repository is rejected with
    `The project folder is not its own Git repository`.
  - A worktree folder deleted by hand: the next call recreates it on the same
    branch.
  - A `relativePath` containing a space works.

- [ ] **Step 3: Write `sessions.test.ts`** with the harness:
  - Start emits `session.started` with the worktree path and branch, then
    output containing `READY <worktree path>`.
  - `ARGS` for the stand-in (kind custom) does not contain the prompt.
  - `input(..., 'hello\n')` produces `ECHO hello`.
  - `input(..., 'env\n')` shows no name starting `ATLAS_` and shows
    `GIT_CEILING_DIRECTORIES`.
  - Two tasks started in the same tick in a new empty repository both reach
    `session.started`; the repository has exactly one initial commit.
  - `stop` right after `start` (before `session.started`) yields `session.exit`
    with message `The session was stopped before it started` and no `READY`.
  - `stopAll()` during a `--slow-start` preparation: no `session.started` is
    emitted afterwards.
  - With `--ignore-hup` and `stopGraceMs: 200`, `stop` leads to `session.exit`
    within 3 seconds.
  - `start` for a running session with a new `runId` re-emits
    `session.started` carrying the new `runId`; later output carries it too.
  - `input` and `stop` for an unknown session emit `session.exit` with message
    `The session is no longer running` and the given `runId`.
  - `exit 3` yields `session.exit` with `exitCode: 3`, `message: null`.
  - Output larger than `MAX_SESSION_OUTPUT_CHARS` arrives in chunks no longer
    than that limit.

- [ ] **Step 4: Run** `pnpm --filter @atlas/worker test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(worker): cover worktrees and sessions`.

---

### Task 4: Wrap agents in the sandbox

**Files:**

- Create: `apps/worker/src/sessions/agents.ts`,
  `apps/worker/src/sessions/sandbox.ts`
- Modify: `apps/worker/src/sessions/manager.ts`
- Test: `apps/worker/tests/sandbox.test.ts` (new); extend
  `apps/worker/tests/sessions.test.ts` (created in Task 3, so not protected)

**Interfaces:**

- Consumes: `AgentSettings`, `WorkerConfig` (Task 2); `Worktree`,
  `childEnvironment` (Task 3).
- Produces, from `agents.ts`:

  ```ts
  export type AgentKind = 'claude' | 'codex' | 'custom';
  export interface AgentProfile {
    kind: AgentKind;
    takesPrompt: boolean;
    sandboxArgs: string[]; // added only when the Atlas sandbox is on
    domains: string[];
    writablePaths(home: string): string[];
  }
  export function agentProfile(command: string[]): AgentProfile; // by basename of command[0]
  export function agentArgs(
    profile: AgentProfile,
    command: string[],
    prompt: string,
    sandboxed: boolean,
  ): string[];
  ```

  Values: claude — `takesPrompt: true`,
  `sandboxArgs: ['--dangerously-skip-permissions']`, domains
  `['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', '*.claude.com']`,
  writable `[home/.claude, home/.claude.json, '/tmp/claude']`. codex —
  `takesPrompt: true`,
  `sandboxArgs: ['--dangerously-bypass-approvals-and-sandbox']`, domains
  `['api.openai.com', 'auth.openai.com', 'chatgpt.com', '*.chatgpt.com']`,
  writable `[home/.codex]` (unverified; see Task 11). custom —
  `takesPrompt: false`, no args, no domains, no paths. `agentArgs` keeps the
  existing rule: a prompt starting with `-` gets one leading space.

- Produces, from `sandbox.ts`:

  ```ts
  export interface SandboxSettings {
    network: { allowedDomains: string[]; deniedDomains: string[] };
    filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  }
  export function sandboxSettings(input: {
    worktree: Worktree;
    stateDir: string;
    home: string;
    profile: AgentProfile;
    allowedDomains: string[];
  }): SandboxSettings;
  export function agentEnvironment(
    root: string,
    agent: AgentSettings,
    excludesFile: string,
  ): Record<string, string>;
  export const PLACEHOLDER_NAMES: readonly string[];
  export function writeExcludesFile(): Promise<string>; // path under os.tmpdir()
  export function prepareSandbox(input: {
    sessionKey: string;
    settings: SandboxSettings;
    stateDir: string;
    cwd: string;
    env: Record<string, string>;
  }): Promise<{ settingsPath: string }>; // throws SandboxUnavailableError
  export class SandboxUnavailableError extends Error {}
  export const SANDBOX_ON_NOTICE: string;
  export const SANDBOX_OFF_NOTICE: string;
  ```

  Exact values:
  - `allowWrite`: `worktree.path`, `<commonDir>/objects`, `worktree.gitDir`,
    `<commonDir>/refs/heads/atlas`, `<commonDir>/logs`, then
    `profile.writablePaths(home)`. Nothing else.
  - `denyRead`: `[stateDir]`. `denyWrite`: `[]`. `deniedDomains`: `[]`.
  - `allowedDomains`: profile domains followed by the configured extras, without
    duplicates.
  - Settings file: `<stateDir>/sessions/<sessionKey>.json`, mode `0o600`,
    rewritten on every start. `sessionKey` is the sanitized task id already
    used for the worktree folder.
  - `PLACEHOLDER_NAMES`: `.bash_profile`, `.bashrc`, `.gitconfig`,
    `.gitmodules`, `.idea`, `.mcp.json`, `.profile`, `.ripgreprc`, `.vscode`,
    `.zprofile`, `.zshrc`. The excludes file lists each as `/<name>`.
  - `agentEnvironment` = `childEnvironment(root)` plus `GIT_CONFIG_COUNT=1`,
    `GIT_CONFIG_KEY_0=core.excludesFile`, `GIT_CONFIG_VALUE_0=<excludesFile>`,
    and, when both are set, `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`,
    `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL`.
  - `prepareSandbox` writes the settings file, then proves the sandbox works by
    running `srt --settings <file> sh -c '! test -r "$1"' sh <stateDir>` with a
    15 second timeout. A non-zero exit, a timeout or a missing `srt` throws
    `SandboxUnavailableError` whose message is
    `The agent sandbox could not start, so the agent was not started: <first line of stderr, or the error message>`.
  - PTY command when sandboxed: file `srt`, arguments
    `['--settings', settingsPath, command[0], ...agentArgs(...)]`.
  - `SANDBOX_ON_NOTICE`:
    `Atlas: agent sandbox on. Writes are limited to this task's worktree.\r\n`
    `SANDBOX_OFF_NOTICE`:
    `Atlas: agent sandbox OFF. The agent can change anything the Worker can.\r\n`
    The notice is emitted as `session.output` right after `session.started`,
    before any agent output.

- [ ] **Step 1: Write the failing tests in `sandbox.test.ts`**
  - `agentProfile(['/usr/bin/claude'])` is the claude profile;
    `['node', 'x.mjs']` is custom.
  - `agentArgs` for claude, prompt `--resume`, sandboxed: the last argument is
    `' --resume'` and `--dangerously-skip-permissions` is present; not
    sandboxed: the flag is absent.
  - `agentArgs` passes the prompt ``a "b" $(touch /x) `id`; rm -rf /`` through
    as one unmodified array element.
  - `sandboxSettings` for a worktree whose paths contain a space returns
    exactly the six-plus-profile `allowWrite` entries listed above, unescaped.
  - Build a legacy 8-character worktree with real Git (reuse Task 3 helpers):
    `allowWrite` contains that worktree's real `gitDir`, which is not named
    after the full task id.
  - `agentEnvironment` contains no `ATLAS_` name; with `gitName` and `gitEmail`
    set it has the four identity variables; with only one set it has none.
  - `writeExcludesFile()` content is the eleven `/name` lines.
  - `prepareSandbox` with `PATH` pointing at a temp directory holding a fake
    `srt` script: exit 0 resolves and the settings file exists with mode
    `0o600`; exit 1 printing `bwrap: nope` rejects with a message ending
    `not started: bwrap: nope`; no `srt` on `PATH` rejects with
    `SandboxUnavailableError`.

- [ ] **Step 2: Add session tests** (fake `srt` on `PATH` that execs its
      command after `--settings <file>`, and a variant that fails):
  - `sandbox: 'required'`, working fake: the agent's `ARGS`/`READY` appear, the
    first output is `SANDBOX_ON_NOTICE`, and the PTY was spawned through `srt`
    (the fake records its arguments to a file).
  - `sandbox: 'required'`, failing fake: `session.exit` with the
    "could not start" message; no `session.started`; no `READY`.
  - `sandbox: 'off'`: first output is `SANDBOX_OFF_NOTICE`; `srt` not invoked.
  - Fake `srt` that sleeps 1 second on the check: `stop` during the check gives
    `The session was stopped before it started` and no agent output; the same
    for `stopAll()`.

- [ ] **Step 3: Run** the two files. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `agents.ts`, `sandbox.ts`, and the wiring in
      `SessionManager.launch`: build profile, environment and arguments; when
      `sandbox === 'required'` call `prepareSandbox`, re-check `abandoned()`,
      then spawn through `srt`. Write the excludes file once per manager.
- [ ] **Step 5: Run** `pnpm --filter @atlas/worker test` and `pnpm typecheck`.
      Expected: PASS.
- [ ] **Step 6: Commit** `feat(worker): run agents inside the sandbox runtime`.

---

### Task 5: API session hub and socket tests

**Files:**

- Create: `apps/api/tests/support/session-harness.ts`
- Test: `apps/api/tests/sessions.test.ts` (new)

**Interfaces:**

- `session-harness.ts`:
  `createApi(): Promise<{ app; registerWorker(id, capabilities): Promise<WorkerSocket>; board(taskId, origin?): Promise<BoardSocket>; localTask(workerId): Promise<{ taskId; projectId }>; existingRepoTask(): Promise<{ taskId }>; close() }>`.
  `WorkerSocket` exposes `received(type)` (awaits the next message of that
  type) and `send(type, payload)`. `BoardSocket` exposes `messages`,
  `next(type)` and `send(message)`. Build it on `app.injectWS`, as
  `apps/api/tests/gateway.test.ts` does; do not import from that file.
  `localTask` creates a local project, completes its `repository.init` command
  from the fake Worker so the project is `ready`, and creates a task.

- [ ] **Step 1: Write the tests**
  - On connect the Board receives `{type:'session', state:'none', …nulls}`.
  - `start` for a ready local project sends the Worker `session.start` with the
    task id as `sessionId`, a `runId`, the project's `relativePath`, the given
    `cols`/`rows`, and prompt `Task: <title>\n\n<description>` trimmed; the
    Board gets state `starting`.
  - A title of 200 characters plus a 100,000 character description gives a
    prompt of exactly `MAX_SESSION_PROMPT_CHARS`.
  - Errors reach the Board as `{type:'error', message}` with: unknown task
    `Task was not found`; existing-repository project
    `This project has no checkout on a worker, so a session cannot start here`;
    Worker registered with `['repository.init']` only
    `The project worker is too old to run agent sessions`; Worker offline
    `The project worker is offline`.
  - `session.started` from the Worker moves the Board to `running` with branch
    and worktree path; `session.output` is relayed; `session.exit` moves it to
    `exited` with the exit code.
  - Messages with a wrong `runId`, or from a different Worker id, change
    nothing.
  - After exit, `start` again creates a new `runId`; a late `session.exit` with
    the old `runId` does not end the new run.
  - A second Board socket attaching mid-run gets the current `session` message
    followed by one `output` message holding everything sent so far.
  - Replay keeps at most 400,000 characters: send 50 chunks of 16,000
    characters, attach, and the replay length is ≤ 400,000 and ends with the
    last chunk.
  - `input`, `resize` and `stop` from the Board reach the Worker with the
    current `runId`; they are ignored when there is no live session.
  - The socket is refused when `Origin` is missing or is
    `http://evil.example`.
  - A non-JSON frame and an unknown message type each produce an `error`
    message and leave the socket open.

- [ ] **Step 2: Run** `pnpm --filter @atlas/api test`. Expected: PASS.
- [ ] **Step 3: Commit** `test(api): cover the session hub and Board socket`.

---

### Task 6: Board session tests

**Files:**

- Create: `apps/board/tests/support/session-doubles.ts`
- Test: `apps/board/tests/task-session.test.tsx`,
  `apps/board/tests/session-terminal.test.tsx` (new)

**Interfaces:**

- `session-doubles.ts`: `installFakeWebSocket()` returning
  `{ last(): FakeSocket }` where `FakeSocket` has `url`, `sent: unknown[]`,
  `open()`, `receive(message)`, `closeFromServer()`; and `fakeTerminal`, the
  object used by `vi.mock('@xterm/xterm')` and `vi.mock('@xterm/addon-fit')`,
  recording `write`, `reset` calls and exposing `type(data)` to fire `onData`.
  Also stub `ResizeObserver`.

- [ ] **Step 1: Write the tests** (`// @vitest-environment jsdom`)
  - `TaskSession`: shows `Open terminal`; clicking loads the terminal and the
    button reads `Hide terminal`; clicking again removes the terminal and
    closes the socket.
  - The socket URL ends with `taskSessionPath(taskId)`.
  - Before the socket opens the status reads `Not connected to the API`.
  - For each state message the status text is `No session yet`, `Starting…`,
    `Running`, `Ended`; `exited` with `exitCode: 2` shows `(exit code 2)`; a
    branch is appended after `·`.
  - `none` and `exited` show a start button (`Start session` / `Start again`)
    that sends `{type:'start', cols, rows}`; `starting` and `running` show
    `Stop`, which sends `{type:'stop'}`.
  - Typing sends `input` only while `running`; 20,000 typed characters are
    split into messages of at most `MAX_SESSION_INPUT_CHARS`.
  - `output` messages are written to the terminal; a `starting` message resets
    it.
  - An `error` message is shown; the next `session` message clears it.
  - When not running, or after `closeFromServer()`, the screen has the `idle`
    class and the overlay is present.
  - Inside a `Dialog`, pressing Escape with focus in `.session-screen` does not
    call `onClose`; pressing it elsewhere does.

- [ ] **Step 2: Run** `pnpm --filter @atlas/board test`. Expected: PASS.
- [ ] **Step 3: Commit** `test(board): cover the agent session panel`.

---

### Task 7: Integration test through the Board socket

**Files:**

- Test: `tests/integration/sessions.test.ts` (new)

**Interfaces:**

- Consumes: `buildApp`, `startWorker` with
  `agent: { command: [process.execPath, <apps/worker/tests/fixtures/agent.mjs>], sandbox: 'off', allowedDomains: [] }`.

- [ ] **Step 1: Write the test.** Start API and Worker as
      `tests/integration/reconnect.test.ts` does (read it; do not edit it).
      Create a local project and a task over HTTP, open a `ws` client to the
      session path with header `Origin: http://localhost:5173`, then assert in
      order: `starting` → `running` with branch `atlas/task-<task id>` → output
      containing `READY` → after sending `input` `ping\n`, output containing
      `ECHO ping` → a second socket receives a replay containing `READY` →
      close the API, rebuild it on the same port, reconnect, send `start`, and
      the state returns to `running` without a second `READY` → `stop` →
      `exited`.
- [ ] **Step 2: Run** `pnpm test:integration`. Expected: PASS (both files).
- [ ] **Step 3: Commit** `test(repo): cover agent sessions end to end`.

---

### Task 8: Worker image and seccomp profile

**Files:**

- Create: `docker/worker/Dockerfile`, `.dockerignore`
- Create: `docker/worker/seccomp-default.json`, `docker/worker/seccomp.json`,
  `docker/worker/README.md`
- Create: `scripts/seccomp.mjs`
- Test: `apps/worker/tests/seccomp.test.ts` (new)

**Interfaces:**

- Produces: `scripts/seccomp.mjs` exporting
  `narrowProfile(defaultProfile: object): object` and runnable as
  `node scripts/seccomp.mjs --write` / `--check` (exit 1 when
  `seccomp.json` differs from the derived profile).
- Image contract used by Task 9 and 10: tag `atlas-worker:dev`; user `atlas`
  (UID 1001, home `/home/atlas`); entrypoint runs the built Worker
  (`node dist/main.js` in the deployed package); `claude`, `codex`, `srt`,
  `git`, `bwrap`, `socat`, `rg` on `PATH`; system Git config has
  `safe.directory = *` (the mounted workspace is owned by another UID).

- [ ] **Step 1: Write the failing test.** `seccomp.json` deep-equals
      `narrowProfile(seccomp-default.json)`; the difference is exactly one
      appended rule
      `{ names: ['clone','clone3','unshare','mount','umount2','pivot_root'], action: 'SCMP_ACT_ALLOW' }`.
- [ ] **Step 2: Add the profiles.** Save Docker's default from
      `https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json`
      as `seccomp-default.json`; record the commit hash and date fetched in
      `docker/worker/README.md`. Write `scripts/seccomp.mjs` and generate
      `seccomp.json`. Run the test. Expected: PASS.
- [ ] **Step 3: Write the Dockerfile.** Multi-stage on
      `node:22-bookworm-slim`: a build stage that installs with the lockfile,
      builds `@atlas/contracts` and `@atlas/worker`, and produces a
      production deployment of the Worker (for example `pnpm deploy`); a final
      stage with the packages and user above. Pin `@anthropic-ai/claude-code`
      to `2.1.330`, `@openai/codex` to `0.169.0`, and
      `@anthropic-ai/sandbox-runtime` to the current version from `npm view`;
      record the three in `docker/worker/README.md`. `.dockerignore` excludes
      `node_modules`, `.atlas`, `.git`, `dist`, test output and `.env*`.
- [ ] **Step 4: Verify the image.**

  ```bash
  docker build -f docker/worker/Dockerfile -t atlas-worker:dev .
  docker run --rm --entrypoint sh atlas-worker:dev -c \
    'id -u; command -v claude codex srt git bwrap socat rg; node -e "require(\"node-pty\")"'
  ```

  Expected: `1001`, seven paths, no error. Then, with the profile:

  ```bash
  docker run --rm --security-opt seccomp=$PWD/docker/worker/seccomp.json \
    --entrypoint sh atlas-worker:dev -c 'bwrap --ro-bind / / --dev /dev --proc /proc true && echo sandbox-ok'
  ```

  Expected: `sandbox-ok`. Without `--security-opt` the same command fails.

- [ ] **Step 5: Run** `pnpm lint && pnpm format:check`. If the JSON files fail
      the format check, format those two new files with prettier; the test
      compares parsed content, so formatting is safe.
- [ ] **Step 6: Commit** `feat(repo): add the Worker image and seccomp profile`.

---

### Task 9: Container launcher and root commands

**Files:**

- Create: `scripts/worker-container.mjs`, `scripts/worker-login.mjs`
- Modify: `scripts/dev.mjs`, `package.json`
- Test: `tests/integration/worker-container.test.ts` (new; pure functions and
  injected runners, no Docker needed)

**Interfaces:**

- Produces, from `scripts/worker-container.mjs`:

  ```js
  export const IMAGE = 'atlas-worker:dev';
  export const HOME_VOLUME = 'atlas-agent-home';
  export function runArgs({ name, env, repoRoot }): string[]; // arguments after `docker`
  export async function ensureDocker({ run, isRoot, hasSystemd, log }): Promise<void>;
  export async function buildImage({ run, repoRoot }): Promise<void>;
  export async function hostGitIdentity({ run }): Promise<{ name?: string; email?: string }>;
  ```

  `runArgs` returns, in this order: `run`, `--rm`, `--init`, `--name <name>`,
  `--network host`, `--security-opt seccomp=<repoRoot>/docker/worker/seccomp.json`,
  `-v <ATLAS_WORKSPACE_ROOT>:<same>`, `-v <ATLAS_WORKER_STATE_DIR>:<same>`,
  `-v atlas-agent-home:/home/atlas`, then `-e NAME` (name only, so values do not
  appear in the process list) for each of `ATLAS_API_WS_URL`,
  `ATLAS_WORKER_TOKEN`, `ATLAS_WORKER_ID`, `ATLAS_WORKER_NAME`,
  `ATLAS_WORKSPACE_ROOT`, `ATLAS_WORKER_STATE_DIR` and any of
  `ATLAS_AGENT_COMMAND`, `ATLAS_AGENT_SANDBOX`, `ATLAS_AGENT_ALLOWED_DOMAINS`,
  `ATLAS_AGENT_GIT_NAME`, `ATLAS_AGENT_GIT_EMAIL` present in `env`, then
  `atlas-worker:dev`. No `--privileged`, no `--cap-add`, no Docker socket
  mount, no other `-v`.

  `ensureDocker`: if `docker` is not installed, throw
  `Docker is not installed. See docs/development/local-setup.md.` If
  `docker info` fails: when `isRoot && !hasSystemd`, start `dockerd` detached
  with output to `/var/log/dockerd.log` and wait up to 20 seconds for
  `docker info`; otherwise throw
  `The Docker service is not running. Start it and run the command again.`

- The test imports this `.mjs` module from TypeScript. If the root type check
  rejects that, add a sibling `scripts/worker-container.d.mts` with the
  signatures above; do not loosen any TypeScript or vitest configuration.
- Root scripts in `package.json`: `dev` (changed), `dev:web`
  (`node scripts/dev.mjs --web`), `worker:login`
  (`node scripts/worker-login.mjs`), `test:docker` (added in Task 10).

- [ ] **Step 1: Write the failing tests**
  - `runArgs` with a workspace path containing a space returns that path as a
    single `-v` value `'<path>:<path>'`; the full array equals the expected
    list above; it never contains `--privileged`, `--cap-add` or `docker.sock`.
  - `runArgs` omits `-e` for optional variables that are unset and never
    contains a token value.
  - `ensureDocker` with a runner where `docker --version` fails rejects with
    the "not installed" message; with `docker info` failing and
    `isRoot: false` rejects with the "not running" message; with `isRoot: true,
hasSystemd: false` it starts `dockerd` once and resolves when `docker info`
    then succeeds.
  - `hostGitIdentity` returns `{}` when `git config` exits non-zero.

- [ ] **Step 2: Run** `pnpm test:integration`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and `worker-login.mjs`, which runs
      `ensureDocker`, `buildImage`, then
      `docker run -it --rm -v atlas-agent-home:/home/atlas --entrypoint <cli> atlas-worker:dev`
      with `<cli>` from the first argument (`claude` by default, `codex`
      allowed, anything else rejected).
- [ ] **Step 4: Change `scripts/dev.mjs`.** Before starting anything, unless
      `--web` was given: `ensureDocker`, `buildImage`, fill
      `ATLAS_AGENT_GIT_NAME`/`ATLAS_AGENT_GIT_EMAIL` from `hostGitIdentity`
      when unset. A failure prints the message and exits 1 before the API or
      Board start. Then start `api` and `board` as today and, unless `--web`,
      `docker` with `runArgs` in place of the native Worker. On stop, also run
      `docker rm -f <name>`. With `--web` the closing line reads
      `Press Ctrl+C to stop the API and Board. No Worker is running.`
- [ ] **Step 5: Verify by hand.** `pnpm dev`: the Board shows the Worker
      online; `docker ps` shows one `atlas-worker` container; Ctrl+C removes
      it. `pnpm dev:web`: Worker shown offline, no container. Then run
      `pnpm dev` with a `PATH` that has no `docker` and confirm the "not
      installed" message, exit code 1, and that port 4310 is not listening
      afterwards.
- [ ] **Step 6: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(repo): run the dev Worker in its container`.

---

### Task 10: Docker test group

**Files:**

- Create: `tests/docker/support/stack.ts`, `tests/docker/fixtures/probe.mjs`
- Test: `tests/docker/worker-container.test.ts`,
  `tests/docker/sandbox.test.ts` (new)
- Modify: `package.json` (`"test:docker": "vitest run tests/docker"`)

**Interfaces:**

- Consumes: `runArgs`, `ensureDocker`, `buildImage` (Task 9); `buildApp`.
- `stack.ts`:
  `startStack(options?: { seccomp?: 'narrow' | 'default'; agent?: string[]; extraDomains?: string[] }): Promise<{ api; boardSocket(taskId); createLocalTask(relativePath, title, description?): Promise<{ taskId }>; workspace: string; stop() }>`.
  It makes a temp directory, `chmod`s it so UID 1001 can write, starts
  `buildApp` on `127.0.0.1` port 0, and runs the container with `runArgs`
  (replacing the seccomp option when `'default'`), additionally mounting
  `tests/docker/fixtures` read-only at its own path.
- `probe.mjs` (custom agent; runs once and exits): from its working directory
  performs each action and prints one line per result, `PROBE <name> ok` or
  `PROBE <name> blocked`: `write-worktree`, `commit` (write a file,
  `git add -A`, `git commit -m probe`), `write-main-checkout`,
  `write-other-worktree`, `write-main-hooks`, `write-main-config`,
  `write-outside` (`/tmp/atlas-probe`), `read-state-dir`
  (path from argument 1), `network` (`fetch('https://example.com')`), and
  prints `PROBE argv <JSON of arguments after the first>`.

- [ ] **Step 1: Write `worker-container.test.ts`**
  - The container Worker registers: `/api/v1/workers` shows it online with
    capability `agent.session`.
  - A local project in a folder named `my project` is created; a session with
    the stand-in `agent.mjs` reaches `running`, the first output is
    `SANDBOX_ON_NOTICE`, `ECHO` works, `stop` gives `exited`.
  - Stop, then start the same task again: `running` again in the same
    worktree.

- [ ] **Step 2: Write `sandbox.test.ts`** with `probe.mjs` as the agent, a
      second task started first so another worktree exists:
  - `write-worktree ok`, `commit ok`.
  - `blocked` for `write-main-checkout`, `write-other-worktree`,
    `write-main-hooks`, `write-main-config`, `write-outside`, `read-state-dir`,
    `network`.
  - The branch `atlas/task-<id>` has the probe's commit, authored with the
    `ATLAS_AGENT_GIT_NAME`/`EMAIL` the stack passed.
  - With `seccomp: 'default'`: the session ends `exited` with a message
    starting `The agent sandbox could not start, so the agent was not started`
    and no `PROBE` line appears.
  - Shell text is inert. The stand-in must receive the prompt, which only the
    `claude` and `codex` profiles pass. Add an executable fixture named
    `tests/docker/fixtures/claude` (a Node script with a shebang that runs the
    same probe; commit it with mode 755) and use its path as the agent command,
    so the Worker treats it as Claude. Create the task with title
    `a "b" $(touch /tmp/pwned) ; id`. Expect `PROBE argv` to end with the
    single element `Task: a "b" $(touch /tmp/pwned) ; id`, to include
    `--dangerously-skip-permissions`, and `/tmp/pwned` not to exist in the
    container (`docker exec <name> test ! -e /tmp/pwned`).

- [ ] **Step 3: Run** `pnpm test:docker`. Expected: PASS. Failures here are
      findings: fix production code or the image, and if the sandbox itself
      cannot do what the spec states, stop and report it.
- [ ] **Step 4: Commit** `test(repo): add the Docker test group`.

---

### Task 11: Real-agent verification and documentation

**Files:**

- Modify: `docs/development/local-setup.md`, `docs/development/protocol.md`,
  `docs/development/acceptance.md`, `AGENTS.md`

- [ ] **Step 1: Verify with the user's logged-in Claude.** The user's login is
      in the `atlas-agent-home` volume. Run `pnpm dev`, open a task on the
      Board and start a session. Record what happens for each:
  - the folder-trust question and the permission-bypass notice appear and can
    be answered on the Board;
  - the agent edits a file and commits it in the worktree using `git add -A`;
  - asked to write `/tmp/outside.txt`, it reports failure and the file does not
    exist in the container;
  - Stop ends the session.
    If the interactive UI does not work with `--dangerously-skip-permissions`,
    stop and report it to the user with the terminal output; do not silently
    drop the flag.
- [ ] **Step 2: Codex.** If a Codex login exists in the volume, repeat the
      first three checks with `ATLAS_AGENT_COMMAND=codex` and correct the codex
      profile values. If there is no login, do not ask the user to create one:
      document Codex as unverified under the sandbox.
- [ ] **Step 3: Update the documents.**
  - `local-setup.md`: installing Docker in WSL and starting its service without
    systemd; `pnpm worker:login`; `pnpm dev`, `pnpm dev:web`,
    `pnpm test:docker`; the settings `ATLAS_AGENT_SANDBOX`,
    `ATLAS_AGENT_ALLOWED_DOMAINS`, `ATLAS_AGENT_GIT_NAME`,
    `ATLAS_AGENT_GIT_EMAIL`; that a Worker code change needs the image rebuilt
    (which `pnpm dev` does); the eleven file names the agent's Git ignores at
    the worktree root.
  - `protocol.md`: in "Agent sessions (spike)" replace "has no automated tests"
    with a pointer to the test groups, and drop "(spike)" from the heading.
  - `acceptance.md`: add the coverage of this work and the manual checks from
    Step 1 with their recorded results; under review notes, state which review
    was independent and which was self-review.
  - `AGENTS.md`: update the command list; keep it short.
  - Copy the spec's "Known limits" into `local-setup.md` under a heading
    "What the sandbox does not protect".
- [ ] **Step 4: Run** `pnpm check` and `pnpm test:docker`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(repo): document the Worker container and sandbox`.
