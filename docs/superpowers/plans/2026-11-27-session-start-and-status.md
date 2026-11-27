# Session start on move, resume, trust and status: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moving a task to Working starts one agent session; a later start resumes instead of repeating the task; Claude is not asked to trust Atlas worktrees; every card shows a status dot.

**Architecture:** The Worker decides between a first run and a resume from a per-task record, pre-accepts trust, and turns Claude hook events into `session.activity` messages. The API hub starts sessions from the move route, folds session state and activity into one status, and serves it over the session socket and a list route. The Board draws dots from the list and replaces its start controls with Connect, Start and Resume.

**Tech stack:** TypeScript, Zod (contracts), Fastify and ws (API), node-pty and srt (Worker), React with TanStack Query and xterm.js (Board), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-session-start-and-status-design.md`. Read it with this plan.

## Global constraints

- Read `AGENTS.md`, the app `AGENTS.md` files and `.agents/skills/atlas-contract-changes/SKILL.md` first. Run every command in WSL from the repository root.
- Existing tests, helpers and test configuration are not changed without the user's permission. "Test permissions" below lists what was asked. Anything else that fails: stop, list file and exact change, ask.
- Read-only lint and format checks; format only files you changed (`pnpm exec prettier --write <files>`).
- Commit after each task with `git commit -F <file>`; subjects follow `docs/development/conventions.md` (`pnpm check:commits -- main`). Never amend. Do not push.
- The task prompt, agent output and the agent's last message never reach the database, a log or the status channel.
- Never delete or mount the Docker volume `atlas-agent-home` in tests. Never answer Claude's trust question or bypass warning.
- Build contracts before consumers: `pnpm --filter @atlas/contracts build`.

## Results of the checks before building (2026-11-27)

Run with Claude Code 2.1.330 under `srt` in the Worker container, in a linked worktree:

- Without a trust record the trust dialog appears and no hook runs. With `projects["<worktree path>"].hasTrustDialogAccepted = true` written in place (same inode) the dialog does not appear. The key is the worktree path.
- Hooks passed with `--settings '<json>'` run under the sandbox. Observed order for a first run with a prompt argument: `SessionStart` (`source: "startup"`), `UserPromptSubmit`, `Stop`. The `Stop` input has `last_assistant_message`.
- A question dialog fires `PreToolUse` (matcher `AskUserQuestion`), then `PermissionRequest` (`tool_name: "AskUserQuestion"`); answering it fires `PostToolUse` (matcher `AskUserQuestion`).
- `--session-id <uuid>` works; the conversation is saved as `~/.claude/projects/<encoded cwd>/<uuid>.jsonl`. `--resume <uuid>` reopens it and fires `SessionStart` with `source: "resume"` and nothing else until the user types.
- `--resume` with an unknown ID prints "No conversation found with session ID: …" and exits with code 1.
- Not checked: `StopFailure` (no API error could be provoked). It is wired from the documentation; the docs task records it as unverified.

## Test permissions

Asked of the user before execution; do not touch these files until the answer is recorded here.

| File                                                                       | Change                                                                                                   | Why                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/board/tests/session-terminal.test.tsx`                               | Remove the "offers Start session…" test and the `none` label row that depends on the removed button text | The start button moves out of the terminal               |
| `apps/board/tests/task-session.test.tsx`                                   | Replace "Open terminal" expectations with the new Connect / Start / Resume controls                      | The control is replaced                                  |
| `apps/api/tests/sessions.test.ts`, `apps/api/tests/support/fake-worker.ts` | Add `agent.session.status` to the capability lists used by tests that start sessions                     | The API no longer starts sessions on a Worker without it |
| `apps/api/tests/route-protection.test.ts`                                  | Add the new sessions route to its route list, if the test keeps one                                      | New route                                                |
| `apps/worker/tests/clone-connection.test.ts`                               | Expect the fourth capability in the register message, if it asserts the exact list                       | New capability                                           |

Status: **not yet answered.**

## Review focus

1. Move and click together: two starts for one task in the same tick give one `session.start` (Task 5 test).
2. A status file with junk, a huge line or a symlink does not crash the Worker or set a status (Task 3 test).
3. `~/.claude.json` missing, not JSON, or an array: the agent still starts and the file is untouched (Task 2 test).
4. Worker reconnect while a session is still starting does not end it (Task 6 test).
5. A task moved out of Working with a failed-start record loses its red dot (Task 5 test).

---

### Task 1: Contracts

**Files:**

- Modify: `packages/contracts/src/sessions.ts`, `packages/contracts/src/protocol.ts`, `packages/contracts/src/workers.ts`
- Test: `packages/contracts/tests/session-status.test.ts` (new)

**Produces** (all exported through the package entry point):

```ts
// workers.ts
export const AGENT_SESSION_STATUS_CAPABILITY = 'agent.session.status';
// sessions.ts
export const SessionActivitySchema = z.enum(['working', 'needs_input', 'idle', 'error']);
export const SessionActivityDetailSchema = z.enum([
  'asked_in_text',
  'resumed',
  'rate_limit',
  'authentication_failed',
  'billing_error',
  'invalid_request',
  'server_error',
  'max_output_tokens',
  'unknown',
]);
export const SessionActivityPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  activity: SessionActivitySchema,
  detail: SessionActivityDetailSchema.nullable(),
});
// SessionExitPayloadSchema gains: stopped: z.boolean().optional()
export const SessionSyncPayloadSchema = z.strictObject({
  sessions: z
    .array(
      z.strictObject({
        sessionId: IdSchema,
        runId: IdSchema,
        state: z.enum(['starting', 'running']),
        worktreePath: z.string().nullable(),
        branch: z.string().nullable(),
        activity: SessionActivitySchema.nullable(),
        detail: SessionActivityDetailSchema.nullable(),
      }),
    )
    .max(500),
  exits: z.array(SessionExitPayloadSchema).max(500),
});
export const SessionStatusSchema = z.enum([
  'none',
  'working',
  'needs_input',
  'finished',
  'problem',
  'ended',
]);
export const SessionReasonSchema = z.enum([
  'none',
  'no_checkout',
  'starting',
  'working',
  'dialog',
  'asked_in_text',
  'finished',
  'resumed',
  'not_started',
  'start_failed',
  'exit_error',
  'api_error',
  'worker_offline',
  'worker_lost',
  'exited',
  'stopped',
]);
export const SessionSummarySchema = z.strictObject({
  status: SessionStatusSchema,
  reason: SessionReasonSchema,
  message: z.string().nullable(),
  exitCode: z.int().nullable(),
  since: TimestampSchema.nullable(),
});
export const SessionListResponseSchema = z.strictObject({
  items: z.array(z.strictObject({ taskId: IdSchema, ...SessionSummarySchema.shape })),
});
export const versionSessionsPath = (projectId: string, versionId: string) =>
  `${API_BASE_PATH}/projects/${projectId}/versions/${versionId}/sessions`;
// The Board socket's `session` message gains: status, reason, since (same types as the summary).
// protocol.ts: SessionActivitySchema message `session.activity`, SessionSyncSchema message
// `session.sync`, both in WorkerToApiMessageSchema; a fourth capability tuple
// [repository.init, agent.session, repository.clone, agent.session.status].
```

- [ ] **Step 1:** Write `session-status.test.ts`: the four-capability list registers and `[init, session, status]` is rejected; `session.activity` accepts `{activity:'needs_input',detail:'asked_in_text'}` and rejects `detail:'free text'`; `session.exit` parses with and without `stopped`; `session.sync` accepts a starting session with null worktree and rejects an unknown state; the Board `session` message requires `status`, `reason`, `since`.
- [ ] **Step 2:** Run `pnpm --filter @atlas/contracts test`; expect the new file to fail.
- [ ] **Step 3:** Implement the schemas and exports above.
- [ ] **Step 4:** Run `pnpm --filter @atlas/contracts test && pnpm --filter @atlas/contracts build`. If an existing contract test fails because the `session` message gained required fields, stop and ask (see "Test permissions").
- [ ] **Step 5:** Commit: `feat(contracts): add session activity, sync and status`.

### Task 2: Worker run record, run choice and trust

**Files:**

- Create: `apps/worker/src/sessions/record.ts`, `apps/worker/src/sessions/trust.ts`
- Modify: `apps/worker/src/sessions/agents.ts` (add only; keep `agentArgs` as it is)
- Test: `apps/worker/tests/session-record.test.ts`, `apps/worker/tests/session-trust.test.ts` (new)

**Produces:**

```ts
// record.ts — file `<stateDir>/session-records/<sessionKey>.json`, mode 0600, directory 0700
export interface RunRecord {
  agentSessionId: string;
  delivered: boolean;
}
export function readRecord(stateDir: string, key: string): Promise<RunRecord | null>; // null if missing or invalid
export function writeRecord(stateDir: string, key: string, record: RunRecord): Promise<void>;
// True when `<home>/.claude/projects/*/<id>.jsonl` exists as a regular file.
export function conversationExists(home: string, agentSessionId: string): Promise<boolean>;
export type RunMode = 'first' | 'resume' | 'fresh';
export function chooseRun(record: RunRecord | null, hasConversation: boolean): RunMode;
//   no record or !delivered && !hasConversation -> 'first'; hasConversation -> 'resume';
//   delivered && !hasConversation -> 'fresh'
// agents.ts
export function sessionArgs(input: {
  profile: AgentProfile;
  command: string[];
  prompt: string;
  sandboxed: boolean;
  mode: RunMode;
  agentSessionId: string;
  hookSettings: string | null;
}): string[];
// trust.ts — returns whether the record is now present
export function trustWorktree(configPath: string, worktreePath: string): Promise<boolean>;
export const RUN_NOTICES: Record<RunMode, string>;
```

Fixed values:

- Claude argument order: `[...command.slice(1), ...sandboxArgs if sandboxed, '--settings', hookSettings (if not null), then]` `first`: `'--session-id', id, prompt`; `resume`: `'--resume', id`; `fresh`: `'--session-id', id`. The prompt keeps the leading-dash rule of `agentArgs`.
- Codex and custom: `first` is exactly `agentArgs(...)`; `resume` and `fresh` are `agentArgs` with an empty prompt. No `--settings`, no IDs.
- `RUN_NOTICES`: `first` "Atlas: first run, the task prompt was sent.\r\n"; `resume` "Atlas: resumed the earlier conversation; the task prompt was not sent again.\r\n"; `fresh` "Atlas: the earlier conversation is gone; started without the task prompt.\r\n".
- `trustWorktree`: `lstat` must be a regular file of at most 5 MB; content must parse to a non-array object; set `projects[worktreePath].hasTrustDialogAccepted = true` keeping every other key and the two-space indentation; write through the open file (`r+`, truncate, write), never rename; read back and confirm the flag. Any failure returns `false` and never throws. Nothing from the file is logged.

- [ ] **Step 1:** Write the tests. Record: round trip; invalid JSON reads as null; file mode is 0600. `chooseRun`: the four combinations. `conversationExists`: true for `projects/x/<id>.jsonl`, false for a directory of that name. `sessionArgs`: the three Claude lists above, with and without sandbox; Codex `resume` has no prompt. Trust: other keys and projects kept and inode unchanged; missing file, invalid JSON, array, symlink and oversized file each return false and leave the file byte-identical.
- [ ] **Step 2:** Run `pnpm --filter @atlas/worker test -- session-record session-trust`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command; expect pass.
- [ ] **Step 5:** Commit: `feat(worker): record agent runs and trust task worktrees`.

### Task 3: Worker status channel

**Files:**

- Create: `apps/worker/src/sessions/status.ts`
- Modify: `apps/worker/src/sessions/sandbox.ts` (`sandboxSettings` gains optional `extraWritable?: string[]`, appended to `allowWrite` only when given)
- Test: `apps/worker/tests/session-status.test.ts` (new)

**Produces:**

```ts
export interface AgentActivity {
  activity: SessionActivity;
  detail: SessionActivityDetail | null;
}
// Creates `<base>/hook.cjs` (mode 0444) once; `base` is an mkdtemp folder under os.tmpdir().
export function writeHookScript(base: string): Promise<string>;
// The JSON for `--settings`: hooks that run `node <script> <event> <statusFile>`.
export function hookSettings(scriptPath: string, statusFile: string): string;
export function parseStatus(text: string): AgentActivity[]; // unknown lines are dropped
export function watchStatus(
  file: string,
  onActivity: (a: AgentActivity) => void,
  intervalMs?: number,
): { stop(): void }; // polls; default 500 ms
export const MAX_STATUS_FILE_BYTES = 65_536;
```

Fixed values:

- Hooks: `UserPromptSubmit` → `working`; `PreToolUse` and `PermissionRequest` with matcher `AskUserQuestion`, and `PermissionRequest` without matcher → `needs_input`; `PostToolUse` matcher `AskUserQuestion` → `working`; `Stop` → `needs_input asked_in_text` when `last_assistant_message` matches `/\?\s*$/`, else `idle`; `StopFailure` → `error <kind>` where kind is the hook's matcher value when it is one of the detail codes, else `unknown`.
- Line format written by the hook: `<activity> <detail or ->\n`. The script reads its JSON from stdin and writes nothing else; it must not throw on bad input.
- `watchStatus` reads only the bytes after its last offset, only if `lstat` says regular file and size ≤ `MAX_STATUS_FILE_BYTES`; past the limit it stops reporting. It reports only the last valid line of each read.
- The status folder for a session is `<base>/<sessionKey>/`, file `status`. The manager (Task 4) creates it and passes it as `extraWritable`.

- [ ] **Step 1:** Write the tests. `parseStatus`: valid lines, junk, an unknown detail, an over-long line. Hook script run with `node`: a `Stop` input ending in "?" appends `needs_input asked_in_text`, one ending in "." appends `idle -`, and the output never contains the message text; malformed stdin exits 0. `watchStatus` with a temp file: sees appended lines, ignores a symlink, stops past the size limit. `sandboxSettings` with `extraWritable` appends it; without it the result equals today's.
- [ ] **Step 2:** Run `pnpm --filter @atlas/worker test -- session-status`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/worker test`; expect pass, existing sandbox tests included.
- [ ] **Step 5:** Commit: `feat(worker): read agent activity from Claude hooks`.

### Task 4: Worker session manager and connection

**Files:**

- Modify: `apps/worker/src/sessions/manager.ts`, `apps/worker/src/connection.ts`
- Test: `apps/worker/tests/session-runs.test.ts` (new; use the stand-in agent pattern of `apps/worker/tests/sessions.test.ts`)

**Consumes:** Tasks 1 to 3.

**Produces:**

```ts
// manager.ts
export type SessionEvent = /* existing three */ Pick<SessionActivityMessage, 'type' | 'payload'>;
class SessionManager {
  // Sessions running or still starting, for session.sync.
  snapshot(): SessionSyncPayload['sessions'];
}
// constructor options gain: home?: string (default os.homedir()), statusPollMs?: number
```

Behaviour:

- `launch`: read the record and `conversationExists`, `chooseRun`; for `first` and `fresh` make a new UUID and write the record (`delivered` unchanged or false) before spawning. For Claude: create the status folder and file, pass `hookSettings`; when sandboxed call `trustWorktree(join(home, '.claude.json'), path)` and pass the status folder as `extraWritable`. With the sandbox off, do not call `trustWorktree`.
- After `session.started` and the sandbox notice, emit the `RUN_NOTICES` line as `session.output`. For `resume` and `fresh` emit `session.activity` `{activity:'idle', detail:'resumed'}`.
- Forward `watchStatus` reports as `session.activity` with the session's current `runId`; keep the last one for `snapshot()`.
- On exit: stop the watcher, remove the status folder; if `conversationExists` and the record is not `delivered`, write `delivered: true`. `session.exit` carries `stopped: true` when `stop()` was called for that session.
- For Codex and custom commands write the record with `delivered: true` once the process has spawned.
- `connection.ts`: register with the four capabilities. Keep exits emitted while not registered (cap 500, oldest dropped). After `worker.registered`, send `session.sync` with `sessions.snapshot()` and the kept exits, then clear them.

- [ ] **Step 1:** Write the tests with a stand-in agent that echoes its arguments: the second start after an exit passes no prompt when a conversation file exists for the recorded ID, and passes it again when none exists and `delivered` is false; a `fresh` run happens when `delivered` is true and the file is gone; the notice line for each mode is in the output; a no-prompt run emits `idle resumed`; a line appended to the status file becomes `session.activity`; `stop()` gives `stopped: true`; `snapshot()` lists a pending start as `starting`; with `sandbox: 'off'` the fake `.claude.json` is untouched. Connection: after a reconnect the first message after `worker.register` handling is `session.sync` and carries an exit that happened while disconnected.
- [ ] **Step 2:** Run `pnpm --filter @atlas/worker test -- session-runs`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/worker test`. Existing tests that fail are handled under "Test permissions".
- [ ] **Step 5:** Commit: `feat(worker): resume sessions and report their activity`.

### Task 5: API status and start on move

**Files:**

- Create: `apps/api/src/sessions/status.ts`
- Modify: `apps/api/src/sessions/hub.ts`, `apps/api/src/tasks/service.ts`, `apps/api/src/tasks/routes.ts`, `apps/api/src/app.ts`
- Test: `apps/api/tests/session-status.test.ts`, `apps/api/tests/session-move.test.ts` (new)

**Produces:**

```ts
// status.ts — pure
export interface StatusInput {
  session?: {
    state: 'starting' | 'running' | 'exited';
    activity: SessionActivity | null;
    detail: SessionActivityDetail | null;
    exitCode: number | null;
    message: string | null;
    stopped: boolean;
    lost: boolean;
    since: string;
  };
  failedStart?: { message: string; since: string };
  workerOnline: boolean;
  hasCheckout: boolean;
}
export function summarize(input: StatusInput): SessionSummary;
// hub.ts
class SessionHub {
  startForMove(taskId: string): void; // never throws ApiError
  clearFailedStart(taskId: string): void;
  summary(taskId: string): SessionSummary;
  summaries(taskIds: string[]): Array<{ taskId: string } & SessionSummary>; // omits status 'none'
  onActivity(workerId: string, payload: SessionActivityPayload): void;
}
// service.ts: moveTask returns { task: Task; previousStatus: TaskStatus }
export const DEFAULT_SESSION_SIZE = { cols: 120, rows: 30 };
```

`summarize` rules, first match wins:

| Condition                                   | status / reason / message                                               |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| no session, no failed start, `!hasCheckout` | none / no_checkout                                                      |
| no session, failed start                    | problem / not_started / the refusal message                             |
| no session                                  | none / none                                                             |
| exited, `lost`                              | problem / worker_lost / "The Worker restarted and the session was lost" |
| exited, `stopped`                           | ended / stopped                                                         |
| exited, exit code 0                         | ended / exited / session message                                        |
| exited, exit code null                      | problem / start_failed / session message                                |
| exited, other code                          | problem / exit_error / session message                                  |
| live, `!workerOnline`                       | problem / worker_offline                                                |
| starting                                    | working / starting                                                      |
| activity `error`                            | problem / api_error / the detail code                                   |
| activity `needs_input`                      | needs_input / asked_in_text when that is the detail, else dialog        |
| activity `idle`                             | finished / resumed when that is the detail, else finished               |
| otherwise                                   | working / working                                                       |

Behaviour:

- `hub.start` also refuses an online Worker without `AGENT_SESSION_STATUS_CAPABILITY` with the existing 409 `sessions_unsupported`.
- `startForMove` calls `start(taskId, DEFAULT_SESSION_SIZE)`. On `ApiError` `no_checkout` it records nothing; on any other `ApiError` it records a failed start with the error's message and the current time. A successful `start` clears the failed start.
- Each session keeps `activity`, `detail`, `stopped`, `lost` and `since` (set to `context.now()` whenever the summary would change). `onStarted` ignores a session that has exited.
- The Board `session` message is built from the snapshot plus `summary(taskId)`; `attach` on a task with only a failed start still sends it. Broadcast on every change, activity included.
- Move route: after `moveTask`, when `previousStatus !== 'working' && task.status === 'working'` call `hub.startForMove`; when `previousStatus === 'working' && task.status !== 'working'` call `hub.clearFailedStart`. The response is unchanged.

- [ ] **Step 1:** Write `session-status.test.ts`: one case per table row. Write `session-move.test.ts` with the simulated Worker of `apps/api/tests/support/fake-worker.ts`: moving todo → working sends one `session.start` with cols 120, rows 30; reordering inside working sends none; the move plus a socket `start` in the same tick send one; with the Worker offline the move answers 200 and the socket snapshot is `problem / not_started`; moving that task back to todo gives `none`; a Worker with three capabilities gives `problem / not_started` with "too old"; moving a task with an exited session back into working sends a second `session.start`; `session.activity` for a stale `runId` changes nothing.
- [ ] **Step 2:** Run `pnpm --filter @atlas/api test -- session-status session-move`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/api test`. Existing failures are handled under "Test permissions".
- [ ] **Step 5:** Commit: `feat(api): start a session when a task moves to Working`.

### Task 6: API Worker sync, offline status and the list route

**Files:**

- Modify: `apps/api/src/sessions/hub.ts`, `apps/api/src/sessions/routes.ts`, `apps/api/src/workers/gateway.ts`
- Test: `apps/api/tests/session-sync.test.ts` (new)

**Produces:**

```ts
class SessionHub {
  onWorkerRegistered(workerId: string): void; // records a registration mark, rebroadcasts
  onWorkerDisconnected(workerId: string): void; // rebroadcasts (status becomes worker_offline)
  onSync(workerId: string, payload: SessionSyncPayload): void;
}
// GET /api/v1/projects/:projectId/versions/:versionId/sessions -> SessionListResponse
```

Behaviour:

- The hub numbers starts and registrations with one counter. `onSync` first applies `exits` through `onExit`, then for each listed session updates activity (or adopts it: unknown task ID → ignore; task exists and its project's Worker is this one → create the session with the Worker's `runId`, state, path and branch), then marks every other live session of that Worker whose start number is below the registration mark as exited with `lost: true`.
- Gateway: call `onWorkerRegistered` after `registry.register`, `onWorkerDisconnected` in the close handler, route `session.activity` and `session.sync` to the hub.
- The list route uses `listTasks` for the IDs and returns `hub.summaries(ids)`; it has no `access` value, so it needs a session when sign-in is on.

- [ ] **Step 1:** Write the tests: sync without a known running session ends it as `worker_lost`; sync that lists it keeps it and applies its activity; a session started after the registration and missing from the sync stays `working`; an exit carried in the sync gives `ended`, not `worker_lost`; a late `session.started` for an ended session does not revive it; an unknown listed session for an existing task is adopted and appears in the list route; a disconnected Worker gives `worker_offline` and the status returns after reconnect and sync; the list route omits tasks with status `none` and answers 401 without a session when sign-in is on.
- [ ] **Step 2:** Run `pnpm --filter @atlas/api test -- session-sync`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/api test`.
- [ ] **Step 5:** Commit: `feat(api): sync sessions with a reconnecting Worker`.

### Task 7: Board status dots

**Files:**

- Create: `apps/board/src/features/sessions/status.tsx`
- Modify: `apps/board/src/lib/queries.ts`, `apps/board/src/features/board/BoardDnd.tsx`, the component that renders `BoardDnd` (pass the map), `apps/board/src/styles.css`
- Test: `apps/board/tests/session-status.test.tsx` (new)

**Produces:**

```tsx
export function useSessions(projectId: string, versionId: string, ready: boolean); // refetchInterval 3_000
export function statusSentence(summary: SessionSummary): string;
export function StatusDot({ summary }: { summary: SessionSummary }): JSX.Element | null; // null for 'none'
// BoardDnd gains an optional prop: sessions?: ReadonlyMap<string, SessionSummary>
```

Fixed values:

- Dot: `<span className="status-dot <status>" role="img" aria-label="<label>" title="<sentence>">`, labels "Agent working", "Agent needs you", "Agent finished", "Agent problem", "Session ended". It sits before the title in `TaskContents`.
- Tokens in both themes in `styles.css`: `--status-working`, `--status-needs-input`, `--status-finished`, `--status-problem`, `--status-ended`. The `working` dot pulses; no animation under `prefers-reduced-motion: reduce`.
- Sentences by reason: `starting` "Starting…"; `working` "Working since HH:MM"; `dialog` "Waiting for your answer"; `asked_in_text` "The agent asked something in its last message (a guess from its last character)"; `finished` "Finished at HH:MM, waiting for your next message"; `resumed` "Resumed, waiting for your message"; `not_started` "Session not started: <message>"; `start_failed` "<message>"; `exit_error` "Agent exited with code <n>"; `api_error` "Model API error: <kind with spaces>"; `worker_offline` "Worker offline"; `worker_lost` "<message>"; `exited` "Ended at HH:MM (exit code 0)" plus the message when present; `stopped` "Stopped at HH:MM"; `no_checkout` "This project has no checkout on a worker, so no session can run"; `none` "No session yet".

- [ ] **Step 1:** Write the tests: one sentence per reason; a card with a `needs_input` summary has an element with the accessible name "Agent needs you"; a card with no entry has no dot.
- [ ] **Step 2:** Run `pnpm --filter @atlas/board test -- session-status`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/board test`.
- [ ] **Step 5:** Commit: `feat(board): show a session status dot on task cards`.

### Task 8: Board task panel

**Files:**

- Create: `apps/board/src/features/sessions/useTaskSession.ts`
- Modify: `apps/board/src/features/sessions/TaskSession.tsx`, `apps/board/src/features/sessions/SessionTerminal.tsx`, `apps/board/src/features/tasks/TaskDetails.tsx`
- Test: `apps/board/tests/task-session-controls.test.tsx` (new); the two existing files under "Test permissions"

**Produces:**

```tsx
// A light socket for the panel: live summary and a way to start. Closed on unmount.
export function useTaskSession(taskId: string): {
  connected: boolean;
  info: SessionMessage | null;
  error: string | null;
  start(): void;
};
export function TaskSession({ taskId, taskStatus }: { taskId: string; taskStatus: TaskStatus });
```

Behaviour:

- The panel always shows the dot and `statusSentence`, from `useTaskSession`.
- Button by the spec's table: state `starting` or `running` → "Connect" / "Hide terminal" (toggles the terminal, sends nothing); `taskStatus === 'working'` and state `none` → "Start session"; `working` and `exited` → "Resume session"; both call `start()` with `DEFAULT` size 120 by 30 and open the terminal. State `exited` in any column also shows "Show last output" / "Hide terminal". Status `no_checkout`: no button.
- `SessionTerminal` keeps its `{ taskId }` props and its own socket, loses the start button and the two overlay texts that mention it, keeps Stop. Its overlay for a non-live session reads "This session is not running."
- `TaskDetails` passes `task.status`, and shows under the description field, when the summary is not `none`: "The agent got the description when its session first started. Later edits do not reach it."

- [ ] **Step 1:** Write the tests with the socket stand-in of `apps/board/tests/support`: each row of the button table; "Connect" sends no message; "Resume session" sends one `start`; a todo task with an exited session shows only "Show last output"; the description note appears only with a session.
- [ ] **Step 2:** Run `pnpm --filter @atlas/board test -- task-session-controls`; expect failures.
- [ ] **Step 3:** Implement, then apply the approved changes to the two existing test files.
- [ ] **Step 4:** Run `pnpm --filter @atlas/board test`.
- [ ] **Step 5:** Commit: `feat(board): connect to, start and resume a task session`.

### Task 9: Documentation

**Files:** `docs/development/protocol.md`, `docs/development/local-setup.md`, `docs/development/acceptance.md`

- [ ] **Step 1:** `protocol.md`: the fourth capability list and its compatibility lines (API before Worker; an older Worker gets no sessions); `session.activity`, `session.sync`, `stopped` in `session.exit`; the changed meaning of `session.start`'s prompt; the Board `session` message's new fields; the sessions list route; start on move.
- [ ] **Step 2:** `local-setup.md`, "Agent sandbox": the trust record (sandboxed sessions only, what trust lets a repository's Claude settings, hooks and MCP servers do, that they run in the sandbox), the status folder as a writable path, resume and its three cases, Codex and custom commands unverified, `StopFailure` unverified. Replace the sentence that says Claude still asks the folder-trust question.
- [ ] **Step 3:** `acceptance.md`: a dated section with the pre-build check results above and the manual checks of Task 10.
- [ ] **Step 4:** `pnpm exec prettier --check` on the three files; commit: `docs(repo): document session start, resume, trust and status`.

### Task 10: Verification

- [ ] **Step 1:** `pnpm check`; expect pass. Report any remaining failure with its output.
- [ ] **Step 2:** `pnpm test:docker`; expect pass.
- [ ] **Step 3:** With `pnpm dev` and the user present, in the Board, both themes: move a task to Working and see one session and a blue dot; no trust question; ask the agent for a question dialog and see amber; let it finish and see green; Stop and see grey; "Resume session" continues the conversation and the task is not repeated; stop the Worker container and see red, restart and see the sync result. Record the results in `acceptance.md` and commit.
- [ ] **Step 4:** Request an independent review of `main..HEAD` (superpowers:requesting-code-review); fix Critical and Important findings; report which review was independent and which was self-review.
