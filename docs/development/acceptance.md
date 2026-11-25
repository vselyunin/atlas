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

At the time of writing `pnpm check` runs 60 contract, 111 Worker, 28 API and 41 Board
tests, plus 10 integration tests. They cover, with a stand-in agent and the sandbox off:

- session message schemas and limits, and the two accepted capability lists;
- Worker sessions and worktrees with real Git and a real PTY, the sandbox settings and
  agent arguments, required mode refusing to start without the sandbox, off mode running
  unwrapped, the Worker lock, the seccomp profile and the Worker configuration;
- the agent's own Git object folder and the Worker's copy into the project's object store,
  including refused forged objects and a commit usable in the project folder at session exit;
- the API session hub and socket, and the Board session section and terminal;
- API and Worker together through the Board socket: start, output, input, reattach,
  stop and reattach after an API restart.

`pnpm test:docker` is a separate group of 6 tests. It needs Docker, no agent login, and is
not part of `pnpm check`. It builds the image and registers the containerized Worker, runs
a stand-in agent through the Board socket with the sandbox required, checks what the
sandboxed agent can and cannot write, read and reach (the project's Git object store is among
the refused writes), checks that `git add -A` works and that the commit passes `git fsck` in
the project folder, and
checks that the default seccomp profile makes a required-mode session fail with no agent
started. The coordinating agent ran the group after the last change and all 6 passed. Its
stand-in agent does not create `.claude`, so it does not cover the two placeholders found in
the manual check below.

### Manual checks with a real logged-in Claude

The checks began on 2026-11-23, with `pnpm dev` and the login in the `atlas-agent-home` volume.

| Check                                                                | Result                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Session starts in the container and shows "Atlas: agent sandbox on…" | Passed, after a fix: Claude first exited with a read-only error creating `/tmp/claude`.  |
| Folder-trust question appears and can be answered on the Board       | Passed.                                                                                  |
| Permission-bypass warning appears on the Board                       | Passed. The user approved accepting it; the agent then started the task.                 |
| Agent edits and commits in its worktree with `git add -A`            | Passed with a defect, fixed afterwards and not re-run with real Claude; see below.       |
| Agent cannot write `/tmp/outside.txt`                                | Passed: `Read-only file system`; the file exists neither in the container nor in WSL.    |
| Stop ends the session                                                | Passed: the Board shows the session ended and no agent process is left in the container. |

The commit check found a defect. Claude creates `.claude` in the worktree, the sandbox then
adds the placeholders `.claude/agents` and `.claude/commands`, and `git add -A` committed both
as empty files next to `NOTES.md`. Both paths were added to the agent's Git excludes file. The
fix is covered by a Worker test; the real-Claude check was not repeated after it.

The folder-trust question and the permission-bypass warning are asked again in every new
session for the same worktree.

Codex was not checked under the sandbox and is unverified.

## Review and test permissions

The container and sandbox work was split into 11 tasks. Tasks 1 to 10 each had an independent
task review by a separate reviewer agent, covering spec compliance and quality; Tasks 4, 7, 9
and 10 needed fix rounds, each followed by a scoped re-review. The Task 11 documentation was
reviewed independently after it was first committed and corrected in a follow-up commit. The
implementers' own checks were self-review. An independent whole-branch review then found no
critical and six important issues. Five were fixed and independently re-reviewed; for the
Worker lock that meant documenting the limit, not removing it. The sixth was the unfinished
real-Claude checks above. The placeholder fix that followed those checks was self-reviewed
only. Twelve minor findings from that review remain open.

A second independent review, of the whole pull request, found one critical issue: a sandboxed
agent could redirect its worktree's Git links so that Git run there on the host executed the
agent's commands. The fix was independently re-reviewed, which confirmed the reported route
closed and added two important findings, both about limits that are now documented and not
removed: other writable Git state in the worktree, and the writable shared object store. Its
smaller findings on the fix were applied and those last changes were self-reviewed only. Ten
minor findings from the pull request review remain open.

The writable shared object store was then removed: each agent writes Git objects to a folder
of its own and the Worker copies them into the project's store. One independent reviewer
attacked the change with real Git, including hand-built packs, and confirmed that changed
content cannot arrive under another object's name. It found no critical and three important
issues: the Worker could be stalled through the task branch file, a session's exit could be
lost while its last commits were copied, and the Worker's Git reads agent-written packs
outside the sandbox. The first two were fixed and the third reduced and documented; these
fixes were self-reviewed only. The reviewer did not check the real sandbox or the Docker
tests; the coordinating agent ran those. Not done from its minor findings: a size limit on
copied objects, a forged-pack test in the suite, and showing a failed copy while the session
still runs. The change was not run with a real logged-in Claude.

Earlier work was reviewed by the
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
