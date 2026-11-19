# Atlas Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. User overrides mandatory TDD. Existing tests require permission to change.

**Goal:** Build the four-column board with project/version selection and enforced editing affordances.

**Architecture:** React browser app calls API over HTTP, using TanStack Query and shared schemas. Develop with contract-valid mock HTTP responses while API is built independently.

**Tech Stack:** TypeScript, React/Vite, Tailwind/shadcn/ui, TanStack Query, dnd-kit, Vitest/Testing Library, MSW, Playwright during integration.

**Spec:** `docs/superpowers/specs/2026-11-19-atlas-local-mvp-design.md`; exact DTO/routes in sibling `2026-11-19-atlas-foundation-and-integration.md`.

## Global Constraints

- No Board backend, database access, Worker token or direct Worker connection.
- Only Backlog permits task creation. Field locks follow spec; moves remain available for Done.
- Existing tests require permission to change or bypass; no mandatory TDD.
- No worker management UI, agent execution, terminal, deletion, comments or hierarchy.
- Shared styling/TS rules apply; do not edit root config/contracts independently of coordinator.

## Review Focus

1. Project/version switching during fetch cannot show previous selection's tasks (task 1).
2. No worker online must disable local-repository creation without blocking existing URL mode (task 2).
3. Failed drag must restore server state with actionable message (task 3).
4. Done remains movable but its description must be locked (task 3).
5. A lost creation response must not automatically create a duplicate project (task 2).

## Task 1: Board shell, HTTP client and scoped selection

**Files:** `apps/board/src/{main,App}.tsx`, `src/styles.css`, `src/lib/{api,queries}.ts`, `src/features/board/{BoardPage,TaskColumn,TaskCard}.tsx`, `src/features/projects/ProjectVersionSelector.tsx`, `src/mocks/{browser,handlers}.ts`, `tests/selection.test.tsx`, `vite.config.ts`, `.env.example`.

**Interfaces:** `request<T>(path:string,responseSchema:ZodType<T>,options?:RequestInit):Promise<T>` validates responses and throws structured `ApiError`; query keys `['projects']`, `['versions',projectId]`, `['tasks',projectId,versionId]`, `['workers']`, `['operation',id]`. Expose `useProjects`, `useVersions(projectId)`, `useTasks(projectId,versionId)`, `useWorkers` from queries.

- [ ] Configure React/Vite, Tailwind and required shadcn controls with accessible labels/focus. Bind loopback; proxy `/api` to local API. Mock mode is explicit dev-only configuration and shows a sample-data label; it is never an automatic fallback when real API fails.
- [ ] Implement response-validated client with fetch cancellation, readable errors, no automatic mutation retries and correct query keys. Poll workers every 10 seconds and while local creation form is open. On project switch reset version, cancel irrelevant fetches and disable task query until version resolved. Default to first ready project's `v0.1`/first available version; preserve selection while still valid.
- [ ] Build top selectors and four columns in order with counts. Cards display title, type, priority, assignee, and offline indication where relevant. Use no user HTML rendering. Loading, empty and error states must remain distinguishable. At small widths allow horizontal columns without making controls unreachable.
- [ ] Add MSW fixtures from shared schemas and selection tests. Assert a late response for project A cannot populate project B; empty ready project shows Backlog add action; pending project shows provisioning status instead of editable board; API outage does not switch to sample data.
- [ ] Run Board tests/typecheck/lint/build and preview layout. Commit `feat(board): add project version board shell`.

## Task 2: Project, version and Backlog task creation

**Files:** `apps/board/src/features/projects/{CreateProjectDialog,ProjectProvisioning,CreateVersionDialog}.tsx`, `src/features/tasks/{CreateTaskDialog,WorkerSelect}.tsx`, `tests/creation.test.tsx`.

**Interfaces:** Forms submit frozen create DTOs through HTTP client. `WorkerSelect` receives API Worker DTOs; local project form filters online Atlas workers advertising `repository.init`, task form allows known workers including offline plus Unassigned.

- [ ] Add project form with required name and explicit Existing Git URL/New local repository modes. Local mode shows configured worker root, validates relative path and displays resolved target. Preselect sole eligible worker; handle none online. Existing mode makes no clone promise. Disable submit while request in flight.
- [ ] For local 202 response poll operation every second while pending/accepted; show disconnected/reconnecting, failed or needs-attention states accurately. Refetch project/versions on success. Never automatically resubmit creation POST after network error; refresh projects and explain outcome may be unknown. Stop polling terminal outcomes and when view unmounts.
- [ ] Add version dialog for ready project. Add task entry point only in Backlog, with title, description, type, priority and worker; defaults Task/Medium/Unassigned. Submit to selected project/version and refresh relevant list. Disable duplicates while pending; preserve unsaved form on validation/network failure.
- [ ] Add UI tests covering modes, worker filtering, no online worker, defaults, missing title, operation states, duplicate-submit prevention and ambiguous network outcome. Assert a 202 does not immediately show a ready board; type/priority are independent controls; other columns have no add-task action.
- [ ] Run full Board tests/typecheck/lint/build; commit `feat(board): create projects versions and backlog tasks`.

## Task 3: Task details, moves and field restrictions

**Files:** `apps/board/src/features/tasks/TaskDetails.tsx`, `src/features/tasks/task-edit-policy.ts`, `src/features/board/useTaskMove.ts`, `src/features/board/BoardDnd.tsx`, `tests/{task-details,movement}.test.tsx`.

**Interfaces:** `editableFields(status:TaskStatus):ReadonlySet<keyof TaskChanges>` returns Backlog editable fields, description-only for todo/working, empty for done. `moveTask(task:Task,status:TaskStatus,beforeTaskId:string|null):Promise<void>` sends stored revision and invalidates scoped task queries. API remains authoritative.

- [ ] Build side panel with title, description, type, priority, worker, version and a separate status control. Project is fixed. Fields visibly disabled/read-only by status; description editable everywhere except Done. Display errors and preserve unsaved draft on conflict while refreshing authoritative state; never silently resubmit stale patch.
- [ ] Add pointer and keyboard drag/drop between and within columns using maintained dnd-kit APIs selected during setup. Determine destination anchor from visible order; null appends. Optimistic updates snapshot the affected query and roll back/refetch on failure. Serialize moves per board while pending to avoid optimistic rollback overwriting another move; announce state changes accessibly. Status selector is a keyboard alternative that appends to target column.
- [ ] Handle task version changes: only Backlog, same-project versions, invalidate both lists and close panel when task leaves active version. Returning Done to Backlog unlocks fields after confirmed server transition. Never combine move with forbidden patch fields.
- [ ] Add interaction tests for each status's editable controls, Done description lock plus available move, successful Done→Backlog unlock, optimistic move failure rollback, same-column ordering and stale-edit conflict. Assert moving does not send an agent-start request. Use browser acceptance for actual pointer drag mechanics during integration; avoid relying solely on mocked drag callbacks.
- [ ] Run Board suite/typecheck/lint/build. Preview updated layout against the old exploratory mockup, checking creation buttons, types/priorities, forms and field locks. Commit `feat(board): edit tasks and move cards safely`.
