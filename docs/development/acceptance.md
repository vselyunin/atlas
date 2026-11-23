# MVP acceptance

The local MVP contains the Board, API, Worker and shared contracts. Assignment
records responsibility; it does not start an agent or terminal session.

## Coverage

- Contract tests validate resource shapes and Worker messages.
- API tests cover project/version creation, task rules, ordering, revisions,
  Worker authentication and repository operation results.
- Worker tests cover path confinement, existing folders, command replay,
  recovery, state separation and result acknowledgement.
- Board tests cover task fields and editing restrictions.
- A real API/Worker integration test checks repository creation and reconnect
  after an API restart with persistent data.
- Browser acceptance covers project/version selection, task creation and edits,
  status locks, drag and drop, reload persistence and local Git initialization.
  A second scenario verifies rollback after a rejected move.

Run `pnpm check` and `pnpm test:e2e` as described in the README. Browser tests use
temporary data and separate ports, leaving the personal workspace untouched.

### Worker container and agent sandbox

At the time of writing `pnpm check` runs 60 contract, 81 Worker, 28 API and 41 Board
tests, plus 10 integration tests. They cover, with a stand-in agent and the sandbox off:

- session message schemas and limits, and the two accepted capability lists;
- Worker sessions and worktrees with real Git and a real PTY, the sandbox settings and
  agent arguments, required mode refusing to start without the sandbox, off mode running
  unwrapped, the Worker lock, the seccomp profile and the Worker configuration;
- the API session hub and socket, and the Board session section and terminal;
- API and Worker together through the Board socket: start, output, input, reattach,
  stop and reattach after an API restart.

`pnpm test:docker` is a separate group of 6 tests. It needs Docker, no agent login, and is
not part of `pnpm check`. It builds the image and registers the containerized Worker, runs
a stand-in agent through the Board socket with the sandbox required, checks what the
sandboxed agent can and cannot write, read and reach, checks that `git add -A` works, and
checks that the default seccomp profile makes a required-mode session fail with no agent
started. The Docker group was not run by the author of this document.

### Manual checks with a real logged-in Claude

Run on 2026-11-23 with `pnpm dev` and the login in the `atlas-agent-home` volume.

| Check                                                                | Result (2026-11-23)                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Session starts in the container and shows "Atlas: agent sandbox on…" | Passed, after a fix: Claude first exited with a read-only error creating `/tmp/claude`. |
| Folder-trust question appears and can be answered on the Board       | Passed.                                                                                 |
| Permission-bypass warning appears on the Board                       | Appears; acceptance pending the user.                                                   |
| Agent edits and commits in its worktree with `git add -A`            | not yet run                                                                             |
| Agent cannot write `/tmp/outside.txt`                                | not yet run                                                                             |
| Stop ends the session                                                | not yet run                                                                             |

Codex was not checked under the sandbox and is unverified.

## Review and test permissions

The container and sandbox work was split into 11 tasks. Each task had an independent
task review by a separate reviewer agent, covering spec compliance and quality; Tasks 4,
7, 9 and 10 needed fix rounds. The implementers' own checks were self-review. A
whole-branch review is pending at the time of writing. Earlier work was reviewed by the
implementing agent only; an independent agent review of it was attempted but unavailable
because the service usage limit was reached.

The user explicitly approved these changes to existing tests and test helpers:

- Board interaction tests: replace element casts with typed queries; preserve
  assertions and behavior.
- Browser startup helper: wait for the API and Worker, clean up child processes
  and temporary state, and format the file.
- Worker replay test: check that the temporary server has a TCP address before
  reading its port; preserve assertions and behavior.

Other tests were added as new files. Mandatory TDD is not enabled. The root and
per-app instructions preserve the requirement to ask before changing tests.
