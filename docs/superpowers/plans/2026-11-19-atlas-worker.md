# Atlas Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. User overrides mandatory TDD. Existing tests require permission to change.

**Goal:** Register an Atlas Worker with the API and safely initialize requested local repositories.

**Architecture:** A standalone Node.js service initiates WebSocket communication. A durable local journal makes repeated command delivery safe; filesystem work is confined to a configured workspace.

**Tech Stack:** TypeScript, Node.js, `ws` client, shared schemas, local journal files, system Git, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-atlas-local-mvp-design.md`; frozen protocol in sibling `2026-11-19-atlas-foundation-and-integration.md`.

## Global Constraints

- Run all three apps in WSL; Worker uses Linux paths.
- No HTTP server, database access, terminals or SDK integrations.
- Existing tests require permission to change, disable or bypass. No mandatory TDD.
- Never initialize/overwrite an existing target folder. Never automatically delete partial folders.
- Run Git with argument arrays; never interpolate commands through a shell.

## Review Focus

1. Traversal, symlinked parents and existing targets cannot escape/overwrite workspace (task 2).
2. Two commands targeting the same folder cannot both initialize it (task 2).
3. Repeated id with different payload cannot be treated as same valid command (task 2).
4. Crash between folder creation and journal persistence cannot justify reinitialization (task 2).
5. Losing result acknowledgment must not lose the outcome or repeat execution (task 3).

## Task 1: Worker lifecycle and registration

**Files:** `apps/worker/src/{main,config,connection}.ts`, `src/state/lock.ts`, `.env.example`, `tests/connection.test.ts`, `tests/helpers/api-harness.ts`.

**Interfaces:** `loadConfig(env:NodeJS.ProcessEnv):WorkerConfig`; `startWorker(config:WorkerConfig):Promise<{stop():Promise<void>}>`. Config: API WS URL, token, stable worker id, display name, absolute workspace root and state directory. `connect(config,onCommand:(command:RepositoryInitCommand)=>Promise<void>)` supplies a typed send/replay interface.

- [ ] Validate config before connecting. Create or validate workspace root and separate state directory; resolve canonical root. Journal must be outside repository targets. Explicitly configured stable id survives restarts; do not generate random identity on each connection. Acquire exclusive process lock for state directory, including a documented stale-lock recovery check; duplicate local process must not run commands simultaneously.
- [ ] Connect with bearer authorization, install listeners before registration, advertise only `repository.init`, validate incoming envelopes and send heartbeats according to server acknowledgment. Reconnect with frozen backoff constants; stop cleanly and release lock. Reject unsupported protocol messages without launching operations. Do not log credentials.
- [ ] Add harness tests: correct registration, same identity after reconnect, authentication rejection, heartbeat interval, unsupported protocol, malformed command, duplicate process lock and stop during reconnect. Bounded injected timers may test backoff without long real sleeps. Assert shutdown leaves no reconnect timer.
- [ ] Run Worker tests/typecheck/lint; commit `feat(worker): register persistent api connection`.

## Task 2: Safe initialization and durable command journal

**Files:** `apps/worker/src/repositories/{paths,initialize,recover}.ts`, `src/state/journal.ts`, `tests/{repository-paths,repository-init,recovery}.test.ts`.

**Interfaces:** `resolveTarget(root:string,relativePath:string):Promise<string>`; `initializeRepository(command:RepositoryInitCommand,context:ExecutionContext):Promise<CommandOutcome>`; `recoverCommand(entry:JournalEntry,context:ExecutionContext):Promise<CommandOutcome>`; journal `get(commandId)`, `write(entry)`, `listUnacknowledged()`. Context provides canonical root, journal, and Git executable. Journal entries include immutable command payload, target, stage, owned-directory device/inode metadata when known, result and acknowledgment state.

- [ ] Resolve paths lexically and canonically: reject absolute/empty/dot paths, `..` segments, symlink parents and root itself. Require existing parent directories beneath canonical root; nested target creation is allowed only when its parent already exists. Create leaf exclusively with nonrecursive mkdir. Reject preexisting files/directories including symlinks; do not use `git init` idempotence as an ownership check.
- [ ] Persist validated command intent before mkdir. Record created folder identity before spawning Git. Use atomic journal replacement with flushed file and directory writes on local filesystem. Run `git init` in that folder with argument-array child process and no shell. Bound execution time and captured output; do not create commit or remote. Preserve target on any failure and report readable error/path. Serialize repository operations in process.
- [ ] Store terminal outcomes before sending results. Same id/payload returns stored outcome or waits for same in-progress command; changed payload with same id returns protocol conflict and does not modify the original journal. If process crashes, resume only by inspection: known owned directory with expected Git state may be reported succeeded; no owned-directory proof or partial state yields needs-attention. Never rerun initialization or remove a folder automatically during recovery.
- [ ] Add real temporary-filesystem/Git tests: new target has `.git` and no commit/remote; duplicate command yields same outcome; existing file/dir contents unchanged; traversal/absolute/symlink paths fail; two ids targeting same folder yield one success; changed payload rejected; injected crashes before/after mkdir/journal/result produce conservative recovery. Verify missing Git and Git failure preserve folder and report failure. Tests use temporary roots only.
- [ ] Run full Worker suite/typecheck/lint. Commit `feat(worker): initialize repositories with durable deduplication`.

## Task 3: Command delivery and result replay

**Files:** `apps/worker/src/commands/dispatcher.ts`, `src/main.ts` wiring, `tests/command-delivery.test.ts`.

**Interfaces:** `dispatch(command:RepositoryInitCommand):Promise<CommandOutcome>` queues one at a time; `replayResults():Promise<void>` sends unacknowledged results after registration; result acknowledgment updates the matching journal durably. Retain completed journal entries for deduplication; no automatic garbage collection in MVP.

- [ ] Connect validated dispatch to journal/initializer, send accepted after durable receipt, return stored result for duplicates, and replay results after reconnect. Continue active Git operation through a temporary connection loss. On shutdown, stop accepting new work and wait for active operation within a bounded grace period; if terminated early retain recovery evidence.
- [ ] Add harness tests that drop socket before acceptance, during Git, after result but before acknowledgment, and during replay. Assert one initialization, stable result, replay until ack, no replay after ack unless duplicate command is delivered, and malformed acknowledgments do not discard journal outcomes.
- [ ] Run Worker suite, build and root contract checks. Commit `feat(worker): replay command outcomes across reconnects`. Provide documented local launch/config examples to integration coordinator.
