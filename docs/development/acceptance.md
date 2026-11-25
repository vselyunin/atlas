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
| Agent edits and commits in its worktree with `git add -A`            | Passed with a defect, fixed afterwards; passed in the re-check on 2026-11-25, see below. |
| Agent cannot write `/tmp/outside.txt`                                | Passed: `Read-only file system`; the file exists neither in the container nor in WSL.    |
| Stop ends the session                                                | Passed: the Board shows the session ended and no agent process is left in the container. |

The commit check found a defect. Claude creates `.claude` in the worktree, the sandbox then
adds the placeholders `.claude/agents` and `.claude/commands`, and `git add -A` committed both
as empty files next to `NOTES.md`. Both paths were added to the agent's Git excludes file. The
fix is covered by a Worker test and was confirmed in the re-check below.

The folder-trust question and the permission-bypass warning are asked again in every new
session for the same worktree.

### Re-check on 2026-11-25

After the placeholder, Git link and object folder fixes, one session was run again with a real
logged-in Claude on the merged code, with `pnpm dev` and a freshly built Worker image. The user
answered the folder-trust question and the permission-bypass warning; the coordinating agent
started and stopped the session on the Board and checked the results from WSL.

| Check                                                             | Result                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Session starts with the sandbox on                                | Passed.                                                                                       |
| Agent commits with `git add -A`                                   | Passed: the commit holds only `RECHECK.md`, with no `.claude` placeholders.                   |
| The commit is usable in the project folder while the session runs | Passed: the task branch shows the commit there and `git fsck --strict` reports nothing.       |
| The agent's objects are in its own folder                         | Passed: the folder was empty before the agent ran and held three objects after the commit.    |
| The worktree's Git links are unchanged                            | Passed: `commondir`, `gitdir` and `.git` hold their original values.                          |
| Agent cannot write `/tmp/outside.txt`                             | Passed: `Read-only file system`; the file exists neither in the container nor in WSL.         |
| Stop ends the session                                             | Passed: exit code 0 on the Board, no agent or sandbox process left, the commit still present. |

One observation is not a failure of these checks. The sandbox leaves eleven empty read-only
placeholders in the worktree, such as `.bashrc`, `.gitconfig`, `.mcp.json` and `.idea`. The
agent's `git add -A` did not commit them, but Git run in the worktree from WSL lists them as
untracked, so a commit made there outside the sandbox would include them.

Codex was not checked under the sandbox and is unverified.

### Manual checks with real GitHub: sign-in and setup

Status: not yet run. The automated tests for sign-in and setup use a local stand-in for GitHub
and never reach github.com, so only these steps cover the real service. They need a GitHub
account that may create Apps and one test repository. Steps 8 to 10 need a second GitHub
account, and for them to work the App must be owned by an organization, created by choosing that
organization on the setup page, with the second account a member of it. GitHub is expected, but
was not tested, to refuse a second account on a personal App before Atlas sees it. With a
personal App, record "GitHub refused the account" as the outcome of step 8 and skip steps 9 and 10. Use a fresh database, for example by starting with an unused `ATLAS_DB_PATH` and
`ATLAS_GITHUB_APP_FILE`. Do not write down the owner code, the App file's content or any token.

1. Run `pnpm dev:web` and open <http://localhost:5173>. Expected: only the setup page shows, with
   the three "one account" rules.
2. Choose "Create the GitHub App". Expected: GitHub shows a name like `Atlas-xxxxxx` and asks you
   to confirm. Confirm.
3. Expected: the Board shows "Install and sign in" with the App's name and your account. On
   GitHub, open the App's settings and check: three rights (Contents, Pull requests, Metadata),
   no Workflows, no webhook, no events, not public.
4. Choose "Install the App on GitHub" and select only the test repository. Expected: GitHub
   returns to the Board.
5. Choose "Sign in with GitHub". Expected: you are signed in as the owner; your avatar
   shows in the header, and your name in the user menu.
6. Open Settings from the user menu. Expected: the App's name and owning account, and a member list with only you.
7. Reload the page. Expected: still signed in. Sign out from the user menu. Expected: the sign-in
   page shows.
8. Sign in with the second account. Expected: the Board says that account has no access and
   names it. With a personal App, GitHub may refuse the account first; record that and skip
   steps 9 and 10.
9. Sign in as the owner, add the second account's login in Settings, then sign in with the
   second account in another browser. Expected: it gets in, and has no member list or setup
   rights.
10. As the owner, remove that member. Expected: the second browser returns to the sign-in page
    on its next request; an open terminal in it closes. Sign in with the second account again.
    Expected: no access.
11. Restart the API with `ATLAS_AUTH=off`. Expected: no sign-in, and a permanent "Sign-in is off"
    notice on the Board. Restart with sign-in on again. Expected: the sign-in page.
12. Stop Atlas, delete the App file and the App on GitHub, and start again. Expected: the setup
    page returns; the owner stays signed in and can create a new App. After that the Board goes
    straight to the app with no install step; choose repositories from Settings ("Choose
    repositories").
13. Start again from a fresh database and App file. Create the App and install it, but do not
    sign in. Restart the API and read the owner code from its output. In a different browser,
    enter it on the setup page, then sign in. Expected: that browser becomes the owner. Without
    the code, signing in from that browser is refused.

### Manual checks with real GitHub: linking, cloning and credentials

Status: not yet run. The automated tests for linking, cloning and credentials use a local
stand-in for GitHub and a local stand-in Git server and never reach github.com, so only these
steps cover the real service. Do the sign-in and setup checks above first: the App must exist,
and you must be signed in as the owner. You need one private repository the App is installed on,
one more repository it is not installed on, and `pnpm dev` with the Worker online (the Worker
image builds with Git 2.39 and clones over HTTPS). Do not write down any token, the owner code or
the App file's content.

1. Run `pnpm dev`. In Settings, choose "Choose repositories" and select only the private test
   repository. Expected: GitHub returns to the Board.
2. Create a project with "New local repository", wait until it is ready, select it and open
   Settings. In the repository section choose the test repository and "Link". Expected: the
   repository's name and default branch show, with no "not accessible" message.
3. Reload. Expected: the link is still there. Choose "Unlink". Expected: the link is gone. Link
   again.
4. On GitHub, remove the repository from the App's selection and reload the Board. Expected: the
   link shows "not accessible". Select the repository again. Expected: the message goes.
5. Create a project with "Clone from GitHub", the test repository, the online Worker and a new
   folder name. Expected: "Cloning your repository" shows, then the project becomes ready with a
   task board. In WSL, in the new folder: `git log --oneline` shows the repository's history,
   `git branch -a` shows its branches with the default one checked out, and
   `git remote -v` shows an address without any credential (no `x-access-token`, no token).
6. In the same folder run `grep -r x-access-token .git; git config --list --show-origin`.
   Expected: no token anywhere in `.git` or the configuration.
7. Start a session on the cloned project and run, from the agent's terminal or a shell in the
   worktree, `env`. Expected: no token and no `ATLAS_*` variable.
8. Try the same create with a repository the App is not installed on (use its ID with the API, or
   remove it from the App's selection after the Board listed it). Expected: refused with
   `repository_not_accessible` and no project appears.
9. On GitHub, open the App's settings and its installation. Expected: the App has Contents (read
   and write), Pull requests (read and write) and Metadata (read) and nothing else; no
   Workflows; no webhook; no events; the installation is limited to the repositories you
   chose. Atlas asks for each clone a token that is limited to one repository and to Contents
   read; GitHub does not show these tokens, so this part is covered by the stand-in tests, and
   the API log line (`Granted a repository credential`) shows the rights `contents:read`.
10. Sign in with a second GitHub account that is not the owner and not a member, in another
    browser. Expected: refused, as in the sign-in checks. As the owner, add it as a member, sign
    in with it and clone a repository. Expected: the clone works, because every signed-in person
    can clone every repository the App can access. Remove the member again.
11. Stop the Worker container (`docker stop atlas-worker`) while a clone of a large repository
    runs. Expected: the project ends "needs attention" and its folder stays; start `pnpm dev`
    again and check the folder before you reuse its name.
12. Time limit for task worktrees: with a real, large repository cloned onto the workspace (on a
    Windows drive, as in this checkout), create a task, move it to Working and start a session.
    Expected: the worktree is created and the session starts. If the Board reports that creating
    the worktree took too long, the 30-second limit in `apps/worker/src/sessions/worktree.ts`
    needs raising; record the repository's size and the time it took.

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
still runs. The change was run with a real logged-in Claude in the re-check of 2026-11-25.

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
