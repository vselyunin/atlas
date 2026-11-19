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

## Review and test permissions

Implementation was reviewed by the implementing agent. An independent agent
review was attempted but unavailable because the service usage limit was reached.

The user explicitly approved these changes to existing tests and test helpers:

- Board interaction tests: replace element casts with typed queries; preserve
  assertions and behavior.
- Browser startup helper: wait for the API and Worker, clean up child processes
  and temporary state, and format the file.
- Worker replay test: check that the temporary server has a TCP address before
  reading its port; preserve assertions and behavior.

Other tests were added as new files. Mandatory TDD is not enabled. The root and
per-app instructions preserve the requirement to ask before changing tests.
