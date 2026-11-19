# Atlas Foundation and Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. User requests parallel app development. User explicitly removed mandatory TDD; do not reintroduce it through skill defaults. Existing tests require permission to change.

**Goal:** Establish shared instructions, tooling and contracts, then integrate three independently developed local apps.

**Architecture:** One pnpm workspace contains `apps/board`, `apps/api`, `apps/worker`, and `packages/contracts`. Freeze contracts before parallel app work; coordinate changes to shared files centrally.

**Tech Stack:** TypeScript, Node.js LTS, pnpm, React/Vite, Fastify, SQLite/Drizzle, Zod, WebSockets, ESLint, Prettier, commitlint, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-atlas-local-mvp-design.md`

## Global Constraints

- Run all three apps in WSL; open the board in the Windows browser.
- Existing tests must not be modified without explicit user permission. This includes deletions, skips, assertions, snapshots, expected fixtures, and bypassing checks through configuration.
- No TDD requirement. Add meaningful tests; do not require tests for documentation or pure configuration.
- Only API owns application SQLite; only Worker performs repository operations. Assignment never launches work.
- HTTP for Board operations; Worker initiates persistent WebSocket to API.
- All application code uses TypeScript. Strict mode, ESM, shared runtime schemas, protected existing tests.
- No agent execution, terminals, SDK installation, cloning, publishing or remote repository creation.

## Review Focus

1. An automated formatting command must not rewrite existing tests: foundation task 1 verifies write targets.
2. API restart must not leave stale workers online or repeat repository creation: integration task 4 exercises restarts.
3. A browser request from an unrelated origin must not mutate local state: API task 1 verifies server rejection.
4. Changing project while requests are in flight must not show another project's tasks: Board task 1 covers cache keys.
5. Worker crash after folder creation must never authorize deleting/reinitializing that folder: Worker task 2 covers recovery.

## Execution order and ownership

1. Complete foundation tasks 1–2; review/freeze contract examples.
2. Run the Board, API, Worker plans in parallel. Each owner edits only its app. One coordinator owns lockfile/root configuration/contracts. App dependency requests go through that coordinator.
3. Complete integration tasks 3–4 and a whole-change review.

Companion plans: `2026-11-19-atlas-board.md`, `2026-11-19-atlas-api.md`, `2026-11-19-atlas-worker.md` in this directory. Shared interfaces in this document are normative for all three.

## Task 1: Workspace, instructions and enforceable conventions

**Files:** root `AGENTS.md`, `README.md`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`, `.nvmrc`, `tsconfig.base.json`, `eslint.config.mjs`, `prettier.config.mjs`, `commitlint.config.mjs`; `scripts/format.mjs`, `scripts/check-commits.mjs`; `docs/development/conventions.md`; `apps/{board,api,worker}/AGENTS.md`; `packages/contracts/AGENTS.md`; per-package manifests and TypeScript configurations.

**Interfaces:** package names `@atlas/board`, `@atlas/api`, `@atlas/worker`, `@atlas/contracts`. Root commands `dev`, `lint`, `format`, `format:check`, `typecheck`, `test`, `build`, `check`, `check:commits`. `check` runs lint, formatting check, typecheck, tests, build; `check:commits -- <base>` checks the specified Git range.

- [ ] Inspect existing instructions, Git state, Node/pnpm/Git availability before setup. Initialize the agreed repo without overwriting existing `.git` metadata. If access is denied, request the specific required filesystem approval; do not delete/recreate metadata. Ignore local database files, worker journals, `.env`, build outputs and `.superpowers/` previews. Preserve and commit the approved design/plans.
- [ ] Select a currently supported Node LTS compatible with all dependencies, pin its major in `.nvmrc`/engines, pin pnpm in `packageManager`, and record exact dependency versions in the lockfile. Verify official package documentation when choosing versions; do not blindly install newest majors. Use ordinary pnpm workspace tooling, without Turborepo/Nx.
- [ ] Write root instructions explaining app communication, ownership, review gates, command usage, protected tests and no TDD requirement. Per-app instructions describe only local responsibilities; contracts instructions prohibit database/framework imports and undocumented protocol changes. `docs/development/conventions.md` holds TS naming/style and commit examples.
- [ ] Set ESLint type-aware rules and Prettier defaults from the spec. Set strict TypeScript plus `noUncheckedIndexedAccess`; use browser/Node-specific child configs. Configure Conventional Commit scopes `board|api|worker|contracts|repo` and types from the spec. Local hooks may call read-only checks but never auto-rewrite tests.
- [ ] Implement formatting so default write targets exclude all test/spec files, test directories, snapshots and fixtures. Keep those paths in read-only lint/format checks. No default `eslint --fix` across the repository. Run the write-target listing/dry-run and inspect it before using write mode. Approvals for test fixes must name the affected files and changes.
- [ ] Verify `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm build` after package setup. Scaffold-only packages may have no tests yet, but do not configure test passes to conceal later missing tests. Verify commitlint accepts `feat(board): add task creation` and rejects `stuff` via explicit stdin checks. Commit as `chore(repo): establish workspace conventions`.

## Task 2: Shared contracts and fixtures

**Files:** `packages/contracts/src/{common,projects,versions,workers,tasks,http,protocol,index}.ts`, `packages/contracts/src/fixtures.ts`, `packages/contracts/tests/{schemas,protocol}.test.ts`; `docs/development/protocol.md`.

**Interfaces:** export all schemas and inferred DTO types described below from `@atlas/contracts`; no generated duplicate interfaces. Zod strict objects reject unknown keys. Common `parse` errors map to API errors rather than leaking stack traces. Fixture factories produce deterministic valid DTOs; protect test fixtures once created.

Export naming: entity schemas `TaskSchema`, `VersionSchema`, `ProjectSchema`, `WorkerSchema`, `OperationSchema`; inputs `ProjectCreateSchema`, `TaskCreateSchema`, `TaskPatchSchema`, `TaskMoveSchema` with inferred `ProjectCreate`, `TaskCreate`, `TaskPatch`, `TaskMove`. `TaskChanges` is the inferred patch `changes` type. Export strict schemas for each route's response envelope as well. Protocol exports `WorkerToApiMessageSchema`, `ApiToWorkerMessageSchema`, their inferred union types, `RepositoryInitCommand` (the `command.dispatch` envelope), `CommandResult` (the `command.result` envelope), and `CommandOutcome` (its payload). Each app owns its internal config/service interfaces; these are not shared DTOs.

- [ ] Implement runtime schemas and inferred types for the frozen contract below. Schema limits: trimmed names/titles 1–200 characters, description 0–100,000 characters, relative path 1–1,024 characters, maximum WebSocket frame 256 KiB. Task patch must contain at least one change. Timestamps are UTC ISO strings; ids are nonempty opaque strings.
- [ ] Document HTTP examples, error handling and all WebSocket variants. Include revision rules, version `1`, terminal-result acknowledgment, and command recovery semantics. These are contracts, not an agent-terminal implementation.
- [ ] Add schema tests for defaults, unknown/forbidden keys, invalid enums, missing revision, mismatched message payloads and unsupported protocol version. Core assertions: `TaskCreateSchema.parse({title:'Example'}).type === 'task'`; priority is `medium`; `safeParse({...validCreate,status:'done'}).success === false`; `safeParse({...validEnvelope,protocolVersion:2}).success === false`.
- [ ] Run `pnpm --filter @atlas/contracts test`, `pnpm typecheck`, `pnpm build`. Expected: all pass, declarations importable in both browser and Node apps without server-only dependencies. Commit as `feat(contracts): define board and worker protocol`.

### Frozen data contract

All lists return `{items: T[]}`. Error shape: `{error:{code:string,message:string,details?:unknown}}`; details must be schema-checked before display, never treated as trusted HTML. HTTP statuses: 400 invalid input, 403 forbidden state/origin, 404 unknown entity, 409 revision/conflicting state, 503 worker unavailable. Responses always JSON except WebSocket upgrade.

- `TaskStatus = 'backlog'|'todo'|'working'|'done'` with UI labels Backlog/To do/Working/Done.
- `TaskType = 'epic'|'story'|'task'|'bug'`; `Priority = 'low'|'medium'|'high'|'urgent'`.
- `Task = {id,projectId,versionId,title,description,status,type,priority,assigneeId:string|null,position:number,revision:number,createdAt,updatedAt}`. Revision begins at 1; position is a zero-based integer within project/version/status.
- `Version = {id,projectId,name,createdAt}`. Project versions have unique trimmed, case-sensitive names; duplicates return 409.
- `Project = {id,name,repository,state,operationId:string|null,createdAt,updatedAt}`; `state = 'pending'|'ready'|'failed'|'needs_attention'`.
- `Repository = {mode:'existing',gitUrl:string} | {mode:'local',workerId,relativePath,localPath:string|null}`. Accept HTTPS, SSH and conventional `git@host:path` URLs syntactically, without network access. No token/password URL credentials; username-only SSH is allowed.
- `Worker = {id,name,kind:'human'|'atlas',availability:'online'|'offline'|'not_applicable',lastSeenAt:string|null,workspaceRoot:string|null,capabilities:string[]}`. Human id is `human:vladi`, name `Vladi`, no workspace/capabilities. Atlas id comes from configuration.
- `Operation = {id,projectId,workerId,state:'pending'|'accepted'|'succeeded'|'failed'|'needs_attention',connectionLost:boolean,result:{localPath:string}|null,error:{code,message}|null,createdAt,updatedAt}`. A transport interruption is not an execution failure.

### Frozen HTTP contract

Base `/api/v1`; API default port 4310, Board default port 5173.

| Method/path | Input | Successful response |
|---|---|---|
| GET `/projects` | none | `{items:Project[]}` |
| GET `/projects/:projectId` | none | `{project:Project}` |
| POST `/projects` | `{name,repository:{mode:'existing',gitUrl}}` or `{name,repository:{mode:'local',workerId,relativePath}}` | 201 existing / 202 local, `{project:Project,operation:Operation|null}` |
| GET `/projects/:projectId/versions` | none | `{items:Version[]}` |
| POST `/projects/:projectId/versions` | `{name}` | 201 `{version:Version}` |
| GET `/workers` | none | `{items:Worker[]}` |
| GET `/projects/:projectId/versions/:versionId/tasks` | none | `{items:Task[]}` |
| POST `/projects/:projectId/versions/:versionId/tasks` | `{title,description?:string,type?:TaskType,priority?:Priority,assigneeId?:string|null}` | 201 `{task:Task}` |
| PATCH `/tasks/:taskId` | `{expectedRevision:number,changes:{title?,description?,type?,priority?,assigneeId?,versionId?}}` | `{task:Task}` |
| POST `/tasks/:taskId/move` | `{expectedRevision:number,status:TaskStatus,beforeTaskId:string|null}` | `{task:Task}` |
| GET `/operations/:operationId` | none | `{operation:Operation}` |

`beforeTaskId:null` appends to the destination column. Anchor must belong to the task's current project/version and destination status; reject stale/missing anchors with 409. A self-anchor is a no-op after checking revision. API serializes moves transactionally, compacts source/destination positions, and increments revisions for changed tasks. Same-column no-op does not need a revision change. UI refetches affected task lists after mutations. Moving versions appends to that version's Backlog. Project association never changes. Project creation POST is never automatically retried by clients; lost response triggers a project-list refresh before offering a new attempt.

### Frozen WebSocket contract

Endpoint `/api/v1/workers/connect`. Worker provides `Authorization: Bearer <ATLAS_WORKER_TOKEN>` during upgrade, not in URL. API rejects browser-origin upgrades. Envelope: `{protocolVersion:1,messageId:string,type:string,commandId?:string,payload:object}`.

| Direction | Type | Payload / constraints |
|---|---|---|
| Worker → API | `worker.register` | `{workerId,name,workspaceRoot,capabilities:['repository.init']}`; first message |
| API → Worker | `worker.registered` | `{workerId,heartbeatIntervalMs:10000}` |
| Worker → API | `worker.heartbeat` | `{workerId}` |
| API → Worker | `command.dispatch` | `{kind:'repository.init',projectId,relativePath}`; commandId required |
| Worker → API | `command.accepted` | `{}`; commandId required |
| Worker → API | `command.result` | `{status:'succeeded',localPath}` or `{status:'failed'|'needs_attention',error:{code,message}}`; commandId required |
| API → Worker | `command.result_ack` | `{}`; commandId required; sent only after durable result persistence |
| Either | `protocol.error` | `{code,message}`; never marks an unrelated command failed |

Register within 5 seconds; heartbeat stale after 30 seconds. Reconnect with jittered exponential delay from 500 ms to 30 seconds. Duplicate live worker id is rejected; human id cannot register as Atlas. API accepts command results only from the assigned worker; duplicate identical results are acknowledged, conflicting results rejected. Worker journals results until acknowledged and replays them after registration. API redispatches unresolved commands with their original ids after reconnect. Delivery is at least once with deduplication; do not claim exactly-once execution across arbitrary filesystem crashes.

## Task 3: Integrated startup and user documentation

**Files:** `scripts/dev.mjs`, root `README.md`, `.env.example`, `docs/development/local-setup.md`; coordinated app config changes only as necessary.

**Interfaces:** `pnpm dev` launches all three processes; package-specific `pnpm --filter @atlas/<app> dev` also works. API config: port, DB path, worker token, allowed Board origin. Worker config: API WS URL, worker token, stable id, name, workspace root, state directory. Board uses `/api` through Vite's HTTP proxy; no worker token enters browser environment variables.

- [ ] Wire launch sequencing: API applies migrations before listening, Worker reconnects if API is not yet ready, Board displays loading/offline states. Shut down children cleanly on Ctrl+C without erasing stored data. Bind all HTTP listeners to loopback; document localhost forwarding from Windows to WSL.
- [ ] Write setup instructions for required Git/Node/pnpm, copying local environment files, generating a token, configuring a fresh workspace root and starting apps. Secrets/state files remain untracked. Default database and journals live in an ignored `.atlas/` directory; no system-level service installation.
- [ ] Run `pnpm dev` and confirm all three apps start, API lists Vladi plus Worker, and Windows browser reaches the Board. Verify `pnpm build` and production app start commands. Document the exact verified commands and limitations. Commit as `feat(repo): connect local atlas services`.

## Task 4: Whole-system acceptance and review

**Files:** `tests/e2e/atlas.spec.ts`, `tests/integration/reconnect.test.ts`, `playwright.config.ts`, root test script additions, `docs/development/acceptance.md`.

**Interfaces:** `pnpm test:e2e` starts isolated test processes/ports using temporary DB, journal and repository directories. Existing tests stay protected; add new files or request permission for changes.

- [ ] Add browser acceptance tests: create existing-url project; select default/additional version; create Backlog task; assign Vladi/worker and type/priority; move via drag and keyboard control; observe field locks; edit description outside Done; return Done to Backlog and edit. Assert only Backlog exposes creation. Local project flow ends with real `.git` directory, no initial commit/remote, and ready project.
- [ ] Add restart integration test with real API/Worker: initialize repository, interrupt connection before result acknowledgment, reconnect and confirm same operation/project/worker identity and one repository; restart API and confirm workers offline until registered. A disconnected but live Worker finishes its command and resends result. Use bounded event waits, not arbitrary long sleeps.
- [ ] Test no online Worker, failed Git operation, preserved existing target directory, ambiguous recovery, and no automatic project POST retry. Ensure pending/failed states remain visible and never expose a ready task board prematurely.
- [ ] Run `pnpm check`, `pnpm test:e2e`, `pnpm check:commits -- <foundation-base>`. Record actual passing/failing commands, without changing tests to obtain green results. Verify real browser appearance and keyboard flow; no claim of completion from automated tests alone.
- [ ] Perform a fresh whole-change review for spec coverage, contracts, state restrictions, test integrity and path safety. Resolve findings within authorization. Commit as `test(repo): verify atlas mvp end to end`; report what works and any remaining limitations. No push, merge or deployment is part of this plan.
