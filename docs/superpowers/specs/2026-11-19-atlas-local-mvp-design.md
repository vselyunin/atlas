# Atlas local MVP: Board, API, Worker

Status: design and repository conventions approved by user; implementation plans prepared separately. No mandatory TDD. Existing tests require permission to change.

## Intent

Restart Atlas with three small, locally hosted TypeScript projects developed in parallel against an agreed contract: Board UI, API, and Worker. One personal workspace belongs to Vladi. The board organizes work; assignments record responsibility and never launch agents in this MVP. A worker can initialize a local Git repository on explicit request.

## Agreed behavior

- Select a project and one of its versions to view tasks.
- Four fixed columns: Backlog, To do, Working, Done.
- Create tasks only in Backlog. Drag tasks between columns.
- All task fields are editable in Backlog. In To do and Working, only description is editable. Done fields cannot be edited. Status transitions are a separate operation, allowed from any column to any other column; returning to Backlog unlocks all fields, including for tasks previously Done.
- Tasks have both type and priority, and an optional responsible worker from the API list.
- The worker list includes registered Atlas workers and Vladi as its only human. No UI for manually managing workers.
- Project creation has two modes: record an existing Git URL, or initialize a Git repository in a local folder.
- All application code uses TypeScript. Board: React/Vite/Tailwind. API: Fastify on Node.js. Worker: standalone Node.js process connecting to API; no HTTP server required.
- Board operations use HTTP. Worker communication uses a persistent WebSocket initiated by the Worker.
- SQLite with Drizzle stores application data, owned exclusively by the API.
- One Git repository with independently runnable `apps/board`, `apps/api`, and `apps/worker`, plus `packages/contracts` as the shared contract source. One repository does not require one process or deployment.
- Run all three apps in WSL; open the board in the Windows browser. Worker Git commands and filesystem paths use WSL/Linux semantics. Native Windows service execution is outside this MVP.

## Approaches considered

1. Browser-only storage: smallest prototype, but cannot serve the separately requested API and Worker. Rejected in favor of three cooperating projects.
2. Direct API HTTP calls to Worker, or worker polling: viable for repo creation but either requires a Worker HTTP server or polling/job plumbing. User selected persistent WebSockets to support later interactive sessions.
3. Express, Fastify, Hono: Express requires assembling more conventions; Hono emphasizes runtime portability. Fastify selected for standalone Node API, schema validation and WebSocket integration.
4. Next.js versus React/Vite: Next adds server rendering capabilities not needed by this personal board with a separate API. React/Vite selected.
5. Fastify on Worker: unnecessary for an outbound WebSocket client. User accepted a standalone Node service, with the option to add HTTP endpoints later.
6. Separate repositories versus one repository: separate repos provide independent access/release ownership but require distributing shared contracts and coordinating changes. User selected one repo with three apps so contract changes and checks can be made together. Protocol versioning remains necessary for older running workers.

## Approved defaults (originally proposed by designer)

- Task types: Epic, Story, Task, Bug; default Task. These are labels only; no parent/child hierarchy in this MVP.
- Priorities: Low, Medium, High, Urgent; default Medium.
- Task fields: title (required), description (plain text, optional), type, priority, assignee (optional), project/version association. Project association is fixed; changing version is allowed only in Backlog and only within the project.
- Create a first version named `v0.1` with each project. Allow adding versions by unique name within a project. No version lifecycle, renaming, deletion, or release automation.
- Support adding and editing tasks, but no deletion, archiving, search, filters, attachments, comments, dependencies, or audit-history UI.
- Manual ordering within columns, persisted by the API; priority does not automatically sort cards. Dragging within Done changes placement only, not task content.
- New repo folders are relative to a configured Worker workspace root. User enters a folder name/path in the form; UI shows the resolved target. Reject absolute paths, traversal, symlink escapes, and existing target folders. Never overwrite or initialize an existing folder. Worker creates a fresh folder and runs `git init`, without an initial commit or remote.
- Existing-repository mode stores name and Git URL only; no cloning or validation through network access.
- SQLite is a local file; no database service, Docker, login screen, or multi-user accounts required.
- UI/API listen on loopback only. A configured shared token authenticates Worker connections, and browser origins are restricted to the local board. API is not exposed to LAN/internet in this MVP.
- Use a pnpm workspace to share contracts directly between the three apps. Shared contracts contain runtime schemas and inferred TypeScript definitions, not database or service implementation code.

## Board UI

Top bar: project selector with Create project action, then version selector with Add version action. Main view: four columns, card counts, and task cards showing title, type, priority, and assignee. Only Backlog has Add task. Empty projects and columns have clear empty states.

Click a card to open a side panel. Show all fields but enable edits according to current status. Keep moves available even for Done. Provide a status control as a keyboard-accessible alternative to drag and drop. New tasks start unassigned in Backlog unless a worker is chosen.

Create project form has a name plus mode selector. Existing mode asks for Git URL. Local mode asks for online Atlas worker and folder path, displaying its configured root. Preselect the worker if only one is online. Disable local creation if none are online; show the reason. Report initialization progress and failures. Do not claim the repository exists until the worker reports success.

Use TanStack Query for API state, shadcn/ui controls, and a drag-and-drop library (dnd-kit proposed; exact compatible version and integration left to builder). Failed moves restore the server state and show a useful error. Invalid/stale edits refresh the task instead of silently overwriting.

The existing mockup is exploratory and is not the final specification: it still shows Add task outside Backlog and lacks types, priorities, and project creation. Update it to these rules before final UI implementation review.

## API data and operations

Entities:

- Project: id, name, repository mode, Git URL or local path, worker id for local repositories, creation state, timestamps.
- Version: id, project id, name, timestamps.
- Task: id, project id, version id, title, description, status, type, priority, nullable assignee id, order, revision, timestamps.
- Worker: stable id, name, kind (human/atlas), last-seen time, connected state, advertised workspace root and capabilities for Atlas workers. Human Vladi is seeded once with a stable id.
- Command: id, worker id, project id, kind, payload, execution state, result/error, timestamps.

HTTP contract families (exact schema and route definitions belong to the implementation plan):

- List/create projects and read project creation status.
- List/create versions under a project.
- List workers with online/offline state and capabilities. Retain offline workers so historical assignments remain resolvable. New assignments require a known worker but may target an offline worker because no execution occurs.
- List tasks for project/version; create task in Backlog; patch editable task fields; move/reorder task.
- Read repository-creation operation status.

API checks required fields, enum values, project/version membership and worker existence. It enforces editing rules using stored status, not status supplied by the client. Moves/patches include task revision; stale revisions return conflict. Ordering updates and task revisions are transactional. A transition cannot carry forbidden field changes; move to Backlog first, then edit.

Project creation is asynchronous for local repos: persist pending project and command, respond with their ids, dispatch to online worker, and let UI poll creation status. On success store local path, mark ready, create initial version atomically. On failure show failure and retain command details. Existing-repository projects become ready immediately with initial version. Board only permits task work in ready projects.

## Worker and WebSocket contract

Worker requires API URL, token, stable worker id, display name and workspace root. It connects, authenticates, registers its identity and `repository.init` capability, and sends heartbeats. API persists metadata and computes availability; absence/disconnect marks offline. Reconnect with bounded exponential backoff. Stable identity survives restarts. Reject simultaneous connections using the same id rather than replacing an active worker silently.

Use versioned JSON envelopes with message type, message id, optional command id and payload. MVP messages cover register/registered, heartbeat, command dispatch, accepted, result, and error. Both sides validate messages at runtime. HTTP and WebSocket schemas live in a single shared contract source, exposed without importing API database/business code.

Repository creation runs Git with argument arrays, never a shell-interpolated command. Check Git availability and report readable errors. Process one repository command at a time for this MVP. Command ids identify the same operation across reconnects; keep a local durable command journal outside target repositories. Duplicate dispatch returns stored status/result, never creates a second repository.

If a connection drops, keep the request pending/unknown rather than assume failure. Worker may finish while disconnected and report its result after reconnect. On process restart, reconcile a started command only against its recorded, worker-created target and Git state; do not re-run `git init` blindly. Ambiguous state is reported as needing attention. Partial folders are retained and disclosed rather than deleted automatically. API resends/reconciles existing command ids; it does not automatically create new operation ids to retry.

## Future agent sessions (explicitly outside MVP)

Worker is a service; agent sessions are task-related processes it will later manage. Future Board terminal panel connects to API over WebSocket; API routes to the correct Worker session. Sessions must outlive the panel, support attach/reconnect, input/output, resize and flow control.

Keep worker command handling extensible by capability and message type, but do not implement terminals, agent execution, SDK integrations, terminal buffering or session lifecycle now. SDK-based agent events and interactive CLI terminals may need different adapters; choosing TypeScript/WebSockets does not imply SDKs provide attachable terminals automatically.

## Parallel development and validation

### Agent instructions and development workflow

User requires a root `AGENTS.md` explaining communication among the three apps, and one in each app. Root instructions describe app ownership, HTTP and WebSocket flows, shared-contract change policy, WSL commands, and cross-project verification. `apps/board/AGENTS.md`, `apps/api/AGENTS.md`, and `apps/worker/AGENTS.md` contain local responsibilities and checks without duplicating shared rules. A short `packages/contracts/AGENTS.md` is also proposed to protect protocol compatibility and runtime schema ownership.

User decision: no TDD requirement for now. Existing tests must not be modified without explicit user permission. This includes deleting, skipping, disabling, weakening assertions, updating snapshots/expected fixtures, or changing test configuration to exclude or bypass checks. Before requesting permission, explain the specific proposed change and why it is necessary. A failing test alone is not permission to change it. Fix production behavior when appropriate, and report unresolved failures honestly. New tests may be added without asking when useful, but must not alter or bypass existing coverage. These rules belong in the root AGENTS.md and apply across all apps; per-app instructions reference them rather than redefining them.

Keep meaningful verification for API editing rules, Worker filesystem and reconnect behavior, contract validation, and observable Board interactions. Validate visual styling by preview rather than brittle markup snapshots; pure documentation/configuration changes do not need artificial tests. Use existing systematic-debugging, verification-before-completion and code-review skills where applicable. User's decision to omit TDD overrides conflicting skill defaults. Do not install additional skills or create a custom skill merely to restate AGENTS.md. Split implementation planning into foundation/contracts plus Board, API, Worker, and final integration tracks.

### Approved persistent repository conventions

- Centralize conventions in root AGENTS.md and a concise `docs/development/conventions.md`. Shared configuration is authoritative; per-app overrides require a concrete reason. Repository instructions remain portable across coding agents and do not depend on installed personal skills.
- ESLint with TypeScript-aware rules checks code; Prettier owns formatting. Root commands: `pnpm lint`, `pnpm format:check`, `pnpm format`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Configure package scripts so root checks cover the relevant apps and contracts. No blanket lint autofix or formatting may change protected test files without permission; initially exclude existing tests from write-mode tools while still checking them.
- TypeScript: strict mode with `noUncheckedIndexedAccess`, ESM imports, `import type` for type-only dependencies, no unexplained `any`, no suppression directives to silence errors without justification. Validate external HTTP/WebSocket/configuration input at runtime, derive contract types from schemas, and handle nullable/optional values explicitly. No non-null assertions as a substitute for validation. Prefer explicit public API types, small focused modules, named exports, PascalCase React components, camelCase functions/variables, and descriptive names. Avoid unrelated refactors and whole-repo formatting churn.
- Formatting defaults: two spaces, single quotes, semicolons, trailing commas where supported, 100-character print width. Let the formatter resolve layout rather than hand-maintaining it.
- Conventional Commit messages: `type(scope): short imperative summary`, e.g. `feat(board): add backlog task creation`, `fix(worker): preserve repository on retry`, `docs(api): describe worker registration`. Suggested scopes: board, api, worker, contracts, repo. Use feat/fix/docs/test/refactor/chore/build/ci/style/perf types as applicable. Keep commits focused; describe material reasons in the body. Never amend or rewrite history without authorization.
- Enforce code/style/type checks through shared configuration and automated checks, and commit-message syntax with commitlint. Local hooks are a convenience, not the sole enforcement mechanism. Remote CI provider is left to the builder once hosting is known; local aggregate checks must work immediately. Protected test changes remain a human approval rule, not something linting can grant permission for.

First freeze shared contracts, field rules, enum values, error shapes and sample fixtures. Then three tracks can proceed independently:

1. Board against mocked contract responses.
2. API against simulated Worker connection.
3. Worker against an API protocol test harness.

Integrate with a local smoke flow: start API and Worker, confirm worker registration plus Vladi in list, create both project modes, create/select version, create task in Backlog, assign/type/prioritize, drag through all columns, verify field locks, return Done to Backlog and edit. Restart services and confirm persisted data and worker identity.

Meaningful checks cover API editing rules and invalid transitions/patches, revision conflicts, protocol validation, duplicate command handling, offline/reconnect behavior, path confinement and refusal to modify existing directories. Worker repository tests use temporary directories. Board checks cover drag/drop rollback and edit availability. Verify keyboard move control and empty/error states.

## Constraints and anti-goals

No agent is launched by assigning or moving a task. No external messages, remote repo creation, cloning, publishing or deployment. No replacement of existing local repositories. No Redis, broker, microservice platform or extra backend in the Board. No need to install Claude/Codex SDKs until their integration is in scope.

Exact dependency versions, internal module structure, schema library, logging/test tooling, message timeouts and heartbeat intervals are builder decisions documented in the plan. Any product-changing unresolved questions must be settled before implementation.

## Design review

A fresh builder review identified two consequential setup questions: repository layout and operating environment. Both are now answered by the user: one repository with three applications and shared contracts, all running in WSL. User subsequently approved the design and repository conventions, explicitly removing mandatory TDD and requiring permission to modify existing tests.

This document is saved in the current workspace. The workspace is not yet an initialized Git repository, so the design is not committed; initialize the agreed repository and commit the approved design during the authorized setup phase.
